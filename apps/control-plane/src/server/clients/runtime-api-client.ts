import type {
  HumanTask,
  HumanTaskDecisionResponse,
  HumanTaskGetResponse,
  HumanTaskListResponse,
  AgentRunRecord,
  AgentStepRecord,
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
  listAgentRuns(query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_runs: AgentRunRecord[] }>;
  getAgentRun(agentRunId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_run: AgentRunRecord }>;
  listAgentSteps(agentRunId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_steps: AgentStepRecord[] }>;
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

  listAgentRuns(query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_runs: AgentRunRecord[] }> {
    return this.client.get<{ agent_runs: AgentRunRecord[] }>(`/v1/agent-runs?${query.toString()}`, headers);
  }

  getAgentRun(agentRunId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_run: AgentRunRecord }> {
    return this.client.get<{ agent_run: AgentRunRecord }>(`/v1/agent-runs/${encodeURIComponent(agentRunId)}?${query.toString()}`, headers);
  }

  listAgentSteps(agentRunId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_steps: AgentStepRecord[] }> {
    return this.client.get<{ agent_steps: AgentStepRecord[] }>(`/v1/agent-runs/${encodeURIComponent(agentRunId)}/steps?${query.toString()}`, headers);
  }
}

export type { HumanTask };
