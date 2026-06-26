import { createHash } from 'node:crypto';
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import {
  agentUsageSchema,
  conversationMessageSchema,
  effectiveTenantPolicySchema,
  piSegmentRequestSchema,
  piSegmentResultSchema,
  flowExecutionPlanSchema,
  flowSpecSchema,
  humanTaskCreateRequestSchema,
  toolCommitRequestSchema,
  toolInvokeRequestSchema,
  toolPreviewRequestSchema,
  taskRunSchema,
  type FlowExecutionPlan,
  type FlowExecutionPlanAgent,
  type FlowExecutionPlanTool,
  type AgentRunResult,
  type AgentStepRecord,
  type AgentToolExecutionIdentity,
  type AgentToolResultReference,
  type AgentExecutionPlan,
  type AgentRunRecord,
  type AgentAuthoritativeToolResult,
  type PiContextSnapshotRef,
  type PiSegmentRequest,
  type PiSegmentResult,
  type FlowSpec,
  type HumanTask,
  type ToolCommitResponse,
  type ToolInvokeResponse,
  type ToolPreviewResponse,
  type EffectiveTenantPolicy,
  type EvaluationAggregateResult,
  type EvaluationCase,
  type EvaluationCaseResult,
  type EvaluationComparison,
  type EvaluationExecutionPlan,
  type EvaluationGateDecision,
  type EvaluationRun,
  type EvaluationSubjectSnapshot,
} from '@dar/contracts';
import { ToolGatewayClient } from '@dar/tool-client';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';
import { getToolGatewayUrl, loadConfig, type RuntimeConfig } from '@dar/config';
import {
  AgentContextSnapshotRepository,
  AgentExecutionPlanRepository,
  AgentRunRepository,
  AgentStepRepository,
  AuditEventRepository,
  closeDb,
  ConversationMessageRepository,
  createDb,
  FlowExecutionPlanRepository,
  FlowDefinitionRepository,
  HumanTaskRepository,
  parseDbFlowSnapshotRef,
  TaskRunRepository,
  TenantAgentAdmissionRepository,
  EvaluationCaseRepository,
  EvaluationCaseResultRepository,
  EvaluationComparisonRepository,
  EvaluationComparisonService,
  EvaluationDatasetRepository,
  EvaluationEvidenceCollector,
  EvaluationExecutionPlanRepository,
  EvaluationGatePolicyRepository,
  EvaluationGateService,
  EvaluationRunRepository,
  EvaluationScoringEngine,
  EvaluationSubjectSnapshotRepository,
  type EvaluationEvidenceSnapshot,
  assertCandidateFidelity,
  hashEvaluationSubjectSnapshot,
  stableStringify,
  TenantRuntimePolicyResolver,
  TenantRuntimePolicySnapshotRepository,
  effectivePolicyFromSnapshot,
} from '@dar/db';
import {
  createModelGatewayModel,
  createModelGatewayPiStream,
} from '../agent/model-gateway-pi-stream.js';
import {
  PI_CONTEXT_SCHEMA_VERSION,
  replaceDeferredToolResults,
  restorePiMessages,
  serializePiContext,
} from '../agent/pi-context-codec.js';
import { runPiAgentSegment } from '../agent/pi-agent-adapter.js';

const NON_RETRYABLE_ERROR_CODES = new Set([
  'VALIDATION_FAILED',
  'AUTH_FAILED',
  'POLICY_DENIED',
  'NOT_FOUND',
  'TOOL_ARGUMENT_VALIDATION_FAILED',
  'TOOL_POLICY_DENIED',
  'TOOL_HASH_MISMATCH',
  'TOOL_RISK_MISMATCH',
  'TENANT_POLICY_HASH_MISMATCH',
  'EXECUTION_PLAN_HASH_MISMATCH',
  'AGENT_MODEL_DENIED_BY_TENANT_POLICY',
  'HANDOFF_DENIED_BY_TENANT_POLICY',
  'TOOL_DENIED_BY_TENANT_POLICY',
  'HUMAN_CONFIRMATION_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'PI_SEGMENT_NON_RETRYABLE',
  'CONVERSATION_CONTEXT_HASH_MISMATCH',
  'CONVERSATION_FINALIZATION_CONFLICT',
  'CONVERSATION_MESSAGE_NOT_FOUND',
]);

const sampleFlowSpec: FlowSpec = {
  flow_id: 'sample_flow',
  version: 1,
  name: 'MVP sample flow',
  runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
  steps: [
    { id: 'input_normalize', type: 'activity', activity: 'input.normalize' },
    { id: 'knowledge_search', type: 'tool', tool: 'knowledge.search', tool_version: '1.0.0' },
    { id: 'agent_plan', type: 'agent', agent_id: 'sample_agent', input: { agent_version: 1, text: '${input.text}' } },
    {
      id: 'record_write',
      type: 'tool',
      tool: 'record.write.mock',
      tool_version: '1.0.0',
      risk_level: 'L3',
    },
  ],
};

let processDb: ReturnType<typeof createDb> | undefined;

export function configureActivityDb(db: ReturnType<typeof createDb>): void {
  processDb = db;
}

export async function shutdownActivityResources(): Promise<void> {
  if (processDb) {
    await closeDb(processDb);
    processDb = undefined;
  }
}

function getProcessDb(): ReturnType<typeof createDb> {
  if (!processDb) {
    const config = loadConfig();
    processDb = createDb({ databaseUrl: config.DATABASE_URL });
  }
  return processDb;
}

function createToolGatewayClient(config: RuntimeConfig = loadConfig()): ToolGatewayClient {
  return new ToolGatewayClient({
    baseUrl: getToolGatewayUrl(config),
    serviceIdentity: {
      serviceId: 'runtime-worker',
      ...(config.RUNTIME_WORKER_TOOL_GATEWAY_TOKEN
        ? { token: config.RUNTIME_WORKER_TOOL_GATEWAY_TOKEN }
        : {}),
    },
    defaultHeaders: {
      'accept-language': config.DEFAULT_LOCALE ?? 'zh-CN',
    },
  });
}

function normalizeActualStatus(status: string): string {
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled' || status === 'budget_exceeded') {
    return 'system_error';
  }
  return status;
}

export interface ActivityContext {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id: string;
  request_id: string;
  execution_plan_ref?: string;
  execution_plan_hash?: string;
  execution_context_type?: 'runtime' | 'evaluation';
  evaluation_run_id?: string;
  evaluation_case_id?: string;
  evaluation_execution_plan_ref?: string;
  evaluation_execution_plan_hash?: string;
  tenant_policy_snapshot_ref?: string;
  tenant_policy_hash?: string;
  tenant_admission_id?: string;
}

export interface LoadTenantPolicySnapshotActivityInput extends ActivityContext {
  execution_plan_ref: string;
  execution_plan_hash: string;
  execution_plan_type: 'flow' | 'agent';
}

export interface DeriveTenantPolicySnapshotActivityInput extends ActivityContext {
  parent_snapshot_ref: string;
  target_execution_plan_ref: string;
  target_execution_plan_hash: string;
  target_execution_plan_type: 'flow' | 'agent';
  derivation_type: 'flow_agent_child' | 'workflow_handoff' | 'nested_handoff';
}

export interface CreateHumanTaskActivityInput {
  kind?: 'approval' | 'user_input';
  tool_call_id?: string;
  tool_name?: string;
  assignee?: string;
  candidate_groups?: string[];
  payload?: Record<string, unknown>;
  requested_schema?: Record<string, unknown>;
}

export interface UpdateTaskRunStatusActivityInput extends ActivityContext {
  status: 'running' | 'waiting_human' | 'waiting_user' | 'completed' | 'failed';
  error_code?: string;
  error_message?: string;
}

export interface CreateAgentRunActivityInput extends ActivityContext {
  agent_run_id?: string;
  workflow_run_id?: string;
  execution_plan_ref: string;
  parent_workflow_id?: string;
  execution_mode?: 'answer_only' | 'plan_only' | 'mediated_tool_call';
}

export interface UpdateAgentRunActivityInput {
  agent_run_id: string;
  status?: AgentRunRecord['status'];
  workflow_run_id?: string;
  current_segment_index?: number;
  model_turn_count?: number;
  tool_call_count?: number;
  handoff_count?: number;
  usage?: Partial<ReturnType<typeof agentUsageSchema.parse>>;
  completed?: boolean;
  error_code?: string;
  error_message?: string;
}

export interface PersistToolResultsActivityInput {
  agent_run_id: string;
  previous_context_snapshot_ref: PiContextSnapshotRef;
  tool_results: AgentAuthoritativeToolResult[];
  max_context_bytes: number;
  request_context: ActivityContext;
}

export interface AppendUserInputActivityInput {
  agent_run_id: string;
  previous_context_snapshot_ref: PiContextSnapshotRef;
  human_task_id: string;
  response: Record<string, unknown>;
  responded_by: string;
  max_context_bytes: number;
  request_context: ActivityContext;
}

export interface ConversationContextActivityInput {
  tenant_id: string;
  owner_user_id: string;
  conversation_id: string;
  context_message_ids: string[];
  context_hash: string;
}

export interface ConversationContextActivityResult {
  seed_messages: Array<Record<string, unknown>>;
}

export interface FinalizeConversationTurnActivityInput {
  tenant_id: string;
  assistant_message_id: string;
  task_run_id: string;
  agent_run_id?: string;
  final_text?: string;
  error_code?: string;
  safe_error_message_key?: string;
}

export interface UpdateAgentStepActivityInput {
  stable_step_key: string;
  segment_status?: AgentStepRecord['segment_status'];
  decision_summary?: string;
  proposed_tool_calls?: AgentStepRecord['proposed_tool_calls'];
  authoritative_tool_result_refs?: AgentToolResultReference[];
  tool_result_refs?: AgentToolResultReference[];
  human_task_ids?: string[];
  context_snapshot_before?: PiContextSnapshotRef;
  context_snapshot_after?: PiContextSnapshotRef;
  context_snapshot_ref?: PiContextSnapshotRef;
  handoff_refs?: Array<Record<string, unknown>>;
  output_ref?: string;
  usage?: Partial<ReturnType<typeof agentUsageSchema.parse>>;
  error_code?: string;
  error_message?: string;
}

