import { setTimeout as sleep } from 'node:timers/promises';
import {
  agentRunRequestSchema,
  flowSpecSchema,
  humanTaskCreateRequestSchema,
  toolCommitRequestSchema,
  toolInvokeRequestSchema,
  toolPreviewRequestSchema,
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
    { id: 'knowledge_search', type: 'tool', tool: 'knowledge.search' },
    { id: 'agent_plan', type: 'agent', agent_id: 'sample_agent' },
    { id: 'record_write', type: 'tool', tool: 'record.write.mock', risk_level: 'L3' },
  ],
};

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
  agentId: string,
  input: Record<string, unknown>,
  allowedTools: string[] = ['knowledge.search', 'record.write.mock'],
): Promise<AgentRunResult> {
  return runPiAgent(
    agentRunRequestSchema.parse({
      tenant_id: context.tenant_id,
      user_id: context.user_id,
      task_run_id: context.task_run_id,
      workflow_id: context.workflow_id,
      agent_id: agentId,
      input,
      allowed_tools: allowedTools,
      request_id: context.request_id,
    }),
  );
}

export async function invokeToolActivity(
  context: ActivityContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolInvokeResponse> {
  const config = loadConfig();
  const client = new ToolGatewayClient({ baseUrl: getToolGatewayUrl(config) });
  return client.invoke(
    toolInvokeRequestSchema.parse({
      tool_name: toolName,
      tool_version: '1.0.0',
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
      arguments: args,
      idempotency_key: `${context.task_run_id}:${toolName}`,
      request_id: context.request_id,
    }),
  );
}

export async function previewToolActivity(
  context: ActivityContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolPreviewResponse> {
  const config = loadConfig();
  const client = new ToolGatewayClient({ baseUrl: getToolGatewayUrl(config) });
  return client.preview(
    toolPreviewRequestSchema.parse({
      tool_name: toolName,
      tool_version: '1.0.0',
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
      arguments: args,
      idempotency_key: `${context.task_run_id}:${toolName}:preview`,
      request_id: context.request_id,
    }),
  );
}

export async function commitToolActivity(
  context: ActivityContext,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolCommitResponse> {
  const config = loadConfig();
  const client = new ToolGatewayClient({ baseUrl: getToolGatewayUrl(config) });
  return client.commit(
    toolCommitRequestSchema.parse({
      tool_call_id: toolCallId,
      tool_name: toolName,
      tool_version: '1.0.0',
      tenant_id: context.tenant_id,
      user_context: { user_id: context.user_id },
      task_context: { task_run_id: context.task_run_id, workflow_id: context.workflow_id },
      arguments: args,
      idempotency_key: `${context.task_run_id}:${toolName}:commit:${toolCallId}`,
      request_id: context.request_id,
    }),
  );
}

export async function createHumanTaskActivity(
  context: ActivityContext,
  input: CreateHumanTaskActivityInput = {},
): Promise<HumanTask> {
  const config = loadConfig();
  const db = createDb({ databaseUrl: config.DATABASE_URL });
  try {
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
  } finally {
    await closeDb(db);
  }
}

export async function waitForHumanTaskDecisionActivity(
  context: ActivityContext,
  humanTaskId: string,
): Promise<HumanTask> {
  const config = loadConfig();
  const db = createDb({ databaseUrl: config.DATABASE_URL });
  const repository = new HumanTaskRepository(db);
  try {
    const deadline = Date.now() + 5 * 60 * 1000;
    let lastTask: HumanTask | undefined;
    while (Date.now() < deadline) {
      const task = await repository.get(humanTaskId);
      if (!task) {
        throw new Error(`HumanTask not found: ${humanTaskId}`);
      }
      if (task.tenant_id !== context.tenant_id || task.task_run_id !== context.task_run_id) {
        throw new Error(`HumanTask context mismatch: ${humanTaskId}`);
      }
      lastTask = task;
      if (task.status === 'approved' || task.status === 'rejected' || task.status === 'cancelled' || task.status === 'expired') {
        await new TaskRunRepository(db).updateStatus(context.task_run_id, { status: 'running' });
        return task;
      }
      await sleep(1000);
    }
    throw new Error(`HumanTask decision timed out: ${lastTask?.human_task_id ?? humanTaskId}`);
  } finally {
    await closeDb(db);
  }
}

export async function loadFlowSpecActivity(flowSpec: FlowSpec): Promise<FlowSpec> {
  return flowSpec;
}

export async function updateTaskRunStatusActivity(
  input: UpdateTaskRunStatusActivityInput,
): Promise<void> {
  const config = loadConfig();
  const db = createDb({ databaseUrl: config.DATABASE_URL });
  try {
    const updated = await new TaskRunRepository(db).updateStatus(input.task_run_id, {
      status: input.status,
      ...(input.error_code ? { errorCode: input.error_code } : {}),
      ...(input.error_message ? { errorMessage: input.error_message } : {}),
    });
    if (!updated) {
      throw new Error(`TaskRun not found for status update: ${input.task_run_id}`);
    }
  } finally {
    await closeDb(db);
  }
}

export async function loadFlowSpecByRefActivity(flowSnapshotRef: string): Promise<FlowSpec> {
  const dbRef = parseDbFlowSnapshotRef(flowSnapshotRef);
  if (dbRef) {
    const config = loadConfig();
    const db = createDb({ databaseUrl: config.DATABASE_URL });
    try {
      const flowSpec = await new FlowDefinitionRepository(db).getPublished(dbRef.flowId, dbRef.version);
      if (!flowSpec) {
        throw new Error(`FlowSpec not found or not executable: ${flowSnapshotRef}`);
      }
      return flowSpecSchema.parse(flowSpec);
    } finally {
      await closeDb(db);
    }
  }

  const config = loadConfig();
  if (flowSnapshotRef === 'sample_flow@1' && !isProductionRuntime(config)) {
    return sampleFlowSpec;
  }

  throw new Error(`Unknown flow snapshot ref: ${flowSnapshotRef}`);
}

function isProductionRuntime(config: ReturnType<typeof loadConfig>): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}
