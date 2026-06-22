import { createHash } from 'node:crypto';
import {
  modelGatewayRequestSchema,
  modelGatewayResponseSchema,
  type ModelGatewayContentBlock,
  type ModelGatewayProtocol,
  type ModelGatewayRequest,
  type ModelGatewayResponse,
  type ModelGatewayToolDefinition,
} from '@dar/contracts';
import { request } from 'undici';
import { z } from 'zod';

export const modelGatewayTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const modelGatewayToolCallBlockSchema = z.object({
  type: z.literal('tool_call'),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export const modelGatewayContentBlockSchema = z.discriminatedUnion('type', [
  modelGatewayTextBlockSchema,
  modelGatewayToolCallBlockSchema,
]);

export const modelGatewayMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(modelGatewayContentBlockSchema).default([]),
});

export const modelGatewayUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative().default(0),
});

export const modelGenerateRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string(),
    }),
  ),
  response_schema: z.record(z.string(), z.unknown()).optional(),
  max_tokens: z.number().int().positive().optional(),
  request_id: z.string().optional(),
  task_run_id: z.string().optional(),
  agent_run_id: z.string().optional(),
  signal: z.instanceof(AbortSignal).optional(),
});

const rawModelGenerateResponseSchema = z.object({
  id: z.string().optional(),
  content: z.string().optional(),
  message: modelGatewayMessageSchema.optional(),
  finish_reason: z.enum(['stop', 'tool_call', 'length', 'error']).default('stop'),
  usage: modelGatewayUsageSchema.optional(),
  model: z.string().optional(),
  provider_metadata: z.record(z.string(), z.unknown()).optional(),
});

export const modelGenerateResponseSchema = rawModelGenerateResponseSchema.transform((response) => {
  const message = response.message ?? {
    role: 'assistant' as const,
    content: response.content ? [{ type: 'text' as const, text: response.content }] : [],
  };
  return {
    ...response,
    content:
      response.content ??
      message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    message,
    usage: response.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
});

export type ModelGatewayTextBlock = z.infer<typeof modelGatewayTextBlockSchema>;
export type ModelGatewayToolCallBlock = z.infer<typeof modelGatewayToolCallBlockSchema>;
export type { ModelGatewayContentBlock };
export type ModelGatewayMessage = z.infer<typeof modelGatewayMessageSchema>;
export type ModelGatewayUsage = z.infer<typeof modelGatewayUsageSchema>;
export type ModelGenerateRequest = z.infer<typeof modelGenerateRequestSchema>;
export type ModelGenerateResponse = z.infer<typeof modelGenerateResponseSchema>;

export interface ModelGatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  protocol?: ModelGatewayProtocol;
  timeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
  retryBackoffMs?: number;
  allowInsecureHttp?: boolean;
  userAgent?: string;
  idempotencyHeader?: string;
}

export interface ModelGatewayAttemptEvent {
  attemptIndex: number;
  protocol: ModelGatewayProtocol;
  targetId: string;
  provider: string;
  modelId: string;
}

export interface ModelGatewayAttemptCompleteEvent extends ModelGatewayAttemptEvent {
  status: 'succeeded' | 'failed';
  httpStatus?: number;
  errorClass?: ModelGatewayErrorClass;
  errorCode?: string;
  latencyMs: number;
  responseId?: string;
}

export interface ModelGatewayClientTarget {
  target_id: string;
  gateway_profile: string;
  model_id: string;
}

export interface ModelGatewayCallOptions {
  protocol?: ModelGatewayProtocol;
  target?: ModelGatewayClientTarget;
  toolNameCodec?: ModelToolNameCodec;
  maxRetries?: number;
  retryableStatusCodes?: number[];
  retryOnTimeout?: boolean;
  retryOnNetworkError?: boolean;
  retryBackoffMs?: number;
  signal?: AbortSignal;
  onAttemptStart?: (event: ModelGatewayAttemptEvent) => void | Promise<void>;
  onAttemptComplete?: (event: ModelGatewayAttemptCompleteEvent) => void | Promise<void>;
}

export type ModelGatewayErrorClass =
  | 'auth'
  | 'policy'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'validation'
  | 'response_too_large'
  | 'aborted'
  | 'unknown';

