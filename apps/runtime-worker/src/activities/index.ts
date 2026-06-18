import {
  agentBudgetSchema,
  agentUsageSchema,
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

export interface ActivityContext {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id: string;
  request_id: string;
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
  execution_plan_ref: string;
  parent_workflow_id?: string;
  execution_mode?: 'answer_only' | 'plan_only' | 'mediated_tool_call';
}

export interface UpdateAgentRunActivityInput {
  agent_run_id: string;
  status?: AgentRunRecord['status'];
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
  request_context: ActivityContext;
}

export interface AppendUserInputActivityInput {
  agent_run_id: string;
  previous_context_snapshot_ref: PiContextSnapshotRef;
  human_task_id: string;
  response: Record<string, unknown>;
  responded_by: string;
  request_context: ActivityContext;
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
  const plan = await new AgentExecutionPlanRepository(getProcessDb()).getByRef(executionPlanRef, tenantId ? { tenantId } : {});
  if (!plan) {
    throw new Error(`AgentExecutionPlan not found: ${executionPlanRef}`);
  }
  return plan;
}

export async function createAgentRunActivity(input: CreateAgentRunActivityInput): Promise<AgentRunRecord> {
  const db = getProcessDb();
  const executionPlan = await new AgentExecutionPlanRepository(db).getByRef(input.execution_plan_ref, {
    tenantId: input.tenant_id,
  });
  if (!executionPlan) {
    throw new Error(`AgentExecutionPlan not found: ${input.execution_plan_ref}`);
  }
  const agentRun = await new AgentRunRepository(db).create({
    tenantId: input.tenant_id,
    userId: input.user_id,
    taskRunId: input.task_run_id,
    workflowId: input.workflow_id,
    ...(input.parent_workflow_id ? { parentWorkflowId: input.parent_workflow_id } : {}),
    executionMode: input.execution_mode ?? 'mediated_tool_call',
    executionPlan,
  });
  await new AgentRunRepository(db).update(agentRun.agent_run_id, { status: 'running' });
  return agentRun;
}

export async function updateAgentRunActivity(input: UpdateAgentRunActivityInput): Promise<AgentRunRecord> {
  const updated = await new AgentRunRepository(getProcessDb()).update(input.agent_run_id, {
    ...(input.status ? { status: input.status } : {}),
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
    throw new Error(`AgentRun not found: ${input.agent_run_id}`);
  }
  return updated;
}

export async function runPiSegmentActivity(request: PiSegmentRequest): Promise<PiSegmentResult> {
  const parsed = piSegmentRequestSchema.parse(request);
  const db = getProcessDb();
  const executionPlan = await new AgentExecutionPlanRepository(db).getByRef(
    parsed.execution_plan_ref,
    { tenantId: parsed.request_context.tenant_id },
  );
  if (!executionPlan) {
    throw new Error(`AgentExecutionPlan not found: ${parsed.execution_plan_ref}`);
  }
  const agentRun = await new AgentRunRepository(db).get(parsed.agent_run_id, {
    tenantId: parsed.request_context.tenant_id,
  });
  if (!agentRun) {
    throw new Error(`AgentRun not found: ${parsed.agent_run_id}`);
  }
  if (agentRun.execution_plan_hash !== executionPlan.execution_plan_hash) {
    throw new Error(`AgentRun execution plan hash mismatch: ${parsed.agent_run_id}`);
  }

  const snapshot = parsed.context_snapshot_ref
    ? await new AgentContextSnapshotRepository(db).get(parsed.context_snapshot_ref.snapshot_id)
    : undefined;
  if (parsed.context_snapshot_ref && !snapshot) {
    throw new Error(`Pi context snapshot not found: ${parsed.context_snapshot_ref.snapshot_id}`);
  }

  const piRuntime = createPiRuntime(executionPlan.model_policy);
  try {
    const adapterInput: Parameters<typeof runPiAgentSegment>[0] = {
      executionPlan,
      model: piRuntime.model,
      streamFn: piRuntime.streamFn,
      segmentIndex: parsed.segment_index,
      budgetRemaining: parsed.budget_remaining,
      maxContextBytes: parsed.budget_remaining.max_context_bytes,
    };
    if (snapshot?.messages) {
      adapterInput.contextMessages = snapshot.messages;
    }
    if (parsed.initial_user_input) {
      adapterInput.initialUserInput = parsed.initial_user_input;
    }
    const adapterResult = await runPiAgentSegment(adapterInput);
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
      segment_status: segmentResult.status,
      decision_summary: decisionSummaryForSegment(segmentResult),
      proposed_tool_calls: segmentResult.status === 'tool_requested' ? segmentResult.proposed_tool_calls : [],
      tool_result_refs: [],
      context_snapshot_ref: snapshotRef,
      usage: segmentResult.usage,
      ...(segmentResult.status === 'failed' || segmentResult.status === 'stopped_by_budget' || segmentResult.status === 'cancelled'
        ? {
            error_code: segmentResult.error_code,
            error_message: segmentResult.error_message,
          }
        : {}),
    });
    return segmentResult;
  } finally {
    piRuntime.cleanup?.();
  }
}

