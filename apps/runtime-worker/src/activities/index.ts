import {
  ApplicationFailure,
  CancelledFailure,
  Context,
} from '@temporalio/activity';
import {
  agentUsageSchema,
  effectiveTenantPolicySchema,
  piSegmentRequestSchema,
  piSegmentResultSchema,
  flowExecutionPlanSchema,
  flowSpecSchema,
  humanTaskCreateRequestSchema,
  toolCommitRequestSchema,
  toolInvokeRequestSchema,
  toolPreviewRequestSchema,
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
} from '@dar/contracts';
import { ToolGatewayClient } from '@dar/tool-client';
import type { UserMessage } from '@earendil-works/pi-ai';
import { getToolGatewayUrl, loadConfig } from '@dar/config';
import {
  AgentContextSnapshotRepository,
  AgentExecutionPlanRepository,
  AgentRunRepository,
  AgentStepRepository,
  AuditEventRepository,
  closeDb,
  createDb,
  FlowExecutionPlanRepository,
  FlowDefinitionRepository,
  HumanTaskRepository,
  parseDbFlowSnapshotRef,
  TaskRunRepository,
  TenantAgentAdmissionRepository,
  TenantRuntimePolicyResolver,
  TenantRuntimePolicySnapshotRepository,
  effectivePolicyFromSnapshot,
} from '@dar/db';
import { createDeterministicPiStream, type DeterministicPiScenario } from '../agent/deterministic-pi-stream.js';
import { createModelGatewayModel, createModelGatewayPiStream } from '../agent/model-gateway-pi-stream.js';
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
]);

