import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type {
  AgentAuthoritativeToolResult,
  PiContextSnapshotRef,
} from '@dar/contracts';

export const PI_CONTEXT_SCHEMA_VERSION = 'pi-context/v1' as const;

export interface PiContextCodecOptions {
  maxBytes: number;
}

export interface SerializedPiContext {
  schema_version: typeof PI_CONTEXT_SCHEMA_VERSION;
  messages: AgentMessage[];
  snapshot_hash: string;
  message_count: number;
  byte_size: number;
}

const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|cookie|password|token|secret|credential|private[_-]?key)/iu;

export function serializePiContext(
  messages: AgentMessage[],
  options: PiContextCodecOptions,
): SerializedPiContext {
  const sanitizedMessages = messages.flatMap((message) => sanitizeMessage(message));
  const payload = {
    schema_version: PI_CONTEXT_SCHEMA_VERSION,
    messages: sanitizedMessages,
  };
  const encoded = stableStringify(payload);
  const byteSize = Buffer.byteLength(encoded, 'utf8');
  if (byteSize > options.maxBytes) {
    throw new Error(`Pi context snapshot exceeds max byte size: ${byteSize}/${options.maxBytes}`);
  }

  return {
    ...payload,
    snapshot_hash: sha256(encoded),
    message_count: sanitizedMessages.length,
    byte_size: byteSize,
  };
}

export function restorePiMessages(snapshot: { schema_version: string; messages: unknown[] }): AgentMessage[] {
  if (snapshot.schema_version !== PI_CONTEXT_SCHEMA_VERSION) {
    throw new Error(`Unsupported Pi context schema version: ${snapshot.schema_version}`);
  }
  return snapshot.messages.flatMap((message) => sanitizeMessage(message));
}

export function replaceDeferredToolResults(
  messages: AgentMessage[],
  replacements: AgentAuthoritativeToolResult[],
  options: PiContextCodecOptions,
): SerializedPiContext {
  const replacementMap = new Map(replacements.map((replacement) => [replacement.tool_call_id, replacement]));
  const nextMessages = messages.map((message) => {
    if (!isToolResultMessage(message)) {
      return message;
    }
    const replacement = replacementMap.get(message.toolCallId);
    if (!replacement) {
      return message;
    }
    if (message.toolName !== replacement.tool_name) {
      throw new Error(`Tool result replacement mismatch for ${message.toolCallId}: ${message.toolName}/${replacement.tool_name}`);
    }
    return authoritativeToolResultToMessage(message, replacement);
  });

  for (const replacement of replacements) {
    const count = nextMessages.filter(
      (message) =>
        isToolResultMessage(message)
        && message.toolCallId === replacement.tool_call_id
        && message.toolName === replacement.tool_name,
    ).length;
    if (count !== 1) {
      throw new Error(`Expected exactly one deferred tool result for ${replacement.tool_call_id}, found ${count}`);
    }
  }

  return serializePiContext(nextMessages, options);
}

export function snapshotRefFromSerialized(
  snapshotId: string,
  context: SerializedPiContext,
): PiContextSnapshotRef {
  return {
    snapshot_id: snapshotId,
    schema_version: PI_CONTEXT_SCHEMA_VERSION,
    snapshot_hash: context.snapshot_hash,
    message_count: context.message_count,
    byte_size: context.byte_size,
  };
}

export function safeSummary(value: unknown, maxLength = 2000): string {
  const text = typeof value === 'string' ? value : stableStringify(redactSecrets(value));
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function sanitizeMessage(message: unknown): AgentMessage[] {
  if (!isRecord(message) || typeof message.role !== 'string') {
    return [];
  }
  if (message.role === 'user') {
    return [sanitizeUserMessage(message)];
  }
  if (message.role === 'assistant') {
    const assistant = sanitizeAssistantMessage(message);
    return assistant.content.length > 0 ? [assistant] : [];
  }
  if (message.role === 'toolResult') {
    return [sanitizeToolResultMessage(message)];
  }
  return [];
}

function sanitizeUserMessage(message: Record<string, unknown>): UserMessage {
  return {
    role: 'user',
    content: sanitizeUserContent(message.content),
    timestamp: safeTimestamp(message.timestamp),
  };
}

function sanitizeAssistantMessage(message: Record<string, unknown>): AssistantMessage {
  const content = Array.isArray(message.content) ? message.content : [];
  const sanitizedContent: AssistantMessage['content'] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      sanitizedContent.push({ type: 'text', text: redactText(block.text) });
      continue;
    }
    if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
      sanitizedContent.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: sanitizeJsonObject(block.arguments),
      } satisfies ToolCall);
    }
  }
  return {
    role: 'assistant',
    content: sanitizedContent,
    api: safeString(message.api, 'sanitized'),
    provider: safeString(message.provider, 'sanitized'),
    model: safeString(message.model, 'sanitized'),
    usage: sanitizeUsage(message.usage),
    stopReason: isStopReason(message.stopReason) ? message.stopReason : 'stop',
    timestamp: safeTimestamp(message.timestamp),
  };
}