export class ModelGatewayClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string | undefined;
  private readonly protocol: ModelGatewayProtocol;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxResponseBytes: number;
  private readonly retryBackoffMs: number;
  private readonly userAgent: string;
  private readonly idempotencyHeader: string;

  constructor(private readonly options: ModelGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.apiKey = options.apiKey;
    this.protocol = options.protocol ?? 'dar_generate';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
    this.retryBackoffMs = options.retryBackoffMs ?? 25;
    this.userAgent = options.userAgent ?? 'durable-agent-runtime-lite/model-client';
    this.idempotencyHeader = options.idempotencyHeader ?? 'Idempotency-Key';
    assertTransportAllowed(this.baseUrl, options.allowInsecureHttp ?? isLocalHttp(this.baseUrl));
  }

  async call(
    payload: ModelGatewayRequest,
    options: ModelGatewayCallOptions = {},
  ): Promise<ModelGatewayResponse> {
    const parsed = modelGatewayRequestSchema.parse(payload);
    const protocol = options.protocol ?? this.protocol;
    const target = options.target ?? {
      target_id: 'default',
      gateway_profile: this.baseUrl.hostname,
      model_id: parsed.model,
    };
    const maxRetries = Math.min(
      Math.max(options.maxRetries ?? this.maxRetries, 0),
      this.maxRetries,
    );
    const retryBackoffMs = options.retryBackoffMs ?? this.retryBackoffMs;
    let lastError: unknown;
    for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
      const startedAt = Date.now();
      await options.onAttemptStart?.({
        attemptIndex,
        protocol,
        targetId: target.target_id,
        provider: target.gateway_profile,
        modelId: target.model_id,
      });
      try {
        const response = await this.requestModel(protocol, parsed, target, options, options.signal);
        await options.onAttemptComplete?.({
          attemptIndex,
          protocol,
          targetId: target.target_id,
          provider: target.gateway_profile,
          modelId: target.model_id,
          status: 'succeeded',
          latencyMs: Date.now() - startedAt,
          ...(response.response_id ? { responseId: response.response_id } : {}),
        });
        return response;
      } catch (error) {
        lastError = error;
        const normalized = normalizeModelGatewayError(error);
        await options.onAttemptComplete?.({
          attemptIndex,
          protocol,
          targetId: target.target_id,
          provider: target.gateway_profile,
          modelId: target.model_id,
          status: 'failed',
          ...(normalized.httpStatus !== undefined ? { httpStatus: normalized.httpStatus } : {}),
          errorClass: normalized.errorClass,
          errorCode: normalized.code,
          latencyMs: Date.now() - startedAt,
        });
        if (
          !isRetryableModelGatewayError(normalized, options) ||
          attemptIndex >= maxRetries ||
          options.signal?.aborted
        ) {
          throw normalized;
        }
        await sleep(retryBackoffMs * (attemptIndex + 1), options.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Model Gateway request failed');
  }

  async generate(payload: ModelGenerateRequest): Promise<ModelGenerateResponse> {
    const parsed = modelGenerateRequestSchema.parse(payload);
    const { signal, ...requestPayload } = parsed;
    const gatewayRequest = modelGatewayRequestSchema.parse({
      model_request_key: requestPayload.request_id ?? `generate:${cryptoHash(requestPayload)}`,
      model: requestPayload.model,
      messages: requestPayload.messages,
      tools: [],
      tool_choice: 'auto',
      response_format: 'text',
      ...(requestPayload.max_tokens !== undefined
        ? { max_output_tokens: requestPayload.max_tokens }
        : {}),
      ...(requestPayload.request_id ? { request_id: requestPayload.request_id } : {}),
      ...(requestPayload.task_run_id ? { task_run_id: requestPayload.task_run_id } : {}),
      ...(requestPayload.agent_run_id ? { agent_run_id: requestPayload.agent_run_id } : {}),
    });
    const response = await this.call(gatewayRequest, {
      protocol: 'dar_generate',
      ...(signal ? { signal } : {}),
    });

    return modelGenerateResponseSchema.parse({
      id: response.response_id,
      model: response.model,
      message: response.message,
      finish_reason: response.finish_reason,
      usage: response.usage,
    });
  }

  private async requestModel(
    protocol: ModelGatewayProtocol,
    payload: ModelGatewayRequest,
    target: ModelGatewayClientTarget,
    options: ModelGatewayCallOptions,
    signal?: AbortSignal,
  ): Promise<ModelGatewayResponse> {
    switch (protocol) {
      case 'dar_generate':
        return this.requestDarGenerate(payload, target, signal);
      case 'openai_chat_completions':
        return this.requestOpenAiChatCompletions(payload, target, options, signal);
    }
  }

  private async requestDarGenerate(
    payload: ModelGatewayRequest,
    target: ModelGatewayClientTarget,
    signal?: AbortSignal,
  ): Promise<ModelGatewayResponse> {
    const raw = await this.postJson(
      '/v1/generate',
      {
        model: target.model_id,
        messages: payload.messages.map((message) => ({
          role: message.role,
          content: messageContentToText(message.content),
          ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
          ...(message.name ? { name: message.name } : {}),
        })),
        max_tokens: payload.max_output_tokens,
        request_id: payload.request_id ?? payload.model_request_key,
        task_run_id: payload.task_run_id,
        agent_run_id: payload.agent_run_id,
      },
      payload.model_request_key,
      signal,
    );
    const parsed = modelGenerateResponseSchema.parse(raw.body);
    return modelGatewayResponseSchema.parse({
      response_id: parsed.id,
      model: parsed.model ?? target.model_id,
      provider: target.gateway_profile,
      message: parsed.message,
      finish_reason: parsed.finish_reason,
      usage: parsed.usage,
    });
  }

  private async requestOpenAiChatCompletions(
    payload: ModelGatewayRequest,
    target: ModelGatewayClientTarget,
    options: ModelGatewayCallOptions,
    signal?: AbortSignal,
  ): Promise<ModelGatewayResponse> {
    const toolNameCodec = options.toolNameCodec ?? ModelToolNameCodec.fromTools(payload.tools);
    validateToolRoundTripMessages(payload.messages);
    const raw = await this.postJson(
      '/v1/chat/completions',
      {
        model: target.model_id,
        messages: payload.messages.map((message) =>
          openAiMessageFromGatewayMessage(message, toolNameCodec),
        ),
        ...(payload.tools.length > 0
          ? { tools: payload.tools.map((tool) => openAiToolFromGatewayTool(tool, toolNameCodec)) }
          : {}),
        ...(payload.tools.length > 0 ? { tool_choice: openAiToolChoice(payload.tool_choice) } : {}),
        ...(payload.parallel_tool_calls !== undefined
          ? { parallel_tool_calls: payload.parallel_tool_calls }
          : {}),
        ...(payload.response_format !== 'text' ? { response_format: { type: 'json_object' } } : {}),
        ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
        ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
        ...(payload.max_output_tokens !== undefined
          ? { max_tokens: payload.max_output_tokens }
          : {}),
      },
      payload.model_request_key,
      signal,
    );

    return openAiResponseToGatewayResponse(raw.body, target, toolNameCodec);
  }

  private async postJson(
    path: string,
    body: unknown,
    modelRequestKey: string,
    signal?: AbortSignal,
  ): Promise<{ body: unknown; statusCode: number }> {
    const url = endpointUrl(this.baseUrl, path);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await request(url, {
        method: 'POST',
        headers: {
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          'content-type': 'application/json',
          'user-agent': this.userAgent,
          [this.idempotencyHeader]: modelRequestKey,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      });

      const text = await response.body.text();
      if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
        throw new ModelGatewayError(
          'MODEL_GATEWAY_RESPONSE_TOO_LARGE',
          'Model Gateway response exceeded size limit',
          {
            errorClass: 'response_too_large',
            httpStatus: response.statusCode,
          },
        );
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw errorFromStatus(response.statusCode);
      }
      return { statusCode: response.statusCode, body: text ? JSON.parse(text) : {} };
    } catch (error) {
      throw normalizeModelGatewayError(error);
    }
  }
}

