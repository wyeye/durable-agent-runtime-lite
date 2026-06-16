export const TASK_QUEUES = {
  runtimeWorkerMain: 'runtime-worker-main',
} as const;

export type TaskQueueName = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];

export interface ConfigDrivenWorkflowInput {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  flow_id: string;
  flow_version: number;
  flow_snapshot_ref: string;
  flow_sha256: string;
  request_id: string;
  trace_id?: string;
  input_ref?: string;
}

export interface GenericAgentWorkflowInput {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  agent_id: string;
  request_id: string;
  trace_id?: string;
  input_ref?: string;
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