export async function persistToolResultsToPiContextActivity(
  input: PersistToolResultsActivityInput,
): Promise<PiContextSnapshotRef> {
  const db = getProcessDb();
  const snapshot = await new AgentContextSnapshotRepository(db).get(input.previous_context_snapshot_ref.snapshot_id);
  if (!snapshot) {
    throw new Error(`Pi context snapshot not found: ${input.previous_context_snapshot_ref.snapshot_id}`);
  }
  const restoredMessages = restorePiMessages({ schema_version: PI_CONTEXT_SCHEMA_VERSION, messages: snapshot.messages });
  const replaced = replaceDeferredToolResults(restoredMessages, input.tool_results, {
    maxBytes: agentBudgetSchema.parse({}).max_context_bytes,
  });
  return new AgentContextSnapshotRepository(db).create({
    agentRunId: input.agent_run_id,
    previousSnapshotId: input.previous_context_snapshot_ref.snapshot_id,
    schemaVersion: PI_CONTEXT_SCHEMA_VERSION,
    sanitizedMessages: replaced.messages,
  });
}

export async function appendUserInputToPiContextActivity(
  input: AppendUserInputActivityInput,
): Promise<PiContextSnapshotRef> {
  const db = getProcessDb();
  const snapshot = await new AgentContextSnapshotRepository(db).get(input.previous_context_snapshot_ref.snapshot_id);
  if (!snapshot) {
    throw new Error(`Pi context snapshot not found: ${input.previous_context_snapshot_ref.snapshot_id}`);
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
  const serialized = serializePiContext(messages, { maxBytes: agentBudgetSchema.parse({}).max_context_bytes });
  return new AgentContextSnapshotRepository(db).create({
    agentRunId: input.agent_run_id,
    previousSnapshotId: input.previous_context_snapshot_ref.snapshot_id,
    schemaVersion: PI_CONTEXT_SCHEMA_VERSION,
    sanitizedMessages: serialized.messages,
  });
}

export async function invokeToolActivity(
  context: ActivityContext,
  tool: FlowExecutionPlanTool,
  args: Record<string, unknown>,
): Promise<ToolInvokeResponse> {
  const config = loadConfig();
  const client = new ToolGatewayClient({ baseUrl: getToolGatewayUrl(config) });
  return client.invoke(
    toolInvokeRequestSchema.parse({
      tool_name: tool.tool_name,
      tool_version: tool.tool_version,
      tool_sha256: tool.tool_sha256,
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
      arguments: args,
      idempotency_key: `${context.task_run_id}:${tool.tool_name}`,
      risk_level: tool.risk_level,
      request_id: context.request_id,
    }),
  );
}

export async function previewToolActivity(
  context: ActivityContext,
  tool: FlowExecutionPlanTool,
  args: Record<string, unknown>,
): Promise<ToolPreviewResponse> {
  const config = loadConfig();
  const client = new ToolGatewayClient({ baseUrl: getToolGatewayUrl(config) });
  return client.preview(
    toolPreviewRequestSchema.parse({
      tool_name: tool.tool_name,
      tool_version: tool.tool_version,
      tool_sha256: tool.tool_sha256,
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
      arguments: args,
      idempotency_key: `${context.task_run_id}:${tool.tool_name}:preview`,
      risk_level: tool.risk_level,
      request_id: context.request_id,
    }),
  );
}

export async function commitToolActivity(
  context: ActivityContext,
  toolCallId: string,
  tool: FlowExecutionPlanTool,
  args: Record<string, unknown>,
): Promise<ToolCommitResponse> {
  const config = loadConfig();
  const client = new ToolGatewayClient({ baseUrl: getToolGatewayUrl(config) });
  return client.commit(
    toolCommitRequestSchema.parse({
      tool_call_id: toolCallId,
      tool_name: tool.tool_name,
      tool_version: tool.tool_version,
      tool_sha256: tool.tool_sha256,
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
      arguments: args,
      idempotency_key: `${context.task_run_id}:${tool.tool_name}:commit:${toolCallId}`,
      request_id: context.request_id,
    }),
  );
}

export async function createHumanTaskActivity(
  context: ActivityContext,
  input: CreateHumanTaskActivityInput = {},
): Promise<HumanTask> {
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
}

export async function loadFlowSpecActivity(flowSpec: FlowSpec): Promise<FlowSpec> {
  return flowSpec;
}

export async function updateTaskRunStatusActivity(
  input: UpdateTaskRunStatusActivityInput,
): Promise<void> {
  const db = getProcessDb();
  const updated = await new TaskRunRepository(db).updateStatus(input.task_run_id, {
    status: input.status,
    ...(input.error_code ? { errorCode: input.error_code } : {}),
    ...(input.error_message ? { errorMessage: input.error_message } : {}),
  });
  if (!updated) {
    throw new Error(`TaskRun not found for status update: ${input.task_run_id}`);
  }
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

export async function loadExecutionPlanByRefActivity(executionPlanRef: string): Promise<FlowExecutionPlan> {
  const db = getProcessDb();
  const plan = await new FlowExecutionPlanRepository(db).getByRef(executionPlanRef);
  if (!plan) {
    throw new Error(`FlowExecutionPlan not found: ${executionPlanRef}`);
  }
  return flowExecutionPlanSchema.parse(plan);
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