export interface PiRuntimeConfigActivityResult {
  max_segments_before_continue_as_new: number;
}

export async function normalizeInput(input: unknown): Promise<Record<string, unknown>> {
  return { normalized: true, input };
}

export async function runAgentActivity(
  context: ActivityContext,
  agent: FlowExecutionPlanAgent,
  input: Record<string, unknown>,
): Promise<AgentRunResult> {
  void input;
  throw new Error(
    `runAgentActivity is deprecated; use piDurableAgentWorkflow with agent_execution_plan_ref for ${agent.agent_id}@${agent.agent_version}`,
  );
}

export async function loadAgentExecutionPlanByRefActivity(
  executionPlanRef: string,
  tenantId?: string,
): Promise<AgentExecutionPlan> {
  return classifyActivityFailure('loadAgentExecutionPlanByRefActivity', async () => {
    const plan = await new AgentExecutionPlanRepository(getProcessDb()).getByRef(
      executionPlanRef,
      tenantId ? { tenantId } : {},
    );
    if (!plan) {
      throw ApplicationFailure.nonRetryable(
        `AgentExecutionPlan not found: ${executionPlanRef}`,
        'NOT_FOUND',
      );
    }
    return plan;
  });
}

export async function loadTenantPolicySnapshotActivity(
  input: LoadTenantPolicySnapshotActivityInput,
): Promise<EffectiveTenantPolicy> {
  return classifyActivityFailure('loadTenantPolicySnapshotActivity', async () => {
    if (!input.tenant_policy_snapshot_ref || !input.tenant_policy_hash) {
      throw ApplicationFailure.nonRetryable(
        'Tenant policy snapshot identity is required',
        'POLICY_DENIED',
      );
    }
    const snapshot = await new TenantRuntimePolicySnapshotRepository(getProcessDb()).getByRef(
      input.tenant_policy_snapshot_ref,
      { tenantId: input.tenant_id },
    );
    if (!snapshot) {
      throw ApplicationFailure.nonRetryable('Tenant policy snapshot not found', 'NOT_FOUND');
    }
    if (snapshot.snapshot_hash !== input.tenant_policy_hash) {
      throw ApplicationFailure.nonRetryable(
        'TENANT_POLICY_HASH_MISMATCH',
        'TENANT_POLICY_HASH_MISMATCH',
      );
    }
    if (
      snapshot.execution_plan_ref !== input.execution_plan_ref ||
      snapshot.execution_plan_hash !== input.execution_plan_hash ||
      snapshot.execution_plan_type !== input.execution_plan_type
    ) {
      throw ApplicationFailure.nonRetryable(
        'EXECUTION_PLAN_HASH_MISMATCH',
        'EXECUTION_PLAN_HASH_MISMATCH',
      );
    }
    return effectiveTenantPolicySchema.parse(effectivePolicyFromSnapshot(snapshot));
  });
}

export async function deriveTenantPolicySnapshotActivity(
  input: DeriveTenantPolicySnapshotActivityInput,
): Promise<EffectiveTenantPolicy> {
  return classifyActivityFailure('deriveTenantPolicySnapshotActivity', async () => {
    const result = await new TenantRuntimePolicyResolver(getProcessDb()).deriveForExecutionPlan({
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      parent_snapshot_ref: input.parent_snapshot_ref,
      target_execution_plan_ref: input.target_execution_plan_ref,
      target_execution_plan_hash: input.target_execution_plan_hash,
      target_execution_plan_type: input.target_execution_plan_type,
      derivation_type: input.derivation_type,
      request_id: input.request_id,
    });
    return effectiveTenantPolicySchema.parse(effectivePolicyFromSnapshot(result.snapshot));
  });
}

export async function createAgentRunActivity(
  input: CreateAgentRunActivityInput,
): Promise<AgentRunRecord> {
  return classifyActivityFailure('createAgentRunActivity', async () => {
    const db = getProcessDb();
    const executionPlan = await new AgentExecutionPlanRepository(db).getByRef(
      input.execution_plan_ref,
      {
        tenantId: input.tenant_id,
      },
    );
    if (!executionPlan) {
      throw ApplicationFailure.nonRetryable(
        `AgentExecutionPlan not found: ${input.execution_plan_ref}`,
        'NOT_FOUND',
      );
    }
    const policySnapshot = input.tenant_policy_snapshot_ref
      ? await new TenantRuntimePolicySnapshotRepository(db).getByRef(
          input.tenant_policy_snapshot_ref,
          { tenantId: input.tenant_id },
        )
      : undefined;
    if (input.tenant_policy_snapshot_ref && !policySnapshot) {
      throw ApplicationFailure.nonRetryable('Tenant policy snapshot not found', 'NOT_FOUND');
    }
    if (
      policySnapshot &&
      input.tenant_policy_hash &&
      policySnapshot.snapshot_hash !== input.tenant_policy_hash
    ) {
      throw ApplicationFailure.nonRetryable(
        'TENANT_POLICY_HASH_MISMATCH',
        'TENANT_POLICY_HASH_MISMATCH',
      );
    }
    if (
      policySnapshot &&
      (policySnapshot.execution_plan_ref !== executionPlan.execution_plan_ref ||
        policySnapshot.execution_plan_hash !== executionPlan.execution_plan_hash ||
        policySnapshot.execution_plan_type !== 'agent')
    ) {
      throw ApplicationFailure.nonRetryable(
        'EXECUTION_PLAN_HASH_MISMATCH',
        'EXECUTION_PLAN_HASH_MISMATCH',
      );
    }
    const agentRun = await new AgentRunRepository(db).create({
      ...(input.agent_run_id ? { agentRunId: input.agent_run_id } : {}),
      tenantId: input.tenant_id,
      userId: input.user_id,
      taskRunId: input.task_run_id,
      workflowId: input.workflow_id,
      ...(input.workflow_run_id ? { workflowRunId: input.workflow_run_id } : {}),
      ...(input.parent_workflow_id ? { parentWorkflowId: input.parent_workflow_id } : {}),
      executionMode: input.execution_mode ?? 'mediated_tool_call',
      executionPlan,
      ...(policySnapshot ? { tenantPolicySnapshotRef: policySnapshot.snapshot_ref } : {}),
      ...(policySnapshot ? { tenantPolicyVersion: policySnapshot.source_policy_version } : {}),
      ...(policySnapshot ? { tenantPolicyHash: policySnapshot.snapshot_hash } : {}),
      ...(input.tenant_admission_id ? { tenantAdmissionId: input.tenant_admission_id } : {}),
    });
    if (input.tenant_admission_id) {
      await new TenantAgentAdmissionRepository(db).attachAgentRun(
        input.tenant_admission_id,
        agentRun.agent_run_id,
      );
    }
    const taskRun = await new TaskRunRepository(db).get(input.task_run_id);
    if (
      taskRun
      && taskRun.tenant_id === input.tenant_id
      && taskRun.user_id === input.user_id
      && taskRun.assistant_message_id
    ) {
      await new ConversationMessageRepository(db).linkAgentRun(taskRun.assistant_message_id, {
        tenantId: input.tenant_id,
        agentRunId: agentRun.agent_run_id,
      });
    }
    await new AgentRunRepository(db).update(agentRun.agent_run_id, { status: 'running' });
    return agentRun;
  });
}

export async function loadConversationContextActivity(
  input: ConversationContextActivityInput,
): Promise<ConversationContextActivityResult> {
  return classifyActivityFailure('loadConversationContextActivity', async () => {
    const db = getProcessDb();
    const repository = new ConversationMessageRepository(db);
    const loaded = await Promise.all(
      input.context_message_ids.map(async (messageId) => {
        const message = await repository.get(messageId, {
          tenantId: input.tenant_id,
          ownerUserId: input.owner_user_id,
        });
        if (!message) {
          throw new Error('CONVERSATION_MESSAGE_NOT_FOUND');
        }
        if (message.conversation_id !== input.conversation_id || message.status !== 'completed') {
          throw new Error('CONVERSATION_CONTEXT_HASH_MISMATCH');
        }
        return conversationMessageSchema.parse(message);
      }),
    );
    const ordered = loaded.slice().sort((left, right) => left.sequence_no - right.sequence_no);
    const hash = hashConversationMessages(ordered);
    if (hash !== input.context_hash) {
      throw new Error('CONVERSATION_CONTEXT_HASH_MISMATCH');
    }
    return {
      seed_messages: ordered.map((message) => conversationMessageToPiSeed(message)),
    };
  });
}

export async function updateAgentRunActivity(
  input: UpdateAgentRunActivityInput,
): Promise<AgentRunRecord> {
  return classifyActivityFailure('updateAgentRunActivity', async () => {
    const updated = await new AgentRunRepository(getProcessDb()).update(input.agent_run_id, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.workflow_run_id !== undefined ? { workflowRunId: input.workflow_run_id } : {}),
      ...(input.current_segment_index !== undefined
        ? { currentSegmentIndex: input.current_segment_index }
        : {}),
      ...(input.model_turn_count !== undefined ? { modelTurnCount: input.model_turn_count } : {}),
      ...(input.tool_call_count !== undefined ? { toolCallCount: input.tool_call_count } : {}),
      ...(input.handoff_count !== undefined ? { handoffCount: input.handoff_count } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
      ...(input.error_code !== undefined ? { errorCode: input.error_code } : {}),
      ...(input.error_message !== undefined ? { errorMessage: input.error_message } : {}),
    });
    if (!updated) {
      throw ApplicationFailure.nonRetryable(
        `AgentRun not found: ${input.agent_run_id}`,
        'NOT_FOUND',
      );
    }
    return updated;
  });
}

