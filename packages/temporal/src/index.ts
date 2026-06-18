export const TASK_QUEUES = {
  runtimeWorkerMain: 'runtime-worker-main',
} as const;

export const WORKFLOW_SIGNALS = {
  humanTaskDecision: 'humanTaskDecisionSignal',
} as const;

export type TaskQueueName = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];

export interface ConfigDrivenWorkflowInput {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id?: string;
  flow_id: string;
  flow_version: number;
  flow_snapshot_ref?: string;
  execution_plan_ref: string;
  flow_sha256?: string;
  request_id: string;
  trace_id?: string;
  input_ref?: string;
}

export interface GenericAgentWorkflowInput {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id?: string;
  agent_id: string;
  agent_version?: number;
  prompt_ref?: string;
  model_policy?: string;
  allowed_tools?: string[];
  max_steps?: number;
  max_tokens?: number;
  request_id: string;
  trace_id?: string;
  input_ref?: string;
  input?: unknown;
}

export interface HumanTaskDecisionSignalInput {
  human_task_id: string;
  tenant_id: string;
  task_run_id: string;
  workflow_id?: string;
  status: 'approved' | 'rejected' | 'cancelled' | 'expired';
  decision?: Record<string, unknown>;
  decided_by?: string;
  decided_at?: string;
  decision_reason?: string;
}

function sanitizeWorkflowSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function buildTaskWorkflowId(tenantId: string, taskRunId: string): string {
  return `task-${sanitizeWorkflowSegment(tenantId)}-${sanitizeWorkflowSegment(taskRunId)}`;
}

export function buildToolIdempotencyKey(taskRunId: string, stepId: string): string {
  return `${sanitizeWorkflowSegment(taskRunId)}:${sanitizeWorkflowSegment(stepId)}`;
}
