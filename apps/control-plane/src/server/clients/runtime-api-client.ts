import type {
  HumanTask,
  HumanTaskDecisionResponse,
  HumanTaskGetResponse,
  HumanTaskListResponse,
  TaskRun,
} from '@dar/contracts';
import type { ForwardHeaders } from './http-client.js';
import { DownstreamClient } from './http-client.js';

export interface RuntimeApiOperationsClient {
  listHumanTasks(query: URLSearchParams, headers: ForwardHeaders): Promise<HumanTaskListResponse>;
  getHumanTask(humanTaskId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<HumanTaskGetResponse>;
  approveHumanTask(humanTaskId: string, body: unknown, headers: ForwardHeaders): Promise<HumanTaskDecisionResponse>;
  rejectHumanTask(humanTaskId: string, body: unknown, headers: ForwardHeaders): Promise<HumanTaskDecisionResponse>;
  listTaskRuns(query: URLSearchParams, headers: ForwardHeaders): Promise<TaskRun[]>;
  getTaskRun(taskRunId: string, headers: ForwardHeaders, tenantId?: string): Promise<TaskRun>;
}

export class RuntimeApiClient implements RuntimeApiOperationsClient {
  private readonly client: DownstreamClient;

  constructor(baseUrl: string, timeoutMs?: number) {
    this.client = new DownstreamClient({
      baseUrl,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  listHumanTasks(query: URLSearchParams, headers: ForwardHeaders): Promise<HumanTaskListResponse> {
    return this.client.get<HumanTaskListResponse>(`/v1/human-tasks?${query.toString()}`, headers);
  }

  getHumanTask(humanTaskId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<HumanTaskGetResponse> {
    return this.client.get<HumanTaskGetResponse>(`/v1/human-tasks/${encodeURIComponent(humanTaskId)}?${query.toString()}`, headers);
  }

  approveHumanTask(humanTaskId: string, body: unknown, headers: ForwardHeaders): Promise<HumanTaskDecisionResponse> {
    return this.client.post<HumanTaskDecisionResponse>(`/v1/human-tasks/${encodeURIComponent(humanTaskId)}/approve`, body, headers);
  }

  rejectHumanTask(humanTaskId: string, body: unknown, headers: ForwardHeaders): Promise<HumanTaskDecisionResponse> {
    return this.client.post<HumanTaskDecisionResponse>(`/v1/human-tasks/${encodeURIComponent(humanTaskId)}/reject`, body, headers);
  }

  listTaskRuns(query: URLSearchParams, headers: ForwardHeaders): Promise<TaskRun[]> {
    return this.client.get<TaskRun[]>(`/v1/tasks?${query.toString()}`, headers);
  }

  getTaskRun(taskRunId: string, headers: ForwardHeaders, tenantId?: string): Promise<TaskRun> {
    const suffix = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
    return this.client.get<TaskRun>(`/v1/tasks/${encodeURIComponent(taskRunId)}${suffix}`, headers);
  }
}

export type { HumanTask };