function sanitizeToolResultMessage(message: Record<string, unknown>): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: safeString(message.toolCallId, 'unknown_tool_call'),
    toolName: safeString(message.toolName, 'unknown_tool'),
    content: sanitizeToolResultContent(message.content),
    details: sanitizeToolResultDetails(message.details),
    isError: message.isError === true,
    timestamp: safeTimestamp(message.timestamp),
  };
}

function authoritativeToolResultToMessage(
  existing: ToolResultMessage,
  replacement: AgentAuthoritativeToolResult,
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: replacement.tool_call_id,
    toolName: replacement.tool_name,
    content: sanitizeToolResultContent(replacement.content),
    details: sanitizeToolResultDetails({
      ...replacement.details,
      kind: 'authoritative_tool_result',
      tool_call_id: replacement.tool_call_id,
      tool_name: replacement.tool_name,
      tool_version: replacement.tool_version,
      result_ref: replacement.result_ref,
      result_summary: replacement.result_summary,
      is_error: replacement.is_error,
    }),
    isError: replacement.is_error,
    timestamp: existing.timestamp,
  };
}

function sanitizeUserContent(content: unknown): UserMessage['content'] {
  if (typeof content === 'string') {
    return redactText(content);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      return [];
    }
    return [{ type: 'text' as const, text: redactText(block.text) }];
  });
}

function sanitizeToolResultContent(content: unknown): ToolResultMessage['content'] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      return [];
    }
    return [{ type: 'text' as const, text: redactText(block.text).slice(0, 2000) }];
  });
}

function sanitizeToolResultDetails(details: unknown): Record<string, unknown> {
  if (!isRecord(details)) {
    return {};
  }
  return sanitizeJsonObject(details);
}

function sanitizeJsonObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    return {};
  }
  return redactSecrets(value) as Record<string, unknown>;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  if (!isRecord(value)) {
    return typeof value === 'string' ? redactText(value) : value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      redacted[key] = '[REDACTED]';
      continue;
    }
    redacted[key] = redactSecrets(entryValue);
  }
  return redacted;
}

function redactText(value: string): string {
  return value
    .replace(/Authorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Authorization: Bearer [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key|authorization|password|token|secret)\s*[:=]\s*\S+/giu, '$1=[REDACTED]');
}

function sanitizeUsage(value: unknown): AssistantMessage['usage'] {
  if (!isRecord(value)) {
    return emptyUsage();
  }
  const cost = isRecord(value.cost) ? value.cost : {};
  return {
    input: nonnegativeNumber(value.input),
    output: nonnegativeNumber(value.output),
    cacheRead: nonnegativeNumber(value.cacheRead),
    cacheWrite: nonnegativeNumber(value.cacheWrite),
    totalTokens: nonnegativeNumber(value.totalTokens),
    cost: {
      input: nonnegativeNumber(cost.input),
      output: nonnegativeNumber(cost.output),
      cacheRead: nonnegativeNumber(cost.cacheRead),
      cacheWrite: nonnegativeNumber(cost.cacheWrite),
      total: nonnegativeNumber(cost.total),
    },
  };
}

function emptyUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function safeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isStopReason(value: unknown): value is AssistantMessage['stopReason'] {
  return value === 'stop' || value === 'length' || value === 'toolUse' || value === 'error' || value === 'aborted';
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
  return isRecord(value)
    && value.role === 'toolResult'
    && typeof value.toolCallId === 'string'
    && typeof value.toolName === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
