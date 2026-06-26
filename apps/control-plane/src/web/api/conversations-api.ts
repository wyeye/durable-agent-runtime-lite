import type {
  Conversation,
  ConversationCreateRequest,
  ConversationListResponse,
  ConversationMessage,
  ConversationMessageListResponse,
  ConversationSendMessageRequest,
  ConversationSendMessageResponse,
  ConversationStatus,
  ConversationUpdateRequest,
} from '@dar/contracts';
import type { ApiClient } from './client.js';

export interface PageParams {
  page?: number;
  page_size?: number;
}

export interface ConversationListParams extends PageParams {
  status?: ConversationStatus;
}

export interface ConversationMessageListParams extends PageParams {
  order?: 'oldest' | 'newest';
}

export interface ConversationRequestOptions {
  signal?: AbortSignal;
}

export function listConversations(
  client: ApiClient,
  params: ConversationListParams = {},
  options: ConversationRequestOptions = {},
): Promise<ConversationListResponse> {
  return client.request('/api/v1/conversations', { query: compactParams(params as Record<string, unknown>), signal: options.signal });
}

export function createConversation(
  client: ApiClient,
  input: ConversationCreateRequest = {},
  options: ConversationRequestOptions = {},
): Promise<Conversation> {
  return client.request('/api/v1/conversations', { method: 'POST', body: input, signal: options.signal });
}

export function getConversation(
  client: ApiClient,
  conversationId: string,
  options: ConversationRequestOptions = {},
): Promise<Conversation> {
  return client.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, { signal: options.signal });
}

export function renameConversation(
  client: ApiClient,
  conversationId: string,
  input: ConversationUpdateRequest,
  options: ConversationRequestOptions = {},
): Promise<Conversation> {
  return client.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: input,
    signal: options.signal,
  });
}

export function archiveConversation(
  client: ApiClient,
  conversationId: string,
  options: ConversationRequestOptions = {},
): Promise<Conversation> {
  return client.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}/archive`, {
    method: 'POST',
    body: {},
    signal: options.signal,
  });
}

export function unarchiveConversation(
  client: ApiClient,
  conversationId: string,
  options: ConversationRequestOptions = {},
): Promise<Conversation> {
  return client.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}/unarchive`, {
    method: 'POST',
    body: {},
    signal: options.signal,
  });
}

export function listConversationMessages(
  client: ApiClient,
  conversationId: string,
  params: ConversationMessageListParams = {},
  options: ConversationRequestOptions = {},
): Promise<ConversationMessageListResponse> {
  return client.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
    query: compactParams(params as Record<string, unknown>),
    signal: options.signal,
  });
}

export function sendConversationMessage(
  client: ApiClient,
  conversationId: string,
  input: ConversationSendMessageRequest,
  options: ConversationRequestOptions = {},
): Promise<ConversationSendMessageResponse> {
  return client.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: input,
    signal: options.signal,
  });
}

export function hasPendingMessage(messages: ConversationMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== 'assistant') {
      return false;
    }
    const status = message.effective_status ?? message.status;
    return status === 'queued' || status === 'running' || status === 'waiting_human' || status === 'waiting_user';
  });
}

function compactParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}