export async function runPiSegmentActivity(request: PiSegmentRequest): Promise<PiSegmentResult> {
  return classifyActivityFailure('runPiSegmentActivity', async () => {
    const parsed = piSegmentRequestSchema.parse(request);
    const db = getProcessDb();
    heartbeatActivity({
      activity: 'runPiSegmentActivity',
      phase: 'load_execution_plan',
      segment_index: parsed.segment_index,
    });
    const executionPlan = await new AgentExecutionPlanRepository(db).getByRef(
      parsed.execution_plan_ref,
      { tenantId: parsed.request_context.tenant_id },
    );
    if (!executionPlan) {
      throw ApplicationFailure.nonRetryable(
        `AgentExecutionPlan not found: ${parsed.execution_plan_ref}`,
        'NOT_FOUND',
      );
    }
    const agentRun = await new AgentRunRepository(db).get(parsed.agent_run_id, {
      tenantId: parsed.request_context.tenant_id,
    });
    if (!agentRun) {
      throw ApplicationFailure.nonRetryable(
        `AgentRun not found: ${parsed.agent_run_id}`,
        'NOT_FOUND',
      );
    }
    if (agentRun.execution_plan_hash !== executionPlan.execution_plan_hash) {
      throw ApplicationFailure.nonRetryable(
        `AgentRun execution plan hash mismatch: ${parsed.agent_run_id}`,
        'VALIDATION_FAILED',
      );
    }

    heartbeatActivity({
      activity: 'runPiSegmentActivity',
      phase: 'load_context',
      segment_index: parsed.segment_index,
    });
    const snapshot = parsed.context_snapshot_ref
      ? await new AgentContextSnapshotRepository(db).get(parsed.context_snapshot_ref.snapshot_id)
      : undefined;
    if (parsed.context_snapshot_ref && !snapshot) {
      throw ApplicationFailure.nonRetryable(
        `Pi context snapshot not found: ${parsed.context_snapshot_ref.snapshot_id}`,
        'NOT_FOUND',
      );
    }

    const policySnapshot = agentRun.tenant_policy_snapshot_ref
      ? await new TenantRuntimePolicySnapshotRepository(db).getByRef(
          agentRun.tenant_policy_snapshot_ref,
          {
            tenantId: parsed.request_context.tenant_id,
          },
        )
      : undefined;
    const allowedModelIds = policySnapshot
      ? new Set(policySnapshot.resolved_allowed_models.map((rule) => rule.model_id))
      : undefined;
    const piRuntime = createPiRuntime({
      executionPlan,
      agentRun,
      segmentIndex: parsed.segment_index,
      db,
      ...(allowedModelIds ? { allowedModelIds } : {}),
    });
    const heartbeatLoop = startHeartbeatLoop('runPiSegmentActivity', {
      agent_run_id: parsed.agent_run_id,
      segment_index: parsed.segment_index,
    });
    try {
      const abortSignal = currentActivityAbortSignal();
      const adapterInput: Parameters<typeof runPiAgentSegment>[0] = {
        executionPlan,
        model: piRuntime.model,
        streamFn: piRuntime.streamFn,
        segmentIndex: parsed.segment_index,
        budgetRemaining: parsed.budget_remaining,
        maxContextBytes: parsed.budget_remaining.max_context_bytes,
      };
      if (abortSignal) {
        adapterInput.abortSignal = abortSignal;
      }
      if (snapshot?.messages) {
        adapterInput.contextMessages = snapshot.messages;
      }
      if (parsed.seed_messages?.length) {
        adapterInput.contextMessages = parsed.seed_messages;
      }
      if (parsed.initial_user_input) {
        adapterInput.initialUserInput = parsed.initial_user_input;
      }
      heartbeatActivity({
        activity: 'runPiSegmentActivity',
        phase: 'pi_agent_start',
        segment_index: parsed.segment_index,
      });
      const adapterResult = await runPiAgentSegment(adapterInput);
      throwIfActivityCancelled('runPiSegmentActivity cancelled after Pi segment');
      heartbeatActivity({
        activity: 'runPiSegmentActivity',
        phase: 'persist_context',
        segment_index: parsed.segment_index,
      });
      const snapshotInput: Parameters<AgentContextSnapshotRepository['create']>[0] = {
        agentRunId: parsed.agent_run_id,
        schemaVersion: PI_CONTEXT_SCHEMA_VERSION,
        sanitizedMessages: adapterResult.context.messages,
      };
      if (parsed.context_snapshot_ref?.snapshot_id) {
        snapshotInput.previousSnapshotId = parsed.context_snapshot_ref.snapshot_id;
      }
      const snapshotRef = await new AgentContextSnapshotRepository(db).create(snapshotInput);
      const segmentResult = piSegmentResultSchema.parse({
        ...adapterResult.segmentResult,
        context_snapshot_ref: snapshotRef,
      });
      await new AgentStepRepository(db).create({
        agent_run_id: parsed.agent_run_id,
        segment_index: parsed.segment_index,
        stable_step_key: `${parsed.agent_run_id}:${parsed.segment_index}`,
        segment_status: stepStatusForSegment(segmentResult),
        decision_summary: decisionSummaryForSegment(segmentResult),
        proposed_tool_calls:
          segmentResult.status === 'tool_requested' ? segmentResult.proposed_tool_calls : [],
        tool_result_refs: [],
        authoritative_tool_result_refs: [],
        human_task_ids: [],
        context_snapshot_before: parsed.context_snapshot_ref,
        context_snapshot_after: snapshotRef,
        handoff_refs: [],
        context_snapshot_ref: snapshotRef,
        usage: segmentResult.usage,
        ...(segmentResult.status === 'failed' ||
        segmentResult.status === 'stopped_by_budget' ||
        segmentResult.status === 'cancelled'
          ? {
              error_code: segmentResult.error_code,
              error_message: segmentResult.error_message,
            }
          : {}),
      });
      heartbeatActivity({
        activity: 'runPiSegmentActivity',
        phase: 'completed',
        segment_index: parsed.segment_index,
      });
      return segmentResult;
    } finally {
      heartbeatLoop.stop();
      piRuntime.cleanup?.();
    }
  });
}

export async function persistToolResultsToPiContextActivity(
  input: PersistToolResultsActivityInput,
): Promise<PiContextSnapshotRef> {
  return classifyActivityFailure('persistToolResultsToPiContextActivity', async () => {
    const db = getProcessDb();
    const snapshot = await new AgentContextSnapshotRepository(db).get(
      input.previous_context_snapshot_ref.snapshot_id,
    );
    if (!snapshot) {
      throw ApplicationFailure.nonRetryable(
        `Pi context snapshot not found: ${input.previous_context_snapshot_ref.snapshot_id}`,
        'NOT_FOUND',
      );
    }
    const restoredMessages = restorePiMessages({
      schema_version: PI_CONTEXT_SCHEMA_VERSION,
      messages: snapshot.messages,
    });
    const replaced = replaceDeferredToolResults(restoredMessages, input.tool_results, {
      maxBytes: input.max_context_bytes,
    });
    return new AgentContextSnapshotRepository(db).create({
      agentRunId: input.agent_run_id,
      previousSnapshotId: input.previous_context_snapshot_ref.snapshot_id,
      schemaVersion: PI_CONTEXT_SCHEMA_VERSION,
      sanitizedMessages: replaced.messages,
    });
  });
}