export class ModelGatewayError extends Error {
  readonly errorClass: ModelGatewayErrorClass;
  readonly httpStatus: number | undefined;

  constructor(
    readonly code: string,
    message: string,
    options: { errorClass?: ModelGatewayErrorClass; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = 'ModelGatewayError';
    this.errorClass = options.errorClass ?? 'unknown';
    this.httpStatus = options.httpStatus;
  }
}

const PROVIDER_SAFE_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
const PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH = 64;

export class ModelToolNameCodec {
  private readonly canonicalToProvider = new Map<string, string>();
  private readonly providerToCanonical = new Map<string, string>();

  static fromTools(tools: ModelGatewayToolDefinition[]): ModelToolNameCodec {
    return new ModelToolNameCodec(tools.map((tool) => tool.name));
  }

  constructor(canonicalNames: string[]) {
    for (const canonicalName of canonicalNames) {
      this.register(canonicalName);
    }
  }

  encode(canonicalName: string): string {
    const providerName = this.canonicalToProvider.get(canonicalName);
    if (!providerName) {
      throw new ModelGatewayError(
        'MODEL_GATEWAY_UNKNOWN_TOOL_NAME',
        `Tool is not registered for this model request: ${canonicalName}`,
        {
          errorClass: 'validation',
        },
      );
    }
    return providerName;
  }

