import type {
  AuditEvent,
  DashboardSummaryResponse,
  HumanTaskGetResponse,
  HumanTaskListResponse,
  TaskRun,
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

export function listAuditEvents(client: ApiClient, filters: AuditFilters): Promise<AuditEvent[]> {
  return client.request('/api/v1/operations/audit-events', { query: filters });
}

export function listToolCalls(client: ApiClient, filters: ToolCallFilters): Promise<ToolCallLog[]> {
  return client.request('/api/v1/operations/tool-calls', { query: filters });
}

export function getToolCall(client: ApiClient, toolCallId: string): Promise<ToolCallLog> {
  return client.request(`/api/v1/operations/tool-calls/${encodeURIComponent(toolCallId)}`);
}
