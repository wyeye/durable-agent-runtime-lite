import { createHash } from 'node:crypto';
import type { ConversationMessage } from '@dar/contracts';

export interface SelectedConversationContext {
  messages: ConversationMessage[];
  messageIds: string[];
  hash: string;
  totalBytes: number;
}

export function defaultConversationTitle(): string {
  return '新对话';
}

export function deriveConversationTitleFromMessage(
  content: string,
  maxChars = 30,
): string {
  const normalized = content.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return defaultConversationTitle();
  }
  return normalized.slice(0, maxChars);
}

export function selectConversationContext(
  messages: ConversationMessage[],
  limits: { maxMessages: number; maxBytes: number },
): SelectedConversationContext {
  const selected: ConversationMessage[] = [];
  let totalBytes = 0;
  for (let index = messages.length - 1; index >= 1; index -= 2) {
    const assistant = messages[index];
    const user = messages[index - 1];
    if (!assistant || !user) {
      continue;
    }
    if (assistant.role !== 'assistant' || user.role !== 'user') {
      continue;
    }
    if (assistant.status !== 'completed' || user.status !== 'completed') {
      continue;
    }
    const pairBytes = messageContextBytes(user) + messageContextBytes(assistant);
    if (selected.length + 2 > limits.maxMessages || totalBytes + pairBytes > limits.maxBytes) {
      break;
    }
    selected.unshift(user, assistant);
    totalBytes += pairBytes;
  }
  return {
    messages: selected,
    messageIds: selected.map((message) => message.message_id),
    hash: hashConversationContext(selected),
    totalBytes,
  };
}

export function hashConversationContext(messages: ConversationMessage[]): string {
  const payload = conversationContextPayload(messages);
  return createHash('sha256').update(payload).digest('hex');
}

function messageContextBytes(message: ConversationMessage): number {
  return Buffer.byteLength(
    conversationContextPayload([message]).slice(1, -1),
    'utf8',
  );
}

function conversationContextPayload(messages: ConversationMessage[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      message_id: message.message_id,
      sequence_no: message.sequence_no,
      role: message.role,
      content_text: message.content_text ?? '',
    })),
  );
}