  decode(providerName: string): string {
    const canonicalName = this.providerToCanonical.get(providerName);
    if (!canonicalName) {
      throw new ModelGatewayError(
        'MODEL_GATEWAY_UNKNOWN_TOOL_ALIAS',
        `Provider returned an unknown tool alias: ${providerName}`,
        {
          errorClass: 'validation',
        },
      );
    }
    return canonicalName;
  }

  private register(canonicalName: string): void {
    if (this.canonicalToProvider.has(canonicalName)) {
      throw new ModelGatewayError(
        'MODEL_GATEWAY_DUPLICATE_TOOL_NAME',
        `Duplicate tool name in model request: ${canonicalName}`,
        {
          errorClass: 'validation',
        },
      );
    }
    const providerName = providerSafeToolName(canonicalName);
    const existing = this.providerToCanonical.get(providerName);
    if (existing && existing !== canonicalName) {
      throw new ModelGatewayError(
        'MODEL_GATEWAY_TOOL_ALIAS_CONFLICT',
        `Tool alias conflict: ${existing} and ${canonicalName} both map to ${providerName}`,
        {
          errorClass: 'validation',
        },
      );
    }
    this.canonicalToProvider.set(canonicalName, providerName);
    this.providerToCanonical.set(providerName, canonicalName);
  }
}

function openAiResponseToGatewayResponse(
  value: unknown,
  target: Pick<ModelGatewayClientTarget, 'gateway_profile' | 'model_id'>,
  toolNameCodec: ModelToolNameCodec,
): ModelGatewayResponse {
  const parsed = openAiChatCompletionResponseSchema.parse(value);
  const choice = parsed.choices[0];
  if (!choice) {
    throw new ModelGatewayError(
      'MODEL_GATEWAY_INVALID_RESPONSE',
      'OpenAI-compatible response did not include a choice',
      {
        errorClass: 'validation',
      },
    );
  }
  const content: ModelGatewayContentBlock[] = [];
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  for (const toolCall of choice.message.tool_calls ?? []) {
    content.push({
      type: 'tool_call',
      id: toolCall.id,
      name: toolNameCodec.decode(toolCall.function.name),
      arguments: parseToolArguments(toolCall.function.arguments),
    });
  }
  return modelGatewayResponseSchema.parse({
    response_id: parsed.id,
    model: parsed.model ?? target.model_id,
    provider: target.gateway_profile,
    message: { role: 'assistant', content },
    finish_reason: finishReasonFromOpenAi(choice.finish_reason),
    usage: parsed.usage
      ? {
          input_tokens: parsed.usage.prompt_tokens ?? 0,
          output_tokens: parsed.usage.completion_tokens ?? 0,
          total_tokens: parsed.usage.total_tokens ?? 0,
        }
      : undefined,
  });
}

const openAiChatCompletionResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(
    z.object({
      finish_reason: z.string().nullable().optional(),
      message: z.object({
        role: z.string().optional(),
        content: z.string().nullable().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string().min(1),
              type: z.literal('function').optional(),
              function: z.object({
                name: z.string().min(1),
                arguments: z.string().default('{}'),
              }),
            }),
          )
          .optional(),
      }),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

function openAiMessageFromGatewayMessage(
  message: ModelGatewayRequest['messages'][number],
  toolNameCodec: ModelToolNameCodec,
): Record<string, unknown> {
  if (message.role === 'assistant') {
    const contentBlocks = Array.isArray(message.content) ? message.content : [];
    const toolCalls = contentBlocks.filter((block) => block.type === 'tool_call');
    if (toolCalls.length > 0) {
      assertUniqueToolCallIds(toolCalls.map((toolCall) => toolCall.id));
      return {
        role: 'assistant',
        content: messageContentToText(message.content) || null,
        tool_calls: toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolNameCodec.encode(toolCall.name),
            arguments: JSON.stringify(toolCall.arguments),
          },
        })),
      };
    }
  }

  if (message.role === 'tool') {
    if (!message.tool_call_id) {
      throw new ModelGatewayError(
        'MODEL_GATEWAY_TOOL_RESULT_ID_REQUIRED',
        'Tool result messages must include tool_call_id',
        {
          errorClass: 'validation',
        },
      );
    }
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: messageContentToText(message.content),
    };
  }

  return {
    role: message.role,
    content: messageContentToText(message.content),
    ...(message.name ? { name: message.name } : {}),
  };
}

