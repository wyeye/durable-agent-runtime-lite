import {
  agentRunRequestSchema,
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
  type FlowSpec,
  type HumanTask,
  type ToolCommitResponse,
  type ToolInvokeResponse,
  type ToolPreviewResponse,
} from '@dar/contracts';
import { ToolGatewayClient } from '@dar/tool-client';
import { getToolGatewayUrl, loadConfig } from '@dar/config';
import {
  AuditEventRepository,
  closeDb,
  createDb,
  FlowExecutionPlanRepository,
  FlowDefinitionRepository,
  HumanTaskRepository,
  parseDbFlowSnapshotRef,
  TaskRunRepository,
} from '@dar/db';
import { runPiAgent } from '../pi/pi-runner.js';

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
  tool_call_id?: string;
  tool_name?: string;
  assignee?: string;
  candidate_groups?: string[];
  payload?: Record<string, unknown>;
}

export interface UpdateTaskRunStatusActivityInput extends ActivityContext {
  status: 'running' | 'waiting_human' | 'completed' | 'failed';
  error_code?: string;
  error_message?: string;
}

export async function normalizeInput(input: unknown): Promise<Record<string, unknown>> {
  return { normalized: true, input };
}

export async function runAgentActivity(
  context: ActivityContext,
  agent: FlowExecutionPlanAgent,
  input: Record<string, unknown>,
): Promise<AgentRunResult> {
  return runPiAgent(
    agentRunRequestSchema.parse({
      tenant_id: context.tenant_id,
      user_id: context.user_id,
      task_run_id: context.task_run_id,
      workflow_id: context.workflow_id,
      agent_id: agent.agent_id,
      agent_version: agent.agent_version,
      prompt_ref: `${agent.prompt_id}@${agent.prompt_version}`,
      model_policy: agent.model_policy,
      input,
      allowed_tools: agent.allowed_tools,
      max_steps: agent.budget.max_steps,
      max_tokens: agent.budget.max_tokens,
      request_id: context.request_id,
    }),
  );
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
      tool_call_id: input.tool_call_id,
      tool_name: input.tool_name,
      assignee: input.assignee,
      candidate_groups: input.candidate_groups ?? [],
      payload: input.payload ?? {},
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
    reason: 'l3_tool_confirmation_required',
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