const sampleFlowSpec: FlowSpec = {
  flow_id: 'sample_flow',
  version: 1,
  name: 'MVP sample flow',
  runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
  steps: [
    { id: 'input_normalize', type: 'activity', activity: 'input.normalize' },
    { id: 'knowledge_search', type: 'tool', tool: 'knowledge.search', tool_version: '1.0.0' },
    { id: 'agent_plan', type: 'agent', agent_id: 'sample_agent', input: { agent_version: 1 } },
    { id: 'record_write', type: 'tool', tool: 'record.write.mock', tool_version: '1.0.0', risk_level: 'L3' },
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

function createToolGatewayClient(config = loadConfig()): ToolGatewayClient {
  return new ToolGatewayClient({
    baseUrl: getToolGatewayUrl(config),
    serviceIdentity: {
      serviceId: 'runtime-worker',
      ...(config.RUNTIME_WORKER_TOOL_GATEWAY_TOKEN ? { token: config.RUNTIME_WORKER_TOOL_GATEWAY_TOKEN } : {}),
    },
  });
}

export interface ActivityContext {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id: string;
  request_id: string;
  execution_plan_ref?: string;
  execution_plan_hash?: string;
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
  status: 'running' | 'waiting_human' | 'completed' | 'failed';
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
  throw new Error(`runAgentActivity is deprecated; use piDurableAgentWorkflow with agent_execution_plan_ref for ${agent.agent_id}@${agent.agent_version}`);
}

export async function loadAgentExecutionPlanByRefActivity(
  executionPlanRef: string,
  tenantId?: string,
): Promise<AgentExecutionPlan> {
  return classifyActivityFailure('loadAgentExecutionPlanByRefActivity', async () => {
    const plan = await new AgentExecutionPlanRepository(getProcessDb()).getByRef(executionPlanRef, tenantId ? { tenantId } : {});
    if (!plan) {
      throw ApplicationFailure.nonRetryable(`AgentExecutionPlan not found: ${executionPlanRef}`, 'NOT_FOUND');
    }
    return plan;
  });
}

export async function loadTenantPolicySnapshotActivity(
  input: LoadTenantPolicySnapshotActivityInput,
): Promise<EffectiveTenantPolicy> {
  return classifyActivityFailure('loadTenantPolicySnapshotActivity', async () => {
    if (!input.tenant_policy_snapshot_ref || !input.tenant_policy_hash) {
      throw ApplicationFailure.nonRetryable('Tenant policy snapshot identity is required', 'POLICY_DENIED');
    }
    const snapshot = await new TenantRuntimePolicySnapshotRepository(getProcessDb()).getByRef(
      input.tenant_policy_snapshot_ref,
      { tenantId: input.tenant_id },
    );
    if (!snapshot) {
      throw ApplicationFailure.nonRetryable('Tenant policy snapshot not found', 'NOT_FOUND');
    }
    if (snapshot.snapshot_hash !== input.tenant_policy_hash) {
      throw ApplicationFailure.nonRetryable('TENANT_POLICY_HASH_MISMATCH', 'TENANT_POLICY_HASH_MISMATCH');
    }
    if (
      snapshot.execution_plan_ref !== input.execution_plan_ref
      || snapshot.execution_plan_hash !== input.execution_plan_hash
      || snapshot.execution_plan_type !== input.execution_plan_type
    ) {
      throw ApplicationFailure.nonRetryable('EXECUTION_PLAN_HASH_MISMATCH', 'EXECUTION_PLAN_HASH_MISMATCH');
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

export async function createAgentRunActivity(input: CreateAgentRunActivityInput): Promise<AgentRunRecord> {
  return classifyActivityFailure('createAgentRunActivity', async () => {
    const db = getProcessDb();
    const executionPlan = await new AgentExecutionPlanRepository(db).getByRef(input.execution_plan_ref, {
      tenantId: input.tenant_id,
    });
    if (!executionPlan) {
      throw ApplicationFailure.nonRetryable(`AgentExecutionPlan not found: ${input.execution_plan_ref}`, 'NOT_FOUND');
    }
    const policySnapshot = input.tenant_policy_snapshot_ref
      ? await new TenantRuntimePolicySnapshotRepository(db).getByRef(input.tenant_policy_snapshot_ref, { tenantId: input.tenant_id })
      : undefined;
    if (input.tenant_policy_snapshot_ref && !policySnapshot) {
      throw ApplicationFailure.nonRetryable('Tenant policy snapshot not found', 'NOT_FOUND');
    }
    if (policySnapshot && input.tenant_policy_hash && policySnapshot.snapshot_hash !== input.tenant_policy_hash) {
      throw ApplicationFailure.nonRetryable('TENANT_POLICY_HASH_MISMATCH', 'TENANT_POLICY_HASH_MISMATCH');
    }
    if (policySnapshot && (
      policySnapshot.execution_plan_ref !== executionPlan.execution_plan_ref
      || policySnapshot.execution_plan_hash !== executionPlan.execution_plan_hash
      || policySnapshot.execution_plan_type !== 'agent'
    )) {
      throw ApplicationFailure.nonRetryable('EXECUTION_PLAN_HASH_MISMATCH', 'EXECUTION_PLAN_HASH_MISMATCH');
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
      await new TenantAgentAdmissionRepository(db).attachAgentRun(input.tenant_admission_id, agentRun.agent_run_id);
    }
    await new AgentRunRepository(db).update(agentRun.agent_run_id, { status: 'running' });
    return agentRun;
  });
}

export async function updateAgentRunActivity(input: UpdateAgentRunActivityInput): Promise<AgentRunRecord> {
  return classifyActivityFailure('updateAgentRunActivity', async () => {
    const updated = await new AgentRunRepository(getProcessDb()).update(input.agent_run_id, {
      ...(input.status ? { status: input.status } : {}),
      ...(input.workflow_run_id !== undefined ? { workflowRunId: input.workflow_run_id } : {}),
      ...(input.current_segment_index !== undefined ? { currentSegmentIndex: input.current_segment_index } : {}),
      ...(input.model_turn_count !== undefined ? { modelTurnCount: input.model_turn_count } : {}),
      ...(input.tool_call_count !== undefined ? { toolCallCount: input.tool_call_count } : {}),
      ...(input.handoff_count !== undefined ? { handoffCount: input.handoff_count } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
      ...(input.error_code !== undefined ? { errorCode: input.error_code } : {}),
      ...(input.error_message !== undefined ? { errorMessage: input.error_message } : {}),
    });
    if (!updated) {
      throw ApplicationFailure.nonRetryable(`AgentRun not found: ${input.agent_run_id}`, 'NOT_FOUND');
    }
    return updated;
  });
}

export async function runPiSegmentActivity(request: PiSegmentRequest): Promise<PiSegmentResult> {
  return classifyActivityFailure('runPiSegmentActivity', async () => {
    const parsed = piSegmentRequestSchema.parse(request);
    const db = getProcessDb();
    heartbeatActivity({ activity: 'runPiSegmentActivity', phase: 'load_execution_plan', segment_index: parsed.segment_index });
    const executionPlan = await new AgentExecutionPlanRepository(db).getByRef(
      parsed.execution_plan_ref,
      { tenantId: parsed.request_context.tenant_id },
    );
    if (!executionPlan) {
      throw ApplicationFailure.nonRetryable(`AgentExecutionPlan not found: ${parsed.execution_plan_ref}`, 'NOT_FOUND');
    }
    const agentRun = await new AgentRunRepository(db).get(parsed.agent_run_id, {
      tenantId: parsed.request_context.tenant_id,
    });
    if (!agentRun) {
      throw ApplicationFailure.nonRetryable(`AgentRun not found: ${parsed.agent_run_id}`, 'NOT_FOUND');
    }
    if (agentRun.execution_plan_hash !== executionPlan.execution_plan_hash) {
      throw ApplicationFailure.nonRetryable(`AgentRun execution plan hash mismatch: ${parsed.agent_run_id}`, 'VALIDATION_FAILED');
    }

    heartbeatActivity({ activity: 'runPiSegmentActivity', phase: 'load_context', segment_index: parsed.segment_index });
    const snapshot = parsed.context_snapshot_ref
      ? await new AgentContextSnapshotRepository(db).get(parsed.context_snapshot_ref.snapshot_id)
      : undefined;
    if (parsed.context_snapshot_ref && !snapshot) {
      throw ApplicationFailure.nonRetryable(`Pi context snapshot not found: ${parsed.context_snapshot_ref.snapshot_id}`, 'NOT_FOUND');
    }

    const piRuntime = createPiRuntime(executionPlan.model_policy);
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
      if (parsed.initial_user_input) {
        adapterInput.initialUserInput = parsed.initial_user_input;
      }
      heartbeatActivity({ activity: 'runPiSegmentActivity', phase: 'pi_agent_start', segment_index: parsed.segment_index });
      const adapterResult = await runPiAgentSegment(adapterInput);
      throwIfActivityCancelled('runPiSegmentActivity cancelled after Pi segment');
      heartbeatActivity({ activity: 'runPiSegmentActivity', phase: 'persist_context', segment_index: parsed.segment_index });
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
        proposed_tool_calls: segmentResult.status === 'tool_requested' ? segmentResult.proposed_tool_calls : [],
        tool_result_refs: [],
        authoritative_tool_result_refs: [],
        human_task_ids: [],
        context_snapshot_before: parsed.context_snapshot_ref,
        context_snapshot_after: snapshotRef,
        handoff_refs: [],
        context_snapshot_ref: snapshotRef,
        usage: segmentResult.usage,
        ...(segmentResult.status === 'failed' || segmentResult.status === 'stopped_by_budget' || segmentResult.status === 'cancelled'
          ? {
              error_code: segmentResult.error_code,
              error_message: segmentResult.error_message,
            }
          : {}),
      });
      heartbeatActivity({ activity: 'runPiSegmentActivity', phase: 'completed', segment_index: parsed.segment_index });
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
    const snapshot = await new AgentContextSnapshotRepository(db).get(input.previous_context_snapshot_ref.snapshot_id);
    if (!snapshot) {
      throw ApplicationFailure.nonRetryable(`Pi context snapshot not found: ${input.previous_context_snapshot_ref.snapshot_id}`, 'NOT_FOUND');
    }
    const restoredMessages = restorePiMessages({ schema_version: PI_CONTEXT_SCHEMA_VERSION, messages: snapshot.messages });
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
    const snapshot = await new AgentContextSnapshotRepository(db).get(input.previous_context_snapshot_ref.snapshot_id);
    if (!snapshot) {
      throw ApplicationFailure.nonRetryable(`Pi context snapshot not found: ${input.previous_context_snapshot_ref.snapshot_id}`, 'NOT_FOUND');
    }
    const restoredMessages = restorePiMessages({ schema_version: PI_CONTEXT_SCHEMA_VERSION, messages: snapshot.messages });
    const userMessage: UserMessage = {
      role: 'user',
      content: [{
        type: 'text',
        text: `Human task ${input.human_task_id} response: ${JSON.stringify(input.response)}`,
      }],
      timestamp: 0,
    };
    const messages = [
      ...restoredMessages,
      userMessage,
    ];
    const serialized = serializePiContext(messages, { maxBytes: input.max_context_bytes });
    return new AgentContextSnapshotRepository(db).create({
      agentRunId: input.agent_run_id,
      previousSnapshotId: input.previous_context_snapshot_ref.snapshot_id,
      schemaVersion: PI_CONTEXT_SCHEMA_VERSION,
      sanitizedMessages: serialized.messages,
    });
  });
}

export async function updateAgentStepActivity(input: UpdateAgentStepActivityInput): Promise<AgentStepRecord> {
  return classifyActivityFailure('updateAgentStepActivity', async () =>
    new AgentStepRepository(getProcessDb()).updateBoundaryResult({
      stableStepKey: input.stable_step_key,
      ...(input.segment_status ? { segmentStatus: input.segment_status } : {}),
      ...(input.decision_summary !== undefined ? { decisionSummary: input.decision_summary } : {}),
      ...(input.proposed_tool_calls !== undefined ? { proposedToolCalls: input.proposed_tool_calls } : {}),
      ...(input.tool_result_refs !== undefined ? { toolResultRefs: input.tool_result_refs } : {}),
      ...(input.authoritative_tool_result_refs !== undefined ? { authoritativeToolResultRefs: input.authoritative_tool_result_refs } : {}),
      ...(input.human_task_ids !== undefined ? { humanTaskIds: input.human_task_ids } : {}),
      ...(input.context_snapshot_before !== undefined ? { contextSnapshotBefore: input.context_snapshot_before } : {}),
      ...(input.context_snapshot_after !== undefined ? { contextSnapshotAfter: input.context_snapshot_after } : {}),
      ...(input.context_snapshot_ref !== undefined ? { contextSnapshotRef: input.context_snapshot_ref } : {}),
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
    await new TaskRunRepository(db).updateStatus(context.task_run_id, { status: 'waiting_human' });
    await new AuditEventRepository(db).append({
      tenant_id: context.tenant_id,
      actor_id: context.user_id,
      action: 'human_task.create',
      target_type: 'human_task',
      target_id: humanTask.human_task_id,
      result: 'pending',
      reason: input.kind === 'user_input' ? 'agent_user_input_required' : 'l3_tool_confirmation_required',
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
    heartbeatActivity({ activity: 'invokeToolActivity', phase: 'before_request', tool_name: tool.tool_name });
    const config = loadConfig();
    const client = createToolGatewayClient(config);
    const result = await client.invoke(toolInvokeRequestSchema.parse({
      tool_name: tool.tool_name,
      tool_version: tool.tool_version,
      tool_sha256: tool.tool_sha256,
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
	      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
	      arguments: args,
	      idempotency_key: identity ? buildAgentToolIdempotencyKey(identity) : `${context.task_run_id}:${tool.tool_name}`,
	      risk_level: tool.risk_level,
	      ...(context.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: context.tenant_policy_snapshot_ref } : {}),
	      ...(context.tenant_policy_hash ? { tenant_policy_hash: context.tenant_policy_hash } : {}),
	      ...(context.execution_plan_ref ? { execution_plan_ref: context.execution_plan_ref } : {}),
	      ...(context.execution_plan_hash ? { execution_plan_hash: context.execution_plan_hash } : {}),
	      request_id: context.request_id,
	    }));
    heartbeatActivity({ activity: 'invokeToolActivity', phase: 'after_request', tool_name: tool.tool_name, status: result.status });
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
    heartbeatActivity({ activity: 'previewToolActivity', phase: 'before_request', tool_name: tool.tool_name });
    const config = loadConfig();
    const client = createToolGatewayClient(config);
    const result = await client.preview(toolPreviewRequestSchema.parse({
      tool_name: tool.tool_name,
      tool_version: tool.tool_version,
      tool_sha256: tool.tool_sha256,
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
	      arguments: args,
	      idempotency_key: identity ? buildAgentToolIdempotencyKey(identity) : `${context.task_run_id}:${tool.tool_name}:preview`,
	      risk_level: tool.risk_level,
	      ...(context.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: context.tenant_policy_snapshot_ref } : {}),
	      ...(context.tenant_policy_hash ? { tenant_policy_hash: context.tenant_policy_hash } : {}),
	      ...(context.execution_plan_ref ? { execution_plan_ref: context.execution_plan_ref } : {}),
	      ...(context.execution_plan_hash ? { execution_plan_hash: context.execution_plan_hash } : {}),
	      request_id: context.request_id,
	    }));
    heartbeatActivity({ activity: 'previewToolActivity', phase: 'after_request', tool_name: tool.tool_name, status: result.status });
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
    heartbeatActivity({ activity: 'commitToolActivity', phase: 'before_request', tool_name: tool.tool_name, tool_call_id: toolCallId });
    const config = loadConfig();
    const client = createToolGatewayClient(config);
    const result = await client.commit(toolCommitRequestSchema.parse({
      tool_call_id: toolCallId,
      tool_name: tool.tool_name,
      tool_version: tool.tool_version,
      tool_sha256: tool.tool_sha256,
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
	      arguments: args,
	      idempotency_key: identity ? buildAgentToolIdempotencyKey(identity) : `${context.task_run_id}:${tool.tool_name}:commit:${toolCallId}`,
	      ...(context.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: context.tenant_policy_snapshot_ref } : {}),
	      ...(context.tenant_policy_hash ? { tenant_policy_hash: context.tenant_policy_hash } : {}),
	      ...(context.execution_plan_ref ? { execution_plan_ref: context.execution_plan_ref } : {}),
	      ...(context.execution_plan_hash ? { execution_plan_hash: context.execution_plan_hash } : {}),
	      request_id: context.request_id,
	    }));
    heartbeatActivity({ activity: 'commitToolActivity', phase: 'after_request', tool_name: tool.tool_name, tool_call_id: toolCallId, status: result.status });
    return result;
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
      throw ApplicationFailure.nonRetryable(`TaskRun not found for status update: ${input.task_run_id}`, 'NOT_FOUND');
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
    const flowSpec = await new FlowDefinitionRepository(db).getPublished(dbRef.flowId, dbRef.version);
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

export async function loadExecutionPlanByRefActivity(executionPlanRef: string, tenantId?: string): Promise<FlowExecutionPlan> {
  return classifyActivityFailure('loadExecutionPlanByRefActivity', async () => {
    const db = getProcessDb();
    const plan = await new FlowExecutionPlanRepository(db).getByRef(executionPlanRef, tenantId ? { tenantId } : {});
    if (!plan) {
      throw ApplicationFailure.nonRetryable(`FlowExecutionPlan not found: ${executionPlanRef}`, 'NOT_FOUND');
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

function createPiRuntime(modelPolicy: string): {
  model: ReturnType<typeof createModelGatewayModel>;
  streamFn: Parameters<typeof runPiAgentSegment>[0]['streamFn'];
  cleanup?: () => void;
} {
  const config = loadConfig();
  if (isProductionRuntime(config) && config.PI_AGENT_MODE !== 'model_gateway') {
    throw new Error('PI_AGENT_MODE=model_gateway is required in production');
  }
  if (config.PI_AGENT_MODE === 'deterministic') {
    if (isProductionRuntime(config)) {
      throw new Error('PI_AGENT_MODE=deterministic is not allowed in production');
    }
    const deterministic = createDeterministicPiStream(parseDeterministicScenario(modelPolicy));
    return {
      model: deterministic.model,
      streamFn: deterministic.streamFn,
      cleanup: deterministic.unregister,
    };
  }
  if (config.PI_AGENT_MODE === 'model_gateway') {
    return {
      model: createModelGatewayModel(config.MODEL_GATEWAY_MODEL),
      streamFn: createModelGatewayPiStream({
        baseUrl: config.MODEL_GATEWAY_BASE_URL,
        apiKey: config.MODEL_GATEWAY_API_KEY,
        model: config.MODEL_GATEWAY_MODEL,
        timeoutMs: config.MODEL_GATEWAY_TIMEOUT_MS,
        maxRetries: config.MODEL_GATEWAY_MAX_RETRIES,
      }),
    };
  }
  throw new Error('PI_AGENT_MODE is disabled; agent execution is not available');
}

function parseDeterministicScenario(modelPolicy: string): DeterministicPiScenario {
  const match = /^deterministic:(.+)$/u.exec(modelPolicy);
  if (!match?.[1]) {
    throw new Error(`Deterministic Pi mode requires model_policy=deterministic:<scenario>, got ${modelPolicy}`);
  }
  const scenario = match[1];
  if (isDeterministicScenario(scenario)) {
    return scenario;
  }
  throw new Error(`Unsupported deterministic Pi scenario: ${scenario}`);
}

function isDeterministicScenario(value: string): value is DeterministicPiScenario {
  return [
    'final_only',
    'readonly_tool',
    'l3_tool',
    'need_user',
    'handoff',
    'repeated_tool',
    'endless_turns',
    'excessive_tokens',
    'invalid_tool',
    'l4_tool',
    'malformed_output',
    'stream_error',
    'aborted',
  ].includes(value);
}

function decisionSummaryForSegment(segmentResult: PiSegmentResult): string {
  switch (segmentResult.status) {
    case 'completed':
      return segmentResult.final_answer ? segmentResult.final_answer.slice(0, 2000) : 'Pi segment completed';
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

async function classifyActivityFailure<T>(
  activityName: string,
  fn: () => Promise<T>,
): Promise<T> {
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
  if (/TENANT_POLICY_HASH_MISMATCH|EXECUTION_PLAN_HASH_MISMATCH|AGENT_MODEL_DENIED_BY_TENANT_POLICY|HANDOFF_DENIED_BY_TENANT_POLICY|TOOL_DENIED_BY_TENANT_POLICY/u.test(message)) {
    return message.match(/TENANT_POLICY_HASH_MISMATCH|EXECUTION_PLAN_HASH_MISMATCH|AGENT_MODEL_DENIED_BY_TENANT_POLICY|HANDOFF_DENIED_BY_TENANT_POLICY|TOOL_DENIED_BY_TENANT_POLICY/u)?.[0];
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
