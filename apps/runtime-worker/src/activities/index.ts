import {
  agentRunRequestSchema,
  flowSpecSchema,
  toolInvokeRequestSchema,
  type AgentRunResult,
  type FlowSpec,
  type ToolInvokeResponse,
} from '@dar/contracts';
import { ToolGatewayClient } from '@dar/tool-client';
import { getToolGatewayUrl, loadConfig } from '@dar/config';
import { closeDb, createDb, FlowDefinitionRepository, parseDbFlowSnapshotRef } from '@dar/db';
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

export interface HumanTaskPlaceholder {
  human_task_id: string;
  status: 'created';
  signal_name: string;
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

export async function createHumanTaskActivity(
  context: ActivityContext,
): Promise<HumanTaskPlaceholder> {
  return {
    human_task_id: `human_${context.task_run_id}`,
    status: 'created',
    signal_name: 'resolveHumanTask',
  };
}

export async function loadFlowSpecActivity(flowSpec: FlowSpec): Promise<FlowSpec> {
  return flowSpec;
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