function openAiToolFromGatewayTool(
  tool: ModelGatewayToolDefinition,
  toolNameCodec: ModelToolNameCodec,
): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: toolNameCodec.encode(tool.name),
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  };
}

function openAiToolChoice(mode: ModelGatewayRequest['tool_choice']): 'auto' | 'none' | 'required' {
  return mode;
}

function finishReasonFromOpenAi(
  reason: string | null | undefined,
): ModelGatewayResponse['finish_reason'] {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    case 'length':
      return 'length';
    case 'stop':
    case undefined:
    case null:
      return 'stop';
    default:
      return 'error';
  }
}

function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Throw below with a stable normalized error.
  }
  throw new ModelGatewayError(
    'MODEL_GATEWAY_INVALID_TOOL_ARGUMENTS',
    'OpenAI-compatible tool call arguments must be a JSON object',
    {
      errorClass: 'validation',
    },
  );
}

function messageContentToText(content: ModelGatewayRequest['messages'][number]['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

function providerSafeToolName(canonicalName: string): string {
  if (
    PROVIDER_SAFE_TOOL_NAME_PATTERN.test(canonicalName) &&
    canonicalName.length <= PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH
  ) {
    return canonicalName;
  }
  const slug =
    canonicalName
      .replace(/[^A-Za-z0-9_-]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 40) || 'tool';
  const hash = createHash('sha256').update(canonicalName).digest('hex').slice(0, 12);
  return `tool_${slug}_${hash}`.slice(0, PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH);
}

function assertUniqueToolCallIds(ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new ModelGatewayError(
        'MODEL_GATEWAY_DUPLICATE_TOOL_CALL_ID',
        `Duplicate assistant tool_call id: ${id}`,
        {
          errorClass: 'validation',
        },
      );
    }
    seen.add(id);
  }
}

function validateToolRoundTripMessages(messages: ModelGatewayRequest['messages']): void {
  const assistantToolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== 'tool_call') {
          continue;
        }
        if (assistantToolCallIds.has(block.id)) {
          throw new ModelGatewayError(
            'MODEL_GATEWAY_DUPLICATE_TOOL_CALL_ID',
            `Duplicate assistant tool_call id: ${block.id}`,
            {
              errorClass: 'validation',
            },
          );
        }
        assistantToolCallIds.add(block.id);
      }
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id) {
        throw new ModelGatewayError(
          'MODEL_GATEWAY_TOOL_RESULT_ID_REQUIRED',
          'Tool result messages must include tool_call_id',
          {
            errorClass: 'validation',
          },
        );
      }
      if (!assistantToolCallIds.has(message.tool_call_id)) {
        throw new ModelGatewayError(
          'MODEL_GATEWAY_UNKNOWN_TOOL_RESULT_ID',
          `Tool result does not match an assistant tool_call: ${message.tool_call_id}`,
          {
            errorClass: 'validation',
          },
        );
      }
      if (toolResultIds.has(message.tool_call_id)) {
        throw new ModelGatewayError(
          'MODEL_GATEWAY_DUPLICATE_TOOL_RESULT',
          `Duplicate tool result for tool_call_id: ${message.tool_call_id}`,
          {
            errorClass: 'validation',
          },
        );
      }
      toolResultIds.add(message.tool_call_id);
    }
  }
}

