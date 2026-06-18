import {
  type AssistantMessage,
  type Context,
  type Model,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { ModelGatewayClient } from '@dar/model-client';

export interface ModelGatewayPiStreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export function createModelGatewayModel(modelId: string): Model<string> {
  return {
    id: modelId,
    name: modelId,
    api: 'dar-model-gateway',
    provider: 'dar-model-gateway',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  };
}

export function createModelGatewayPiStream(options: ModelGatewayPiStreamOptions): StreamFn {
  const client = new ModelGatewayClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
  });

  return async (_model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    void client.generate({
      model: options.model,
      messages: contextToGatewayMessages(context),
      max_tokens: streamOptions?.maxTokens,
      signal: streamOptions?.signal,
    }).then((response) => {
      const message = fauxAssistantMessage(response.content);
      pushFinal(stream, withGatewayModel(message, options.model));
    }).catch((error: unknown) => {
      const message = withGatewayModel(fauxAssistantMessage([], {
        stopReason: streamOptions?.signal?.aborted ? 'aborted' : 'error',
        errorMessage: error instanceof Error ? error.message : 'Model Gateway request failed',
      }), options.model);
      stream.push({ type: 'start', partial: message });
      stream.push({
        type: message.stopReason === 'aborted' ? 'error' : 'error',
        reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
        error: message,
      });
      stream.end(message);
    });
    return stream;
  };
}

function pushFinal(stream: ReturnType<typeof createAssistantMessageEventStream>, message: AssistantMessage): void {
  stream.push({ type: 'start', partial: message });
  const textBlock = message.content.find((block) => block.type === 'text');
  if (textBlock?.type === 'text') {
    stream.push({ type: 'text_start', contentIndex: 0, partial: message });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: textBlock.text, partial: message });
    stream.push({ type: 'text_end', contentIndex: 0, content: textBlock.text, partial: message });
  }
  stream.push({ type: 'done', reason: 'stop', message });
  stream.end(message);
}

function withGatewayModel(message: AssistantMessage, modelId: string): AssistantMessage {
  return {
    ...message,
    api: 'dar-model-gateway',
    provider: 'dar-model-gateway',
    model: modelId,
  };
}

function contextToGatewayMessages(context: Context): Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }> = [];
  if (context.systemPrompt) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: contentToText(message.content) });
    } else if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: contentToText(message.content) });
    } else if (message.role === 'toolResult') {
      messages.push({ role: 'tool', content: contentToText(message.content) });
    }
  }
  return messages;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.flatMap((block) => {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block) {
      return typeof block.text === 'string' ? [block.text] : [];
    }
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'toolCall' && 'name' in block) {
      return [`[tool call: ${String(block.name)}]`];
    }
    return [];
  }).join('\n');
}