export async function appendUserInputToPiContextActivity(
  input: AppendUserInputActivityInput,
): Promise<PiContextSnapshotRef> {
  return classifyActivityFailure('appendUserInputToPiContextActivity', async () => {
    const db = getProcessDb();
    const snapshot = await new AgentContextSnapshotRepository(db).get(
      input.previous_context_snapshot_ref.snapshot_id,
    );
    if (!snapshot) {
      throw ApplicationFailure.nonRetryable(
        `Pi context snapshot not found: ${input.previous_context_snapshot_ref.snapshot_id}`,
        'NOT_FOUND',
      );
    }
    const restoredMessages = restorePiMessages({
      schema_version: PI_CONTEXT_SCHEMA_VERSION,
      messages: snapshot.messages,
    });
    const userMessage: UserMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Human task ${input.human_task_id} response: ${JSON.stringify(input.response)}`,
        },
      ],
      timestamp: 0,
    };
    const messages = [...restoredMessages, userMessage];
    const serialized = serializePiContext(messages, { maxBytes: input.max_context_bytes });
    return new AgentContextSnapshotRepository(db).create({
      agentRunId: input.agent_run_id,
      previousSnapshotId: input.previous_context_snapshot_ref.snapshot_id,
      schemaVersion: PI_CONTEXT_SCHEMA_VERSION,
      sanitizedMessages: serialized.messages,
    });
  });
}

export async function finalizeConversationTurnActivity(
  input: FinalizeConversationTurnActivityInput,
): Promise<void> {
  return classifyActivityFailure('finalizeConversationTurnActivity', async () => {
    const repository = new ConversationMessageRepository(getProcessDb());
    if (input.final_text) {
      await repository.completeAssistant({
        assistantMessageId: input.assistant_message_id,
        tenantId: input.tenant_id,
        contentText: input.final_text,
        ...(input.task_run_id ? { taskRunId: input.task_run_id } : {}),
        ...(input.agent_run_id ? { agentRunId: input.agent_run_id } : {}),
      });
      return;
    }
    await repository.failAssistant({
      assistantMessageId: input.assistant_message_id,
      tenantId: input.tenant_id,
      errorCode: input.error_code ?? 'WORKFLOW_FAILED',
      errorMessageKey: input.safe_error_message_key ?? 'errors.workflowFailed',
      ...(input.task_run_id ? { taskRunId: input.task_run_id } : {}),
      ...(input.agent_run_id ? { agentRunId: input.agent_run_id } : {}),
    });
  });
}

export async function updateAgentStepActivity(
  input: UpdateAgentStepActivityInput,
): Promise<AgentStepRecord> {
  return classifyActivityFailure('updateAgentStepActivity', async () =>
    new AgentStepRepository(getProcessDb()).updateBoundaryResult({
      stableStepKey: input.stable_step_key,
      ...(input.segment_status ? { segmentStatus: input.segment_status } : {}),
      ...(input.decision_summary !== undefined ? { decisionSummary: input.decision_summary } : {}),
      ...(input.proposed_tool_calls !== undefined
        ? { proposedToolCalls: input.proposed_tool_calls }
        : {}),
      ...(input.tool_result_refs !== undefined ? { toolResultRefs: input.tool_result_refs } : {}),
      ...(input.authoritative_tool_result_refs !== undefined
        ? { authoritativeToolResultRefs: input.authoritative_tool_result_refs }
        : {}),
      ...(input.human_task_ids !== undefined ? { humanTaskIds: input.human_task_ids } : {}),
      ...(input.context_snapshot_before !== undefined
        ? { contextSnapshotBefore: input.context_snapshot_before }
        : {}),
      ...(input.context_snapshot_after !== undefined
        ? { contextSnapshotAfter: input.context_snapshot_after }
        : {}),
      ...(input.context_snapshot_ref !== undefined
        ? { contextSnapshotRef: input.context_snapshot_ref }
        : {}),
      ...(input.handoff_refs !== undefined ? { handoffRefs: input.handoff_refs } : {}),
      ...(input.output_ref !== undefined ? { outputRef: input.output_ref } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.error_code !== undefined ? { errorCode: input.error_code } : {}),
      ...(input.error_message !== undefined ? { errorMessage: input.error_message } : {}),
    }),
  );
}

export async function createHumanTaskActivity(
  context: ActivityContext,
  input: CreateHumanTaskActivityInput = {},
): Promise<HumanTask> {
  return classifyActivityFailure('createHumanTaskActivity', async () => {
    const db = getProcessDb();
    const humanTask = await new HumanTaskRepository(db).create(
      humanTaskCreateRequestSchema.parse({
        tenant_id: context.tenant_id,
        user_id: context.user_id,
        task_run_id: context.task_run_id,
        workflow_id: context.workflow_id,
        kind: input.kind ?? 'approval',
        tool_call_id: input.tool_call_id,
        tool_name: input.tool_name,
        assignee: input.assignee,
        candidate_groups: input.candidate_groups ?? [],
        payload: input.payload ?? {},
        requested_schema: input.requested_schema,
        request_id: context.request_id,
      }),
    );
    await new TaskRunRepository(db).updateStatus(context.task_run_id, {
      status: input.kind === 'user_input' ? 'waiting_user' : 'waiting_human',
    });
    await new AuditEventRepository(db).append({
      event_key: `agent.human_task.created:${context.tenant_id}:${humanTask.human_task_id}`,
      tenant_id: context.tenant_id,
      actor_id: context.user_id,
      action: 'agent.human_task.created',
      target_type: 'human_task',
      target_id: humanTask.human_task_id,
      result: 'pending',
      reason:
        input.kind === 'user_input' ? 'agent_user_input_required' : 'l3_tool_confirmation_required',
      trace_id: context.request_id,
      payload: {
        task_run_id: context.task_run_id,
        workflow_id: context.workflow_id,
        tool_call_id: input.tool_call_id,
        tool_name: input.tool_name,
      },
    });
    return humanTask;
  });
}

export async function invokeToolActivity(
  context: ActivityContext,
  tool: FlowExecutionPlanTool,
  args: Record<string, unknown>,
  identity?: AgentToolExecutionIdentity,
): Promise<ToolInvokeResponse> {
  return classifyActivityFailure('invokeToolActivity', async () => {
    throwIfActivityCancelled('invokeToolActivity cancelled before Tool Gateway invoke');
    heartbeatActivity({
      activity: 'invokeToolActivity',
      phase: 'before_request',
      tool_name: tool.tool_name,
    });
    const config = loadConfig();
    const client = createToolGatewayClient(config);
    const result = await client.invoke(
      toolInvokeRequestSchema.parse({
        tool_name: tool.tool_name,
        tool_version: tool.tool_version,
        tool_sha256: tool.tool_sha256,
        tenant_id: context.tenant_id,
        user_context: { user_id: context.user_id },
        task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
        arguments: args,
        idempotency_key: identity
          ? buildAgentToolIdempotencyKey(identity)
          : `${context.task_run_id}:${tool.tool_name}`,
        risk_level: tool.risk_level,
        ...(context.tenant_policy_snapshot_ref
          ? { tenant_policy_snapshot_ref: context.tenant_policy_snapshot_ref }
          : {}),
        ...(context.tenant_policy_hash ? { tenant_policy_hash: context.tenant_policy_hash } : {}),
        ...(context.execution_plan_ref ? { execution_plan_ref: context.execution_plan_ref } : {}),
        ...(context.execution_plan_hash
          ? { execution_plan_hash: context.execution_plan_hash }
          : {}),
        execution_context_type: context.execution_context_type ?? 'runtime',
        ...(context.evaluation_run_id ? { evaluation_run_id: context.evaluation_run_id } : {}),
        ...(context.evaluation_case_id ? { evaluation_case_id: context.evaluation_case_id } : {}),
        ...(context.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: context.evaluation_execution_plan_ref } : {}),
        ...(context.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: context.evaluation_execution_plan_hash } : {}),
        request_id: context.request_id,
      }),
    );
    heartbeatActivity({
      activity: 'invokeToolActivity',
      phase: 'after_request',
      tool_name: tool.tool_name,
      status: result.status,
    });
    return result;
  });
}

export async function previewToolActivity(
  context: ActivityContext,
  tool: FlowExecutionPlanTool,
  args: Record<string, unknown>,
  identity?: AgentToolExecutionIdentity,
): Promise<ToolPreviewResponse> {
  return classifyActivityFailure('previewToolActivity', async () => {
    throwIfActivityCancelled('previewToolActivity cancelled before Tool Gateway preview');
    heartbeatActivity({
      activity: 'previewToolActivity',
      phase: 'before_request',
      tool_name: tool.tool_name,
    });
    const config = loadConfig();
    const client = createToolGatewayClient(config);
    const result = await client.preview(
      toolPreviewRequestSchema.parse({
        tool_name: tool.tool_name,
        tool_version: tool.tool_version,
        tool_sha256: tool.tool_sha256,
        tenant_id: context.tenant_id,
        user_context: { user_id: context.user_id },
        task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
        arguments: args,
        idempotency_key: identity
          ? buildAgentToolIdempotencyKey(identity)
          : `${context.task_run_id}:${tool.tool_name}:preview`,
        risk_level: tool.risk_level,
        ...(context.tenant_policy_snapshot_ref
          ? { tenant_policy_snapshot_ref: context.tenant_policy_snapshot_ref }
          : {}),
        ...(context.tenant_policy_hash ? { tenant_policy_hash: context.tenant_policy_hash } : {}),
        ...(context.execution_plan_ref ? { execution_plan_ref: context.execution_plan_ref } : {}),
        ...(context.execution_plan_hash
          ? { execution_plan_hash: context.execution_plan_hash }
          : {}),
        execution_context_type: context.execution_context_type ?? 'runtime',
        ...(context.evaluation_run_id ? { evaluation_run_id: context.evaluation_run_id } : {}),
        ...(context.evaluation_case_id ? { evaluation_case_id: context.evaluation_case_id } : {}),
        ...(context.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: context.evaluation_execution_plan_ref } : {}),
        ...(context.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: context.evaluation_execution_plan_hash } : {}),
        request_id: context.request_id,
      }),
    );
    heartbeatActivity({
      activity: 'previewToolActivity',
      phase: 'after_request',
      tool_name: tool.tool_name,
      status: result.status,
    });
    return result;
  });
}

export async function commitToolActivity(
  context: ActivityContext,
  toolCallId: string,
  tool: FlowExecutionPlanTool,
  args: Record<string, unknown>,
  identity?: AgentToolExecutionIdentity,
): Promise<ToolCommitResponse> {
  return classifyActivityFailure('commitToolActivity', async () => {
    throwIfActivityCancelled('commitToolActivity cancelled before Tool Gateway commit');
    heartbeatActivity({
      activity: 'commitToolActivity',
      phase: 'before_request',
      tool_name: tool.tool_name,
      tool_call_id: toolCallId,
    });
    const config = loadConfig();
    const client = createToolGatewayClient(config);
    const result = await client.commit(
      toolCommitRequestSchema.parse({
        tool_call_id: toolCallId,
        tool_name: tool.tool_name,
        tool_version: tool.tool_version,
        tool_sha256: tool.tool_sha256,
        tenant_id: context.tenant_id,
        user_context: { user_id: context.user_id },
        task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
        arguments: args,
        idempotency_key: identity
          ? buildAgentToolIdempotencyKey(identity)
          : `${context.task_run_id}:${tool.tool_name}:commit:${toolCallId}`,
        ...(context.tenant_policy_snapshot_ref
          ? { tenant_policy_snapshot_ref: context.tenant_policy_snapshot_ref }
          : {}),
        ...(context.tenant_policy_hash ? { tenant_policy_hash: context.tenant_policy_hash } : {}),
        ...(context.execution_plan_ref ? { execution_plan_ref: context.execution_plan_ref } : {}),
        ...(context.execution_plan_hash
          ? { execution_plan_hash: context.execution_plan_hash }
          : {}),
        execution_context_type: context.execution_context_type ?? 'runtime',
        ...(context.evaluation_run_id ? { evaluation_run_id: context.evaluation_run_id } : {}),
        ...(context.evaluation_case_id ? { evaluation_case_id: context.evaluation_case_id } : {}),
        ...(context.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: context.evaluation_execution_plan_ref } : {}),
        ...(context.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: context.evaluation_execution_plan_hash } : {}),
        request_id: context.request_id,
      }),
    );
    heartbeatActivity({
      activity: 'commitToolActivity',
      phase: 'after_request',
      tool_name: tool.tool_name,
      tool_call_id: toolCallId,
      status: result.status,
    });
    return result;
  });
}

export interface LoadEvaluationRunPlanActivityInput {
  tenant_id: string;
  evaluation_run_id: string;
  evaluation_execution_plan_ref: string;
  evaluation_execution_plan_hash: string;
}

export interface LoadEvaluationRunPlanActivityResult {
  run: EvaluationRun;
  plan: EvaluationExecutionPlan;
  subject_snapshot: EvaluationSubjectSnapshot;
  cases: EvaluationCase[];
  max_concurrent_cases: number;
  case_timeout_ms: number;
}

export interface EvaluationCaseSummary {
  case_id: string;
  status: EvaluationCaseResult['status'];
  score?: number;
  task_run_id?: string;
  agent_run_id?: string;
}

export interface PrepareEvaluationCaseActivityResult {
  task_run_id: string;
  agent_execution_plan_ref: string;
  initial_user_input: string;
  tenant_policy_snapshot_ref: string;
  tenant_policy_hash: string;
}

export async function loadEvaluationRunPlanActivity(
  input: LoadEvaluationRunPlanActivityInput,
): Promise<LoadEvaluationRunPlanActivityResult> {
  return classifyActivityFailure('loadEvaluationRunPlanActivity', async () => {
    const db = getProcessDb();
    const config = loadConfig();
    if (config.EVALUATION_MAX_CONCURRENT_CASES < 1) {
      throw ApplicationFailure.nonRetryable(
        'EVALUATION_MAX_CONCURRENT_CASES must be positive',
        'VALIDATION_FAILED',
      );
    }
    const run = await new EvaluationRunRepository(db).get(input.evaluation_run_id);
    if (!run || run.tenant_id !== input.tenant_id) {
      throw ApplicationFailure.nonRetryable('EvaluationRun not found', 'NOT_FOUND');
    }
    const plan = await new EvaluationExecutionPlanRepository(db).getByRef(input.evaluation_execution_plan_ref);
    if (!plan || plan.tenant_id !== input.tenant_id || plan.plan_hash !== input.evaluation_execution_plan_hash) {
      throw ApplicationFailure.nonRetryable('EvaluationExecutionPlan hash mismatch', 'EVALUATION_EXECUTION_PLAN_HASH_MISMATCH');
    }
    const subjectSnapshot = await new EvaluationSubjectSnapshotRepository(db).getByRef(plan.subject_snapshot_ref);
    if (!subjectSnapshot || hashEvaluationSubjectSnapshot(subjectSnapshot) !== plan.subject_snapshot_hash) {
      throw ApplicationFailure.nonRetryable('EvaluationSubjectSnapshot hash mismatch', 'EVALUATION_SUBJECT_HASH_MISMATCH');
    }
    try {
      await new EvaluationDatasetRepository(db).assertContentHash(plan.dataset_id, plan.dataset_version, plan.dataset_hash);
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'EVALUATION_DATASET_HASH_MISMATCH';
      throw ApplicationFailure.nonRetryable('EvaluationDataset hash mismatch', code);
    }
    const cases = await new EvaluationCaseRepository(db).list(plan.dataset_id, plan.dataset_version, true);
    return {
      run,
      plan,
      subject_snapshot: subjectSnapshot,
      cases,
      max_concurrent_cases: config.EVALUATION_MAX_CONCURRENT_CASES,
      case_timeout_ms: config.EVALUATION_CASE_TIMEOUT_MS,
    };
  });
}

export async function markEvaluationRunRunningActivity(input: {
  evaluation_run_id: string;
  workflow_id: string;
  workflow_run_id?: string;
}): Promise<EvaluationRun> {
  return classifyActivityFailure('markEvaluationRunRunningActivity', async () => {
    const repository = new EvaluationRunRepository(getProcessDb());
    await repository.attachWorkflow(input.evaluation_run_id, input.workflow_id, input.workflow_run_id);
    return repository.markRunning(input.evaluation_run_id);
  });
}

export async function failEvaluationRunActivity(input: {
  evaluation_run_id: string;
  error_code: string;
  error_message: string;
}): Promise<EvaluationRun> {
  return classifyActivityFailure('failEvaluationRunActivity', async () =>
    new EvaluationRunRepository(getProcessDb()).fail(input.evaluation_run_id, input.error_code, input.error_message),
  );
}

export async function completeEvaluationRunActivity(input: {
  evaluation_run_id: string;
  aggregate: EvaluationAggregateResult;
}): Promise<EvaluationRun> {
  return classifyActivityFailure('completeEvaluationRunActivity', async () =>
    new EvaluationRunRepository(getProcessDb()).complete(input.evaluation_run_id, input.aggregate),
  );
}

export async function cancelEvaluationRunActivity(input: {
  evaluation_run_id: string;
  aggregate?: EvaluationAggregateResult;
}): Promise<EvaluationRun> {
  return classifyActivityFailure('cancelEvaluationRunActivity', async () =>
    new EvaluationRunRepository(getProcessDb()).cancel(input.evaluation_run_id, input.aggregate),
  );
}

export async function verifyEvaluationCandidateFidelityActivity(input: {
  tenant_id: string;
  evaluation_execution_plan_ref: string;
  evaluation_execution_plan_hash: string;
}): Promise<{ verified: true; subject_snapshot: EvaluationSubjectSnapshot; plan: EvaluationExecutionPlan }> {
  return classifyActivityFailure('verifyEvaluationCandidateFidelityActivity', async () => {
    const db = getProcessDb();
    const plan = await new EvaluationExecutionPlanRepository(db).getByRef(input.evaluation_execution_plan_ref);
    if (!plan || plan.tenant_id !== input.tenant_id || plan.plan_hash !== input.evaluation_execution_plan_hash) {
      throw ApplicationFailure.nonRetryable('Evaluation execution plan mismatch', 'EVALUATION_EXECUTION_PLAN_HASH_MISMATCH');
    }
    const subjectSnapshot = await new EvaluationSubjectSnapshotRepository(db).getByRef(plan.subject_snapshot_ref);
    if (!subjectSnapshot) {
      throw ApplicationFailure.nonRetryable('Evaluation subject snapshot not found', 'NOT_FOUND');
    }
    const agentPlan = await new AgentExecutionPlanRepository(db).getByRef(plan.agent_execution_plan_ref, { tenantId: input.tenant_id });
    if (!agentPlan) {
      throw ApplicationFailure.nonRetryable('Agent execution plan not found', 'NOT_FOUND');
    }
    assertCandidateFidelity({ subjectSnapshot, agentExecutionPlan: agentPlan });
    if (
      plan.resolved_agent_plan.agent_sha256 !== subjectSnapshot.candidate_bundle.agent_hash ||
      plan.resolved_agent_plan.prompt_sha256 !== subjectSnapshot.candidate_bundle.prompt_hash ||
      plan.resolved_agent_plan.model_policy_hash !== subjectSnapshot.candidate_bundle.model_policy_hash
    ) {
      throw ApplicationFailure.nonRetryable('Evaluation execution plan resolved candidate mismatch', 'EVALUATION_CANDIDATE_FIDELITY_MISMATCH');
    }
    return { verified: true, subject_snapshot: subjectSnapshot, plan };
  });
}

export async function prepareEvaluationCaseActivity(input: {
  tenant_id: string;
  user_id: string;
  evaluation_run_id: string;
  case_id: string;
  workflow_id: string;
  request_id: string;
  evaluation_execution_plan_ref: string;
  evaluation_execution_plan_hash: string;
}): Promise<PrepareEvaluationCaseActivityResult> {
  return classifyActivityFailure('prepareEvaluationCaseActivity', async () => {
    const db = getProcessDb();
    const run = await new EvaluationRunRepository(db).get(input.evaluation_run_id);
    if (!run || run.tenant_id !== input.tenant_id) {
      throw ApplicationFailure.nonRetryable('EvaluationRun not found', 'NOT_FOUND');
    }
    const plan = await new EvaluationExecutionPlanRepository(db).getByRef(input.evaluation_execution_plan_ref);
    if (!plan || plan.plan_hash !== input.evaluation_execution_plan_hash || plan.tenant_id !== input.tenant_id) {
      throw ApplicationFailure.nonRetryable('Evaluation execution plan mismatch', 'EVALUATION_EXECUTION_PLAN_HASH_MISMATCH');
    }
    const evaluationCase = await new EvaluationCaseRepository(db).get(input.case_id);
    if (!evaluationCase || evaluationCase.dataset_id !== run.dataset_id || evaluationCase.dataset_version !== run.dataset_version) {
      throw ApplicationFailure.nonRetryable('EvaluationCase not found for run dataset', 'NOT_FOUND');
    }
    const taskRunId = `eval_task_${input.evaluation_run_id}_${input.case_id}`;
    const existing = await new TaskRunRepository(db).get(taskRunId);
    if (!existing) {
      await new TaskRunRepository(db).create({
        taskRun: taskRunSchema.parse({
          task_run_id: taskRunId,
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          route_type: 'manual',
          workflow_id: input.workflow_id,
          execution_plan_ref: plan.agent_execution_plan_ref,
          tenant_policy_snapshot_ref: plan.tenant_policy_snapshot_ref,
          tenant_policy_hash: plan.tenant_policy_snapshot_hash,
          status: 'queued',
        }),
        input: evaluationCase.input,
        routeResult: {
          route_decision: {
            decision: 'agent_fallback',
            agent_id: plan.resolved_agent_plan.agent_id,
            reason: 'evaluation_case',
          },
          candidates: [],
        },
        executionPlanRef: plan.agent_execution_plan_ref,
        tenantPolicySnapshotRef: plan.tenant_policy_snapshot_ref,
        tenantPolicyHash: plan.tenant_policy_snapshot_hash,
      });
    }
    return {
      task_run_id: taskRunId,
      agent_execution_plan_ref: plan.agent_execution_plan_ref,
      initial_user_input: typeof evaluationCase.input.text === 'string'
        ? evaluationCase.input.text
        : stableStringify(evaluationCase.input),
      tenant_policy_snapshot_ref: plan.tenant_policy_snapshot_ref,
      tenant_policy_hash: plan.tenant_policy_snapshot_hash,
    };
  });
}

export async function collectAndScoreEvaluationCaseActivity(input: {
  tenant_id: string;
  evaluation_run_id: string;
  case_id: string;
  task_run_id: string;
  agent_run_id?: string;
  workflow_id: string;
  workflow_run_id?: string;
  started_at_ms?: number;
}): Promise<EvaluationCaseResult> {
  return classifyActivityFailure('collectAndScoreEvaluationCaseActivity', async () => {
    const db = getProcessDb();
    const run = await new EvaluationRunRepository(db).get(input.evaluation_run_id);
    if (!run || run.tenant_id !== input.tenant_id) {
      throw ApplicationFailure.nonRetryable('EvaluationRun not found', 'NOT_FOUND');
    }
    const evaluationCase = await new EvaluationCaseRepository(db).get(input.case_id);
    if (!evaluationCase || evaluationCase.dataset_id !== run.dataset_id || evaluationCase.dataset_version !== run.dataset_version) {
      throw ApplicationFailure.nonRetryable('EvaluationCase not found for run dataset', 'NOT_FOUND');
    }
    const config = loadConfig();
    const evidence = await new EvaluationEvidenceCollector(db, {
      outputMaxBytes: config.EVALUATION_OUTPUT_MAX_BYTES,
      evidenceMaxBytes: config.EVALUATION_EVIDENCE_MAX_BYTES,
    }).collect({
      tenantId: input.tenant_id,
      evaluationRunId: input.evaluation_run_id,
      caseId: input.case_id,
      taskRunId: input.task_run_id,
      ...(input.agent_run_id ? { agentRunId: input.agent_run_id } : {}),
      ...(input.started_at_ms !== undefined ? { startedAtMs: input.started_at_ms } : {}),
    });
    const evidenceWithLimits = enforceEvidenceSizeLimits(evidence, {
      outputMaxBytes: config.EVALUATION_OUTPUT_MAX_BYTES,
      evidenceMaxBytes: config.EVALUATION_EVIDENCE_MAX_BYTES,
    });
    const evidenceIncomplete = evidenceWithLimits.completeness_status !== 'complete';
    const scored = new EvaluationScoringEngine().scoreCase({
      evaluationCase,
      actualStatus: evidenceIncomplete ? 'system_error' : normalizeActualStatus(evidenceWithLimits.actual_status),
      finalOutput: evidenceWithLimits.final_output_safe,
      toolCalls: evidenceWithLimits.tool_calls.map((call) => ({
        tool_name: call.tool_name,
        status: call.status,
      })),
      policyViolations: evidenceWithLimits.policy_violation_count,
      unauthorizedToolCount: evidenceWithLimits.unauthorized_tool_count,
      sideEffectWithoutApprovalCount: evidenceWithLimits.side_effect_without_approval_count,
      crossTenantViolationCount: evidenceWithLimits.cross_tenant_violation_count,
      secretLeakCount: evidenceWithLimits.secret_leak_count,
      hiddenReasoningLeakCount: evidenceWithLimits.hidden_reasoning_leak_count,
      modelCallCount: evidenceWithLimits.model_call_count,
      fallbackCount: evidenceWithLimits.fallback_count,
      systemError: Boolean(evidenceWithLimits.system_error) || evidenceIncomplete,
      ...(evidenceWithLimits.latency.ms !== undefined ? { latencyMs: evidenceWithLimits.latency.ms } : {}),
      ...(evidenceWithLimits.tokens.input !== undefined ? { inputTokens: evidenceWithLimits.tokens.input } : {}),
      ...(evidenceWithLimits.tokens.output !== undefined ? { outputTokens: evidenceWithLimits.tokens.output } : {}),
      ...(evidenceWithLimits.tokens.total !== undefined ? { totalTokens: evidenceWithLimits.tokens.total } : {}),
      ...(evidenceWithLimits.cost.estimated !== undefined ? { estimatedCost: evidenceWithLimits.cost.estimated } : {}),
    });
    const result = await new EvaluationCaseResultRepository(db).upsert({
      ...scored,
      evaluation_run_id: input.evaluation_run_id,
      workflow_id: input.workflow_id,
      ...(input.workflow_run_id ? { workflow_run_id: input.workflow_run_id } : {}),
      evidence_snapshot: evidenceWithLimits as unknown as Record<string, unknown>,
      evidence_hash: stableHash(evidenceWithLimits),
      candidate_fidelity_verified: true,
      assertion_failure_count: scored.metric_results.filter((metric) => !metric.hard_gate && !metric.passed).length,
      hard_gate_failure_count: scored.metric_results.filter((metric) => metric.hard_gate && !metric.passed).length,
      ...(evidenceWithLimits.system_error?.code || evidenceIncomplete ? { system_error_class: evidenceWithLimits.system_error?.code ?? 'EVALUATION_EVIDENCE_INCOMPLETE' } : {}),
      task_run_id: input.task_run_id,
      ...(input.agent_run_id ?? evidenceWithLimits.refs.agent_run_id ? { agent_run_id: input.agent_run_id ?? evidenceWithLimits.refs.agent_run_id } : {}),
      model_call_ids: evidenceWithLimits.refs.model_call_ids,
      tool_call_ids: evidenceWithLimits.refs.tool_call_ids,
      ...(evidenceWithLimits.final_output_ref ? { final_output_ref: evidenceWithLimits.final_output_ref } : {}),
      ...(evidenceWithLimits.final_output_safe !== undefined ? { safe_output: evidenceWithLimits.final_output_safe } : {}),
    });
    return result;
  });
}

export async function recordEvaluationCaseSystemErrorActivity(input: {
  tenant_id: string;
  evaluation_run_id: string;
  case_id: string;
  task_run_id?: string;
  agent_run_id?: string;
  workflow_id: string;
  workflow_run_id?: string;
  started_at_ms?: number;
  error_code: string;
  error_message: string;
  cancelled?: boolean;
}): Promise<EvaluationCaseResult> {
  return classifyActivityFailure('recordEvaluationCaseSystemErrorActivity', async () => {
    const db = getProcessDb();
    const run = await new EvaluationRunRepository(db).get(input.evaluation_run_id);
    if (!run || run.tenant_id !== input.tenant_id) {
      throw ApplicationFailure.nonRetryable('EvaluationRun not found', 'NOT_FOUND');
    }
    const evaluationCase = await new EvaluationCaseRepository(db).get(input.case_id);
    if (!evaluationCase || evaluationCase.dataset_id !== run.dataset_id || evaluationCase.dataset_version !== run.dataset_version) {
      throw ApplicationFailure.nonRetryable('EvaluationCase not found for run dataset', 'NOT_FOUND');
    }
    const completedAt = new Date().toISOString();
    const startedAt = input.started_at_ms !== undefined
      ? new Date(input.started_at_ms).toISOString()
      : completedAt;
    const latencyMs = input.started_at_ms !== undefined
      ? Math.max(0, Date.now() - input.started_at_ms)
      : undefined;
    const collectedEvidence = await collectSystemErrorEvidence({
      db,
      tenantId: input.tenant_id,
      evaluationRunId: input.evaluation_run_id,
      caseId: input.case_id,
      ...(input.task_run_id ? { taskRunId: input.task_run_id } : {}),
      ...(input.agent_run_id ? { agentRunId: input.agent_run_id } : {}),
      ...(input.started_at_ms !== undefined ? { startedAtMs: input.started_at_ms } : {}),
      ...(input.cancelled !== undefined ? { cancelled: input.cancelled } : {}),
      errorCode: input.error_code,
      errorMessage: input.error_message,
    });
    const result = await new EvaluationCaseResultRepository(db).upsert({
      evaluation_run_id: input.evaluation_run_id,
      case_id: input.case_id,
      workflow_id: input.workflow_id,
      ...(input.workflow_run_id ? { workflow_run_id: input.workflow_run_id } : {}),
      status: input.cancelled ? 'cancelled' : 'system_error',
      score: 0,
      metric_results: [
        {
          metric_name: input.cancelled ? 'case_cancelled' : 'case_system_error',
          metric_type: 'runtime',
          score: 0,
          passed: false,
          hard_gate: !input.cancelled,
          actual: input.error_code,
          reason: input.error_code,
        },
      ],
      evidence_snapshot: collectedEvidence as unknown as Record<string, unknown>,
      evidence_hash: stableHash(collectedEvidence),
      candidate_fidelity_verified: true,
      assertion_failure_count: 0,
      hard_gate_failure_count: input.cancelled ? 0 : 1,
      system_error_class: input.error_code,
      actual_status: input.cancelled ? 'cancelled' : 'system_error',
      ...(collectedEvidence.refs.task_run_id ? { task_run_id: collectedEvidence.refs.task_run_id } : input.task_run_id ? { task_run_id: input.task_run_id } : {}),
      ...(collectedEvidence.refs.agent_run_id ? { agent_run_id: collectedEvidence.refs.agent_run_id } : input.agent_run_id ? { agent_run_id: input.agent_run_id } : {}),
      model_call_ids: collectedEvidence.refs.model_call_ids,
      tool_call_ids: collectedEvidence.refs.tool_call_ids,
      ...(latencyMs !== undefined ? { latency_ms: latencyMs } : {}),
      error_code: input.error_code,
      started_at: startedAt,
      completed_at: completedAt,
    });
    await new AuditEventRepository(db).append({
      event_key: `evaluation.case.${input.cancelled ? 'cancelled' : 'system_error'}:${input.evaluation_run_id}:${input.case_id}`,
      tenant_id: input.tenant_id,
      actor_id: run.created_by ?? 'evaluation-system',
      action: input.cancelled ? 'evaluation.case.cancelled' : 'evaluation.case.system_error',
      target_type: 'evaluation_case',
      target_id: input.case_id,
      result: input.cancelled ? 'pending' : 'failed',
      reason: input.error_code,
      trace_id: input.workflow_id,
      payload: {
        evaluation_run_id: input.evaluation_run_id,
        case_id: input.case_id,
        error_code: input.error_code,
      },
    });
    return result;
  });
}

async function collectSystemErrorEvidence(input: {
  db: ReturnType<typeof createDb>;
  tenantId: string;
  evaluationRunId: string;
  caseId: string;
  taskRunId?: string;
  agentRunId?: string;
  startedAtMs?: number;
  cancelled?: boolean;
  errorCode: string;
  errorMessage: string;
}) {
  const config = loadConfig();
  try {
    const evidence = await new EvaluationEvidenceCollector(input.db, {
      outputMaxBytes: config.EVALUATION_OUTPUT_MAX_BYTES,
      evidenceMaxBytes: config.EVALUATION_EVIDENCE_MAX_BYTES,
    }).collect({
      tenantId: input.tenantId,
      evaluationRunId: input.evaluationRunId,
      caseId: input.caseId,
      ...(input.taskRunId ? { taskRunId: input.taskRunId } : {}),
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
      ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
    });
    return enforceEvidenceSizeLimits({
      ...evidence,
      actual_status: input.cancelled ? 'cancelled' : 'system_error',
      system_error: {
        code: input.errorCode,
        class: 'evaluation_case_system_error',
      },
    }, {
      outputMaxBytes: config.EVALUATION_OUTPUT_MAX_BYTES,
      evidenceMaxBytes: config.EVALUATION_EVIDENCE_MAX_BYTES,
    });
  } catch {
    return enforceEvidenceSizeLimits({
      actual_status: input.cancelled ? 'cancelled' : 'system_error',
      system_error: {
        code: input.errorCode,
        class: 'evaluation_case_system_error',
      },
      tool_calls: [],
      tool_call_order: [],
      tool_order: [],
      tool_arguments: [],
      tool_results_refs: [],
      tool_result_refs: [],
      unauthorized_tool_count: input.cancelled ? 0 : 1,
      forbidden_tool_count: input.cancelled ? 0 : 1,
      side_effect_without_approval_count: input.cancelled ? 0 : 1,
      duplicate_tool_call_count: 0,
      duplicate_commit_count: 0,
      policy_violation_count: input.cancelled ? 0 : 1,
      cross_tenant_violation_count: input.cancelled ? 0 : 1,
      secret_leak_count: input.cancelled ? 0 : 1,
      hidden_reasoning_leak_count: input.cancelled ? 0 : 1,
      model_call_count: 0,
      fallback_count: 0,
      latency: {},
      tokens: {},
      cost: {},
      completeness_status: 'incomplete',
      completeness_reasons: ['collector_failed'],
      error_code: 'EVALUATION_EVIDENCE_INCOMPLETE',
      refs: {
        ...(input.taskRunId ? { task_run_id: input.taskRunId } : {}),
        ...(input.agentRunId ? { agent_run_id: input.agentRunId } : {}),
        agent_step_ids: [],
        model_call_ids: [],
        model_call_attempt_ids: [],
        tool_call_ids: [],
        human_task_ids: [],
        audit_event_ids: [],
        idempotency_record_ids: [],
      },
    }, {
      outputMaxBytes: config.EVALUATION_OUTPUT_MAX_BYTES,
      evidenceMaxBytes: config.EVALUATION_EVIDENCE_MAX_BYTES,
    });
  }
}

export async function aggregateEvaluationRunActivity(input: {
  evaluation_run_id: string;
}): Promise<EvaluationAggregateResult> {
  return classifyActivityFailure('aggregateEvaluationRunActivity', async () => {
    const db = getProcessDb();
    const run = await new EvaluationRunRepository(db).get(input.evaluation_run_id);
    if (!run) {
      throw ApplicationFailure.nonRetryable('EvaluationRun not found', 'NOT_FOUND');
    }
    const cases = await new EvaluationCaseRepository(db).list(run.dataset_id, run.dataset_version, true);
    const results = await new EvaluationCaseResultRepository(db).listByRun(run.evaluation_run_id);
    return new EvaluationScoringEngine().aggregate({ runId: run.evaluation_run_id, cases, results });
  });
}

export async function compareEvaluationRunActivity(input: {
  candidate_run_id: string;
  baseline_run_id: string;
  created_by?: string;
  candidate_aggregate?: EvaluationAggregateResult;
}): Promise<EvaluationComparison> {
  return classifyActivityFailure('compareEvaluationRunActivity', async () => {
    const db = getProcessDb();
    const runRepository = new EvaluationRunRepository(db);
    const candidateRun = await runRepository.get(input.candidate_run_id);
    const baselineRun = await runRepository.get(input.baseline_run_id);
    if (!candidateRun || !baselineRun) {
      throw ApplicationFailure.nonRetryable('EvaluationRun comparison target not found', 'NOT_FOUND');
    }
    const resultRepository = new EvaluationCaseResultRepository(db);
    const comparison = new EvaluationComparisonService().compare({
      candidateRun: input.candidate_aggregate
        ? runWithAggregate(candidateRun, input.candidate_aggregate)
        : candidateRun,
      candidateResults: await resultRepository.listByRun(candidateRun.evaluation_run_id),
      baselineRun,
      baselineResults: await resultRepository.listByRun(baselineRun.evaluation_run_id),
    });
    return new EvaluationComparisonRepository(db).create(comparison, input.created_by);
  });
}

function runWithAggregate(run: EvaluationRun, aggregate: EvaluationAggregateResult): EvaluationRun {
  return {
    ...run,
    total_cases: aggregate.total_cases,
    completed_cases: aggregate.completed_cases,
    passed_cases: aggregate.passed_cases,
    failed_cases: aggregate.failed_cases,
    skipped_cases: aggregate.skipped_cases,
    system_error_cases: Number(aggregate.metric_summary.system_error_cases ?? 0),
    aggregate_score: aggregate.weighted_score,
  };
}

function enforceEvidenceSizeLimits(
  evidence: EvaluationEvidenceSnapshot,
  limits: { outputMaxBytes: number; evidenceMaxBytes: number },
): EvaluationEvidenceSnapshot {
  let checked = evidence;
  if (
    checked.final_output_safe !== undefined &&
    jsonByteLength(checked.final_output_safe) > limits.outputMaxBytes
  ) {
    const { final_output_safe: _finalOutputSafe, ...withoutOutput } = checked;
    checked = {
      ...withoutOutput,
      actual_status: 'system_error',
      system_error: {
        code: 'EVALUATION_EVIDENCE_SIZE_LIMIT_EXCEEDED',
        class: 'evaluation_evidence_error',
      },
      completeness_status: 'incomplete',
      completeness_reasons: appendUniqueString(
        checked.completeness_reasons,
        checked.final_output_ref
          ? 'final_output_safe_omitted_due_to_size'
          : 'final_output_size_limit_exceeded',
      ),
      error_code: 'EVALUATION_EVIDENCE_INCOMPLETE',
    };
  }
  if (jsonByteLength(checked) <= limits.evidenceMaxBytes) {
    return checked;
  }
  return {
    actual_status: 'system_error',
    ...(typeof checked.final_output_ref === 'string' ? { final_output_ref: checked.final_output_ref } : {}),
    tool_calls: Array.isArray(checked.tool_calls) ? checked.tool_calls : [],
    tool_call_order: Array.isArray(checked.tool_call_order) ? checked.tool_call_order : [],
    tool_order: Array.isArray(checked.tool_order) ? checked.tool_order : [],
    tool_arguments: Array.isArray(checked.tool_arguments) ? checked.tool_arguments : [],
    tool_results_refs: Array.isArray(checked.tool_results_refs) ? checked.tool_results_refs : [],
    tool_result_refs: Array.isArray(checked.tool_result_refs) ? checked.tool_result_refs : [],
    unauthorized_tool_count: Number(checked.unauthorized_tool_count ?? 0),
    forbidden_tool_count: Number(checked.forbidden_tool_count ?? 0),
    side_effect_without_approval_count: Number(checked.side_effect_without_approval_count ?? 0),
    duplicate_tool_call_count: Number(checked.duplicate_tool_call_count ?? 0),
    duplicate_commit_count: Number(checked.duplicate_commit_count ?? 0),
    policy_violation_count: Number(checked.policy_violation_count ?? 0),
    cross_tenant_violation_count: Number(checked.cross_tenant_violation_count ?? 0),
    secret_leak_count: Number(checked.secret_leak_count ?? 0),
    hidden_reasoning_leak_count: Number(checked.hidden_reasoning_leak_count ?? 0),
    model_call_count: Number(checked.model_call_count ?? 0),
    fallback_count: Number(checked.fallback_count ?? 0),
    latency: checked.latency,
    tokens: checked.tokens,
    cost: checked.cost,
    system_error: {
      code: 'EVALUATION_EVIDENCE_SIZE_LIMIT_EXCEEDED',
      class: 'evaluation_evidence_error',
    },
    completeness_status: 'incomplete',
    completeness_reasons: appendUniqueString(
      checked.completeness_reasons,
      'evidence_size_limit_exceeded',
    ),
    error_code: 'EVALUATION_EVIDENCE_INCOMPLETE',
    refs: checked.refs,
  };
}

function appendUniqueString(value: unknown, next: string): string[] {
  const values = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  return [...new Set([...values, next])];
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(stableStringify(value), 'utf8');
}

export async function generateEvaluationGateDecisionActivity(input: {
  evaluation_run_id: string;
}): Promise<EvaluationGateDecision | undefined> {
  return classifyActivityFailure('generateEvaluationGateDecisionActivity', async () => {
    const db = getProcessDb();
    const run = await new EvaluationRunRepository(db).get(input.evaluation_run_id);
    if (!run) {
      throw ApplicationFailure.nonRetryable('EvaluationRun not found', 'NOT_FOUND');
    }
    const subjectSnapshot = await new EvaluationSubjectSnapshotRepository(db).getByRef(run.subject_snapshot_ref);
    if (!subjectSnapshot) {
      throw ApplicationFailure.nonRetryable('EvaluationSubjectSnapshot not found', 'NOT_FOUND');
    }
    const policy = await new EvaluationGatePolicyRepository(db).getLatestPublishedForResource(subjectSnapshot.primary_subject_type);
    if (!policy) {
      return undefined;
    }
    const cases = await new EvaluationCaseRepository(db).list(run.dataset_id, run.dataset_version, true);
    const results = await new EvaluationCaseResultRepository(db).listByRun(run.evaluation_run_id);
    const aggregate = new EvaluationScoringEngine().aggregate({ runId: run.evaluation_run_id, cases, results });
    return new EvaluationGateService(db).evaluateRun({
      run,
      aggregate,
      subjectSnapshot,
      policy,
      mode: loadConfig().EVALUATION_GATE_MODE,
    });
  });
}

export async function loadFlowSpecActivity(flowSpec: FlowSpec): Promise<FlowSpec> {
  return flowSpec;
}

export async function updateTaskRunStatusActivity(
  input: UpdateTaskRunStatusActivityInput,
): Promise<void> {
  return classifyActivityFailure('updateTaskRunStatusActivity', async () => {
    const db = getProcessDb();
    const updated = await new TaskRunRepository(db).updateStatus(input.task_run_id, {
      status: input.status,
      ...(input.error_code ? { errorCode: input.error_code } : {}),
      ...(input.error_message ? { errorMessage: input.error_message } : {}),
    });
    if (!updated) {
      throw ApplicationFailure.nonRetryable(
        `TaskRun not found for status update: ${input.task_run_id}`,
        'NOT_FOUND',
      );
    }
    if (input.tenant_admission_id && (input.status === 'completed' || input.status === 'failed')) {
      await new TenantAgentAdmissionRepository(db).release(
        input.tenant_admission_id,
        input.status === 'completed' ? 'workflow_completed' : 'workflow_failed',
      );
    }
  });
}

export async function loadFlowSpecByRefActivity(flowSnapshotRef: string): Promise<FlowSpec> {
  const dbRef = parseDbFlowSnapshotRef(flowSnapshotRef);
  if (dbRef) {
    const db = getProcessDb();
    const flowSpec = await new FlowDefinitionRepository(db).getPublished(
      dbRef.flowId,
      dbRef.version,
    );
    if (!flowSpec) {
      throw new Error(`FlowSpec not found or not executable: ${flowSnapshotRef}`);
    }
    return flowSpecSchema.parse(flowSpec);
  }

  const config = loadConfig();
  if (flowSnapshotRef === 'sample_flow@1' && !isProductionRuntime(config)) {
    return sampleFlowSpec;
  }

  throw new Error(`Unknown flow snapshot ref: ${flowSnapshotRef}`);
}

export async function loadExecutionPlanByRefActivity(
  executionPlanRef: string,
  tenantId?: string,
): Promise<FlowExecutionPlan> {
  return classifyActivityFailure('loadExecutionPlanByRefActivity', async () => {
    const db = getProcessDb();
    const plan = await new FlowExecutionPlanRepository(db).getByRef(
      executionPlanRef,
      tenantId ? { tenantId } : {},
    );
    if (!plan) {
      throw ApplicationFailure.nonRetryable(
        `FlowExecutionPlan not found: ${executionPlanRef}`,
        'NOT_FOUND',
      );
    }
    return flowExecutionPlanSchema.parse(plan);
  });
}

export async function loadPiRuntimeConfigActivity(): Promise<PiRuntimeConfigActivityResult> {
  const config = loadConfig();
  return {
    max_segments_before_continue_as_new: config.PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW,
  };
}

function isProductionRuntime(config: ReturnType<typeof loadConfig>): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}

function createPiRuntime(input: {
  executionPlan: AgentExecutionPlan;
  agentRun: AgentRunRecord;
  segmentIndex: number;
  allowedModelIds?: Set<string>;
  db: ReturnType<typeof getProcessDb>;
}): {
  model: ReturnType<typeof createModelGatewayModel>;
  streamFn: Parameters<typeof runPiAgentSegment>[0]['streamFn'];
  cleanup?: () => void;
} {
  const config = loadConfig();
  if (isProductionRuntime(config) && config.PI_AGENT_MODE !== 'model_gateway') {
    throw new Error('PI_AGENT_MODE=model_gateway is required in production');
  }
  if (config.PI_AGENT_MODE === 'model_gateway') {
    const target = input.executionPlan.resolved_model_policy.resolved_targets[0];
    if (!target) {
      throw new Error(
        `ModelPolicy has no executable targets: ${input.executionPlan.model_policy_id}@${input.executionPlan.model_policy_version}`,
      );
    }
    return {
      model: createModelGatewayModel(target),
      streamFn: createModelGatewayPiStream({
        db: input.db,
        credentialMasterKey: config.MODEL_CREDENTIAL_MASTER_KEY,
        clientCacheTtlMs: config.MODEL_GATEWAY_CLIENT_CACHE_TTL_MS,
        executionPlan: input.executionPlan,
        agentRun: input.agentRun,
        segmentIndex: input.segmentIndex,
        timeoutMs: config.MODEL_GATEWAY_TIMEOUT_MS,
        maxRetries: config.MODEL_GATEWAY_MAX_RETRIES,
        maxResponseBytes: config.MODEL_GATEWAY_MAX_RESPONSE_BYTES,
        maxLedgerResponseBytes: config.MODEL_CALL_LEDGER_MAX_RESPONSE_BYTES,
        allowInsecureHttp: config.MODEL_GATEWAY_ALLOW_INSECURE_HTTP,
        idempotencyHeader: config.MODEL_GATEWAY_IDEMPOTENCY_HEADER,
        userAgent: config.MODEL_GATEWAY_USER_AGENT,
        ...(input.allowedModelIds ? { allowedModelIds: input.allowedModelIds } : {}),
      }),
    };
  }
  throw new Error('PI_AGENT_MODE must be model_gateway; app-local deterministic Pi is not available');
}

function decisionSummaryForSegment(segmentResult: PiSegmentResult): string {
  switch (segmentResult.status) {
    case 'completed':
      return segmentResult.final_answer
        ? segmentResult.final_answer.slice(0, 2000)
        : 'Pi segment completed';
    case 'tool_requested':
      return `Pi requested ${segmentResult.proposed_tool_calls.length} tool call(s)`;
    case 'user_input_required':
      return segmentResult.question.slice(0, 2000);
    case 'handoff_requested':
      return `Pi requested handoff to ${segmentResult.target_execution_plan_ref}`;
    case 'stopped_by_budget':
    case 'failed':
    case 'cancelled':
      return segmentResult.error_message.slice(0, 2000);
  }
}

function stepStatusForSegment(segmentResult: PiSegmentResult): AgentStepRecord['segment_status'] {
  switch (segmentResult.status) {
    case 'completed':
      return 'completed';
    case 'tool_requested':
      return 'waiting_tool';
    case 'user_input_required':
      return 'waiting_user';
    case 'handoff_requested':
      return 'handoff_started';
    case 'stopped_by_budget':
      return 'budget_exceeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function buildAgentToolIdempotencyKey(identity: AgentToolExecutionIdentity): string {
  return [
    'agent',
    sanitizeKeySegment(identity.agent_run_id),
    'segment',
    String(identity.segment_index),
    'call',
    sanitizeKeySegment(identity.call_id),
    identity.operation,
  ].join(':');
}

function sanitizeKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, '-');
}

async function classifyActivityFailure<T>(activityName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApplicationFailure || error instanceof CancelledFailure) {
      throw error;
    }
    const message = error instanceof Error ? error.message : `${activityName} failed`;
    const code = classifyErrorCode(message);
    if (code && NON_RETRYABLE_ERROR_CODES.has(code)) {
      throw ApplicationFailure.nonRetryable(message, code);
    }
    throw ApplicationFailure.retryable(message, activityName);
  }
}

function classifyErrorCode(message: string): string | undefined {
  if (
    /TENANT_POLICY_HASH_MISMATCH|EXECUTION_PLAN_HASH_MISMATCH|AGENT_MODEL_DENIED_BY_TENANT_POLICY|HANDOFF_DENIED_BY_TENANT_POLICY|TOOL_DENIED_BY_TENANT_POLICY|CONVERSATION_CONTEXT_HASH_MISMATCH|CONVERSATION_FINALIZATION_CONFLICT|CONVERSATION_MESSAGE_NOT_FOUND/u.test(
      message,
    )
  ) {
    return message.match(
      /TENANT_POLICY_HASH_MISMATCH|EXECUTION_PLAN_HASH_MISMATCH|AGENT_MODEL_DENIED_BY_TENANT_POLICY|HANDOFF_DENIED_BY_TENANT_POLICY|TOOL_DENIED_BY_TENANT_POLICY|CONVERSATION_CONTEXT_HASH_MISMATCH|CONVERSATION_FINALIZATION_CONFLICT|CONVERSATION_MESSAGE_NOT_FOUND/u,
    )?.[0];
  }
  if (/validation|invalid|schema|parse/iu.test(message)) {
    return 'VALIDATION_FAILED';
  }
  if (/unauthorized|forbidden|auth|permission/iu.test(message)) {
    return 'AUTH_FAILED';
  }
  if (/not found|unknown|missing/iu.test(message)) {
    return 'NOT_FOUND';
  }
  if (/policy|denied|rejected/iu.test(message)) {
    return 'POLICY_DENIED';
  }
  return undefined;
}

function heartbeatActivity(details: Record<string, unknown>): void {
  try {
    Context.current().heartbeat(details);
  } catch {
    // Activity functions are also invoked directly by unit tests; heartbeat only exists inside Temporal.
  }
}

function currentActivityAbortSignal(): AbortSignal | undefined {
  try {
    return Context.current().cancellationSignal;
  } catch {
    return undefined;
  }
}

function throwIfActivityCancelled(message: string): void {
  const signal = currentActivityAbortSignal();
  if (signal?.aborted) {
    throw new CancelledFailure(message, [signal.reason]);
  }
}

function conversationMessageToPiSeed(
  message: ReturnType<typeof conversationMessageSchema.parse>,
): Record<string, unknown> {
  if (message.role === 'user') {
    const seed: UserMessage = {
      role: 'user',
      content: message.content_text ?? '',
      timestamp: 0,
    };
    return seed as unknown as Record<string, unknown>;
  }
  const seed: AssistantMessage = {
    role: 'assistant',
    content: message.content_text
      ? [{ type: 'text', text: message.content_text }]
      : [],
    api: 'conversation-history',
    provider: 'conversation-history',
    model: 'conversation-history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  };
  return seed as unknown as Record<string, unknown>;
}

function hashConversationMessages(
  messages: Array<ReturnType<typeof conversationMessageSchema.parse>>,
): string {
  return createHash('sha256').update(
    JSON.stringify(
      messages.map((message) => ({
        message_id: message.message_id,
        sequence_no: message.sequence_no,
        role: message.role,
        content_text: message.content_text ?? '',
      })),
    ),
  ).digest('hex');
}

function startHeartbeatLoop(activity: string, details: Record<string, unknown>): { stop(): void } {
  let stopped = false;
  const tick = () => {
    if (stopped) {
      return;
    }
    heartbeatActivity({
      ...details,
      activity,
      phase: 'running',
    });
  };
  tick();
  const interval = setInterval(tick, 5_000);
  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