function errorFromStatus(statusCode: number): ModelGatewayError {
  if (statusCode === 401 || statusCode === 403) {
    return new ModelGatewayError(
      'MODEL_GATEWAY_AUTH_FAILED',
      'Model Gateway authentication failed',
      {
        errorClass: 'auth',
        httpStatus: statusCode,
      },
    );
  }
  if (statusCode === 408 || statusCode === 504) {
    return new ModelGatewayError('MODEL_GATEWAY_TIMEOUT', 'Model Gateway request timed out', {
      errorClass: 'timeout',
      httpStatus: statusCode,
    });
  }
  if (statusCode === 429) {
    return new ModelGatewayError(
      'MODEL_GATEWAY_RATE_LIMITED',
      'Model Gateway rate limited request',
      {
        errorClass: 'rate_limit',
        httpStatus: statusCode,
      },
    );
  }
  if (statusCode >= 500) {
    return new ModelGatewayError('MODEL_GATEWAY_UPSTREAM_FAILED', 'Model Gateway upstream failed', {
      errorClass: 'upstream_5xx',
      httpStatus: statusCode,
    });
  }
  return new ModelGatewayError('MODEL_GATEWAY_REQUEST_FAILED', 'Model Gateway request failed', {
    errorClass: 'upstream_4xx',
    httpStatus: statusCode,
  });
}

function normalizeModelGatewayError(error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) {
    return error;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ModelGatewayError('MODEL_GATEWAY_ABORTED', 'Model Gateway request was aborted', {
      errorClass: 'aborted',
    });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ModelGatewayError('MODEL_GATEWAY_ABORTED', 'Model Gateway request was aborted', {
      errorClass: 'aborted',
    });
  }
  if (error instanceof Error && /timeout|timed out/iu.test(error.message)) {
    return new ModelGatewayError('MODEL_GATEWAY_TIMEOUT', 'Model Gateway request timed out', {
      errorClass: 'timeout',
    });
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return new ModelGatewayError(
      'MODEL_GATEWAY_INVALID_RESPONSE',
      'Model Gateway response did not match the expected schema',
      {
        errorClass: 'validation',
      },
    );
  }
  if (error instanceof Error) {
    return new ModelGatewayError(
      'MODEL_GATEWAY_NETWORK_ERROR',
      'Model Gateway network request failed',
      { errorClass: 'network' },
    );
  }
  return new ModelGatewayError('MODEL_GATEWAY_UNKNOWN_ERROR', 'Model Gateway request failed', {
    errorClass: 'unknown',
  });
}

function isRetryableModelGatewayError(
  error: ModelGatewayError,
  options: ModelGatewayCallOptions,
): boolean {
  if (
    error.httpStatus !== undefined &&
    options.retryableStatusCodes &&
    !options.retryableStatusCodes.includes(error.httpStatus)
  ) {
    return false;
  }
  if (error.errorClass === 'timeout') {
    return options.retryOnTimeout ?? true;
  }
  if (error.errorClass === 'network') {
    return options.retryOnNetworkError ?? true;
  }
  return error.errorClass === 'rate_limit' || error.errorClass === 'upstream_5xx';
}

function assertTransportAllowed(url: URL, allowInsecureHttp: boolean): void {
  if (url.protocol === 'https:') {
    return;
  }
  if (url.protocol === 'http:' && allowInsecureHttp) {
    return;
  }
  throw new ModelGatewayError(
    'MODEL_GATEWAY_INSECURE_TRANSPORT',
    'Model Gateway base URL must use HTTPS unless local insecure HTTP is explicitly allowed',
    {
      errorClass: 'policy',
    },
  );
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}

function endpointUrl(baseUrl: URL, path: string): URL {
  const normalizedBasePath = baseUrl.pathname.endsWith('/')
    ? baseUrl.pathname
    : `${baseUrl.pathname}/`;
  const normalizedPath = path.replace(/^\/+/u, '');
  const url = new URL(baseUrl.toString());
  url.pathname = `${normalizedBasePath}${normalizedPath}`.replace(/\/{2,}/gu, '/');
  url.search = '';
  url.hash = '';
  return url;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          new ModelGatewayError('MODEL_GATEWAY_ABORTED', 'Model Gateway request was aborted', {
            errorClass: 'aborted',
          }),
        );
      },
      { once: true },
    );
  });
}

function cryptoHash(value: unknown): string {
  let hash = 0;
  const text = JSON.stringify(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}
