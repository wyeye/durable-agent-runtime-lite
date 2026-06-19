import type { AgentBudgetLedger, PiContextSnapshotRef } from '@dar/contracts';

export const TASK_QUEUES = {
  runtimeWorkerMain: 'runtime-worker-main',
} as const;

export const WORKFLOW_SIGNALS = {
  humanTaskDecision: 'humanTaskDecisionSignal',
  userInputResponse: 'userInputResponseSignal',
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
  tenant_policy_snapshot_ref?: string;
  tenant_policy_hash?: string;
  tenant_admission_id?: string;
  request_id: string;
  trace_id?: string;
  input_ref?: string;
}

export interface GenericAgentWorkflowInput {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id?: string;
  agent_execution_plan_ref?: string;
  agent_id?: string;
  agent_version?: number;
  prompt_ref?: string;
  model_policy?: string;
  allowed_tools?: string[];
  max_steps?: number;
  max_tokens?: number;
  tenant_policy_snapshot_ref?: string;
  tenant_policy_hash?: string;
  tenant_admission_id?: string;
  request_id: string;
  trace_id?: string;
  input_ref?: string;
  input?: unknown;
}

export interface PiDurableAgentWorkflowInput {
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id?: string;
  parent_workflow_id?: string;
  agent_run_id?: string;
  agent_execution_plan_ref: string;
  execution_mode?: 'answer_only' | 'plan_only' | 'mediated_tool_call';
  initial_user_input?: string;
  context_snapshot_ref?: PiContextSnapshotRef;
  budget_ledger?: AgentBudgetLedger;
  segment_index?: number;
  started_at_ms?: number;
  continue_as_new_segment_threshold?: number;
  handoff_chain?: string[];
  tenant_policy_snapshot_ref?: string;
  tenant_policy_hash?: string;
  tenant_admission_id?: string;
  request_id: string;
  trace_id?: string;
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

export interface UserInputResponseSignalInput {
  human_task_id: string;
  tenant_id: string;
  task_run_id: string;
  workflow_id?: string;
  response: Record<string, unknown>;
  responded_by: string;
  responded_at: string;
  response_idempotency_key: string;
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
