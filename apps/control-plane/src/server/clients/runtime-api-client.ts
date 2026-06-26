import type {
  Conversation,
  ConversationCreateRequest,
  ConversationListResponse,
  ConversationMessageListResponse,
  ConversationSendMessageRequest,
  ConversationSendMessageResponse,
  ConversationUpdateRequest,
  HumanTask,
  HumanTaskDecisionResponse,
  HumanTaskGetResponse,
  HumanTaskListResponse,
  AgentRunRecord,
  AgentStepRecord,
  EvaluationCaseResult,
  EvaluationRun,
  TaskRun,
} from '@dar/contracts';
import type { ForwardHeaders } from './http-client.js';
import { DownstreamClient } from './http-client.js';

export interface RuntimeApiOperationsClient {
  listConversations(query: URLSearchParams, headers: ForwardHeaders): Promise<ConversationListResponse>;
  createConversation(body: ConversationCreateRequest, headers: ForwardHeaders): Promise<Conversation>;
  getConversation(conversationId: string, headers: ForwardHeaders): Promise<Conversation>;
  updateConversation(conversationId: string, body: ConversationUpdateRequest, headers: ForwardHeaders): Promise<Conversation>;
  archiveConversation(conversationId: string, headers: ForwardHeaders): Promise<Conversation>;
  unarchiveConversation(conversationId: string, headers: ForwardHeaders): Promise<Conversation>;
  listConversationMessages(conversationId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<ConversationMessageListResponse>;
  sendConversationMessage(conversationId: string, body: ConversationSendMessageRequest, headers: ForwardHeaders): Promise<ConversationSendMessageResponse>;
  listHumanTasks(query: URLSearchParams, headers: ForwardHeaders): Promise<HumanTaskListResponse>;
  getHumanTask(humanTaskId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<HumanTaskGetResponse>;
  approveHumanTask(humanTaskId: string, body: unknown, headers: ForwardHeaders): Promise<HumanTaskDecisionResponse>;
  rejectHumanTask(humanTaskId: string, body: unknown, headers: ForwardHeaders): Promise<HumanTaskDecisionResponse>;
  listTaskRuns(query: URLSearchParams, headers: ForwardHeaders): Promise<TaskRun[]>;
  getTaskRun(taskRunId: string, headers: ForwardHeaders, tenantId?: string): Promise<TaskRun>;
  listAgentRuns(query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_runs: AgentRunRecord[] }>;
  getAgentRun(agentRunId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_run: AgentRunRecord }>;
  listAgentSteps(agentRunId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<{ agent_steps: AgentStepRecord[] }>;
  listEvaluationRuns(query: URLSearchParams, headers: ForwardHeaders): Promise<EvaluationRun[]>;
  createEvaluationRun(body: unknown, headers: ForwardHeaders): Promise<{ evaluation_run: EvaluationRun; workflow_start: Record<string, unknown> }>;
  getEvaluationRun(runId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<EvaluationRun>;
  listEvaluationRunResults(runId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<{ evaluation_run_id: string; results: EvaluationCaseResult[] }>;
  cancelEvaluationRun(runId: string, body: unknown, headers: ForwardHeaders): Promise<EvaluationRun>;
}

export class RuntimeApiClient implements RuntimeApiOperationsClient {
  private readonly client: DownstreamClient;

  constructor(baseUrl: string, timeoutMs?: number) {
    this.client = new DownstreamClient({
      baseUrl,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  listConversations(query: URLSearchParams, headers: ForwardHeaders): Promise<ConversationListResponse> {
    return this.client.get<ConversationListResponse>(`/v1/conversations?${query.toString()}`, headers);
  }

  createConversation(body: ConversationCreateRequest, headers: ForwardHeaders): Promise<Conversation> {
    return this.client.post<Conversation>('/v1/conversations', body, headers);
  }

  getConversation(conversationId: string, headers: ForwardHeaders): Promise<Conversation> {
    return this.client.get<Conversation>(`/v1/conversations/${encodeURIComponent(conversationId)}`, headers);
  }

  updateConversation(conversationId: string, body: ConversationUpdateRequest, headers: ForwardHeaders): Promise<Conversation> {
    return this.client.patch<Conversation>(`/v1/conversations/${encodeURIComponent(conversationId)}`, body, headers);
  }

  archiveConversation(conversationId: string, headers: ForwardHeaders): Promise<Conversation> {
    return this.client.post<Conversation>(`/v1/conversations/${encodeURIComponent(conversationId)}/archive`, {}, headers);
  }

  unarchiveConversation(conversationId: string, headers: ForwardHeaders): Promise<Conversation> {
    return this.client.post<Conversation>(`/v1/conversations/${encodeURIComponent(conversationId)}/unarchive`, {}, headers);
  }

  listConversationMessages(conversationId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<ConversationMessageListResponse> {
    return this.client.get<ConversationMessageListResponse>(`/v1/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`, headers);
  }

  sendConversationMessage(conversationId: string, body: ConversationSendMessageRequest, headers: ForwardHeaders): Promise<ConversationSendMessageResponse> {
    return this.client.post<ConversationSendMessageResponse>(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`, body, headers);
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

  listEvaluationRuns(query: URLSearchParams, headers: ForwardHeaders): Promise<EvaluationRun[]> {
    return this.client.get<EvaluationRun[]>(`/v1/evaluation-runs?${query.toString()}`, headers);
  }

  createEvaluationRun(body: unknown, headers: ForwardHeaders): Promise<{ evaluation_run: EvaluationRun; workflow_start: Record<string, unknown> }> {
    return this.client.post<{ evaluation_run: EvaluationRun; workflow_start: Record<string, unknown> }>('/v1/evaluation-runs', body, headers);
  }

  getEvaluationRun(runId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<EvaluationRun> {
    return this.client.get<EvaluationRun>(`/v1/evaluation-runs/${encodeURIComponent(runId)}?${query.toString()}`, headers);
  }

  listEvaluationRunResults(runId: string, query: URLSearchParams, headers: ForwardHeaders): Promise<{ evaluation_run_id: string; results: EvaluationCaseResult[] }> {
    return this.client.get<{ evaluation_run_id: string; results: EvaluationCaseResult[] }>(`/v1/evaluation-runs/${encodeURIComponent(runId)}/results?${query.toString()}`, headers);
  }

  cancelEvaluationRun(runId: string, body: unknown, headers: ForwardHeaders): Promise<EvaluationRun> {
    return this.client.post<EvaluationRun>(`/v1/evaluation-runs/${encodeURIComponent(runId)}/cancel`, body, headers);
  }
}

export type { HumanTask };
