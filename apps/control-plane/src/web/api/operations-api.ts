import type {
  AuditEvent,
  AgentRunRecord,
  AgentStepRecord,
  DashboardSummaryResponse,
  HumanTaskGetResponse,
  HumanTaskListResponse,
  PaginatedResponse,
  TaskRun,
  TenantAgentAdmission,
  TenantRuntimePolicySnapshot,
  ToolCallLog,
} from '@dar/contracts';
import type { ApiClient } from './client.js';

export interface DashboardDetails {
  summary: DashboardSummaryResponse;
  recent_audit_events: AuditEvent[];
  recent_tool_calls: ToolCallLog[];
}

export interface HumanTaskFilters {
  status?: string;
  task_run_id?: string;
  page?: number;
  page_size?: number;
}

export interface TaskRunFilters {
  status?: string;
  flow_id?: string;
  workflow_id?: string;
  page?: number;
  page_size?: number;
}

export interface AgentRunFilters {
  status?: string;
  task_run_id?: string;
  agent_id?: string;
  page?: number;
  page_size?: number;
}

export interface AuditFilters {
  task_run_id?: string;
  tool_name?: string;
  event_type?: string;
  start_time?: string;
  end_time?: string;
  page?: number;
  page_size?: number;
}

export interface ToolCallFilters {
  task_run_id?: string;
  tool_name?: string;
  status?: string;
  page?: number;
  page_size?: number;
}

export interface TenantPolicySnapshotFilters {
  root_snapshot_ref?: string;
  parent_snapshot_ref?: string;
  execution_plan_ref?: string;
  source_policy_version?: number;
  derivation_type?: string;
  created_from?: string;
  created_to?: string;
  page?: number;
  page_size?: number;
}

export interface TenantAdmissionFilters {
  status?: string;
  task_run_id?: string;
  agent_run_id?: string;
  workflow_id?: string;
  acquired_from?: string;
  acquired_to?: string;
  page?: number;
  page_size?: number;
}

export async function getDashboard(client: ApiClient): Promise<DashboardDetails> {
  const [summary, recentAudit, recentToolCalls] = await Promise.all([
    client.request<DashboardSummaryResponse>('/api/v1/operations/dashboard'),
    listAuditEvents(client, { page_size: 5 }),
    listToolCalls(client, { page_size: 5 }),
  ]);
  return {
    summary,
    recent_audit_events: recentAudit,
    recent_tool_calls: recentToolCalls,
  };
}

export function listHumanTasks(client: ApiClient, filters: HumanTaskFilters): Promise<HumanTaskListResponse> {
  return client.request('/api/v1/operations/human-tasks', { query: filters });
}

export function getHumanTask(client: ApiClient, humanTaskId: string): Promise<HumanTaskGetResponse> {
  return client.request(`/api/v1/operations/human-tasks/${encodeURIComponent(humanTaskId)}`);
}

export function approveHumanTask(client: ApiClient, humanTaskId: string, decisionReason: string): Promise<HumanTaskGetResponse> {
  return client.request(`/api/v1/operations/human-tasks/${encodeURIComponent(humanTaskId)}/approve`, {
    method: 'POST',
    body: { decision_reason: decisionReason },
  });
}

export function rejectHumanTask(client: ApiClient, humanTaskId: string, decisionReason: string): Promise<HumanTaskGetResponse> {
  return client.request(`/api/v1/operations/human-tasks/${encodeURIComponent(humanTaskId)}/reject`, {
    method: 'POST',
    body: { decision_reason: decisionReason },
  });
}

export function listTaskRuns(client: ApiClient, filters: TaskRunFilters): Promise<TaskRun[]> {
  return client.request('/api/v1/operations/task-runs', { query: filters });
}

export function getTaskRun(client: ApiClient, taskRunId: string): Promise<TaskRun> {
  return client.request(`/api/v1/operations/task-runs/${encodeURIComponent(taskRunId)}`);
}

export async function listAgentRuns(client: ApiClient, filters: AgentRunFilters): Promise<AgentRunRecord[]> {
  const response = await client.request<{ agent_runs: AgentRunRecord[] }>('/api/v1/operations/agent-runs', { query: filters });
  return response.agent_runs;
}

export async function getAgentRun(client: ApiClient, agentRunId: string): Promise<AgentRunRecord> {
  const response = await client.request<{ agent_run: AgentRunRecord }>(`/api/v1/operations/agent-runs/${encodeURIComponent(agentRunId)}`);
  return response.agent_run;
}

export async function listAgentSteps(client: ApiClient, agentRunId: string, filters: { page?: number; page_size?: number } = {}): Promise<AgentStepRecord[]> {
  const response = await client.request<{ agent_steps: AgentStepRecord[] }>(`/api/v1/operations/agent-runs/${encodeURIComponent(agentRunId)}/steps`, { query: filters });
  return response.agent_steps;
}

export function listAuditEvents(client: ApiClient, filters: AuditFilters): Promise<AuditEvent[]> {
  return client.request('/api/v1/operations/audit-events', { query: filters });
}

export function listToolCalls(client: ApiClient, filters: ToolCallFilters): Promise<ToolCallLog[]> {
  return client.request('/api/v1/operations/tool-calls', { query: filters });
}

export function getToolCall(client: ApiClient, toolCallId: string): Promise<ToolCallLog> {
  return client.request(`/api/v1/operations/tool-calls/${encodeURIComponent(toolCallId)}`);
}

export function listTenantPolicySnapshots(
  client: ApiClient,
  filters: TenantPolicySnapshotFilters,
): Promise<PaginatedResponse<TenantRuntimePolicySnapshot>> {
  return client.request('/api/v1/tenant-runtime-policy-snapshots', { query: filters });
}

export function getTenantPolicySnapshot(client: ApiClient, snapshotId: string): Promise<TenantRuntimePolicySnapshot> {
  return client.request(`/api/v1/tenant-runtime-policy-snapshots/${encodeURIComponent(snapshotId)}`);
}

export function listTenantAdmissions(
  client: ApiClient,
  filters: TenantAdmissionFilters,
): Promise<PaginatedResponse<TenantAgentAdmission>> {
  return client.request('/api/v1/tenant-agent-admissions', { query: filters });
}

export function getTenantAdmission(client: ApiClient, admissionId: string): Promise<TenantAgentAdmission> {
  return client.request(`/api/v1/tenant-agent-admissions/${encodeURIComponent(admissionId)}`);
}
