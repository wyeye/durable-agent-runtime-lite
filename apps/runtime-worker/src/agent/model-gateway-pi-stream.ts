import { createHash } from 'node:crypto';
import {
  modelGatewayResponseSchema,
  modelGatewayRequestSchema,
  type AgentExecutionPlan,
  type AgentRunRecord,
  type ModelGatewayMessage,
  type ModelGatewayResponse,
  type ModelRequestPolicy,
  type ModelTarget,
} from '@dar/contracts';
import {
  ModelCallAttemptRepository,
  ModelCallLogRepository,
  type Database,
  type ModelCallCreateOrGetResult,
} from '@dar/db';
import {
  ModelGatewayClient,
  ModelGatewayError,
  ModelToolNameCodec,
  type ModelGatewayAttemptCompleteEvent,
} from '@dar/model-client';
import {
  type AssistantMessage,
  type Context,
  type Model,
  type Usage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Kysely } from 'kysely';

export interface ModelGatewayPiStreamOptions {
  db: Kysely<Database>;
  baseUrl: string;
  apiKey?: string;
  executionPlan: AgentExecutionPlan;
  agentRun: AgentRunRecord;
  segmentIndex: number;
  timeoutMs: number;
  maxRetries: number;
  maxResponseBytes: number;
  maxLedgerResponseBytes: number;
  allowInsecureHttp: boolean;
  idempotencyHeader: string;
  userAgent: string;
  allowedModelIds?: Set<string>;
}

export function createModelGatewayModel(
  target: Pick<ModelTarget, 'model_id' | 'gateway_profile'>,
): Model<string> {
  return {
    id: target.model_id,
    name: target.model_id,
    api: 'dar-model-gateway',
    provider: target.gateway_profile,
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  };
}

export function createModelGatewayPiStream(options: ModelGatewayPiStreamOptions): StreamFn {
  const targets = resolveAllowedTargets(options);
  const client = new ModelGatewayClient({
    baseUrl: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    protocol: options.executionPlan.resolved_model_policy.protocol,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    maxResponseBytes: options.maxResponseBytes,
    allowInsecureHttp: options.allowInsecureHttp,
    idempotencyHeader: options.idempotencyHeader,
    userAgent: options.userAgent,
  });
  let turnIndex = 0;

  return async (_model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    const modelTurnIndex = turnIndex;
    turnIndex += 1;
    void callModelWithLedger({
      ...options,
      client,
      targets,
      context,
      ...(streamOptions?.maxTokens !== undefined ? { maxTokens: streamOptions.maxTokens } : {}),
      ...(streamOptions?.signal ? { signal: streamOptions.signal } : {}),
      modelTurnIndex,
    })
      .then(({ response, target }) => {
        const message = assistantMessageFromGatewayResponse(response, target);
        pushFinal(stream, withGatewayModel(message, target));
      })
      .catch((error: unknown) => {
        const message = withGatewayModel(
          fauxAssistantMessage([], {
            stopReason: streamOptions?.signal?.aborted ? 'aborted' : 'error',
            errorMessage: error instanceof Error ? error.message : 'Model Gateway request failed',
          }),
          firstTarget(targets),
        );
        stream.push({ type: 'start', partial: message });
        stream.push({
          type: 'error',
          reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
          error: message,
        });
        stream.end(message);
      });
    return stream;
  };
}

async function callModelWithLedger(
  input: ModelGatewayPiStreamOptions & {
    client: ModelGatewayClient;
    targets: ModelTarget[];
    context: Context;
    maxTokens?: number;
    signal?: AbortSignal;
    modelTurnIndex: number;
  },
): Promise<{ response: ModelGatewayResponse; target: ModelTarget }> {
  const logRepository = new ModelCallLogRepository(input.db);
  const attemptRepository = new ModelCallAttemptRepository(input.db);
  const requestBase = {
    messages: contextToGatewayMessages(input.context),
    tools: input.executionPlan.allowed_tools.map((tool) => ({
      name: tool.tool_name,
      description: tool.description,
      input_schema: tool.input_schema,
    })),
    response_format: input.executionPlan.resolved_model_policy.request_policy.response_format,
    temperature: input.executionPlan.resolved_model_policy.request_policy.temperature,
    top_p: input.executionPlan.resolved_model_policy.request_policy.top_p,
    max_output_tokens:
      input.maxTokens ?? input.executionPlan.resolved_model_policy.request_policy.max_output_tokens,
    parallel_tool_calls:
      input.executionPlan.resolved_model_policy.request_policy.allow_parallel_tool_calls,
    request_id: `${input.agentRun.agent_run_id}:${input.segmentIndex}:${input.modelTurnIndex}`,
    task_run_id: input.agentRun.task_run_id,
    agent_run_id: input.agentRun.agent_run_id,
  };
  const toolNameCodec = ModelToolNameCodec.fromTools(requestBase.tools);
  let globalAttemptIndex = 0;
  const logicalRequestKey = buildModelRequestKey(
    input.agentRun.agent_run_id,
    input.segmentIndex,
    input.modelTurnIndex,
    input.executionPlan.model_policy_hash,
  );
  const logicalRequestHash = hashJson({
    ...requestBase,
    model_request_key: logicalRequestKey,
    model_policy_hash: input.executionPlan.model_policy_hash,
    protocol: input.executionPlan.resolved_model_policy.protocol,
  });

  let lastError: unknown;
  for (const [fallbackIndex, target] of input.targets.entries()) {
    const request = modelGatewayRequestSchema.parse({
      ...requestBase,
      model_request_key: logicalRequestKey,
      model: target.model_id,
      tool_choice: toolChoiceForTurn(
        input.executionPlan.resolved_model_policy.request_policy,
        requestBase.messages,
      ),
    });
    const createResult = await logRepository.createOrGet({
      model_request_key: request.model_request_key,
      tenant_id: input.agentRun.tenant_id,
      user_id: input.agentRun.user_id,
      task_run_id: input.agentRun.task_run_id,
      workflow_id: input.agentRun.workflow_id,
      ...(input.agentRun.workflow_run_id
        ? { workflow_run_id: input.agentRun.workflow_run_id }
        : {}),
      agent_run_id: input.agentRun.agent_run_id,
      segment_index: input.segmentIndex,
      model_turn_index: input.modelTurnIndex,
      model_policy_id: input.executionPlan.model_policy_id,
      model_policy_version: input.executionPlan.model_policy_version,
      model_policy_hash: input.executionPlan.model_policy_hash,
      protocol: input.executionPlan.resolved_model_policy.protocol,
      request_hash: logicalRequestHash,
      fallback_index: fallbackIndex,
    });
    if (createResult.decision === 'conflict') {
      throw new Error(`MODEL_CALL_IDEMPOTENCY_CONFLICT: ${request.model_request_key}`);
    }
    if (createResult.decision === 'replay') {
      return { response: responseFromRecordedCall(createResult), target };
    }
    globalAttemptIndex = await nextGlobalAttemptIndex(
      attemptRepository,
      createResult.record.model_call_id,
      globalAttemptIndex,
    );

    const attempts = new Map<number, string>();
    try {
      await logRepository.markRunning(createResult.record.model_call_id, {
        targetId: target.target_id,
        provider: target.gateway_profile,
        modelId: target.model_id,
        fallbackIndex,
      });
      const response = await input.client.call(request, {
        protocol: input.executionPlan.resolved_model_policy.protocol,
        target,
        toolNameCodec,
        maxRetries: Math.min(
          Math.max(target.max_retries ?? 0, 0),
          Math.max(
            input.executionPlan.resolved_model_policy.retry_policy.max_attempts_per_target - 1,
            0,
          ),
        ),
        retryableStatusCodes:
          input.executionPlan.resolved_model_policy.retry_policy.retryable_status_codes,
        retryOnTimeout: input.executionPlan.resolved_model_policy.retry_policy.retry_on_timeout,
        retryOnNetworkError:
          input.executionPlan.resolved_model_policy.retry_policy.retry_on_network_error,
        retryBackoffMs: input.executionPlan.resolved_model_policy.retry_policy.backoff_ms,
        ...(input.signal ? { signal: input.signal } : {}),
        onAttemptStart: async (event) => {
          const nextGlobalAttemptIndex = globalAttemptIndex;
          globalAttemptIndex += 1;
          const attempt = await attemptRepository.startAttempt({
            model_call_id: createResult.record.model_call_id,
            global_attempt_index: nextGlobalAttemptIndex,
            target_attempt_index: event.attemptIndex,
            fallback_index: fallbackIndex,
            target_id: event.targetId,
            provider: event.provider,
            model_id: event.modelId,
          });
          attempts.set(event.attemptIndex, attempt.attempt_id);
        },
        onAttemptComplete: async (event) => {
          await completeAttempt(attemptRepository, attempts, event);
        },
      });
      await logRepository.markSucceeded(createResult.record.model_call_id, {
        targetId: target.target_id,
        provider: target.gateway_profile,
        modelId: response.model ?? target.model_id,
        attemptCount: globalAttemptIndex,
        fallbackIndex,
        finishReason: response.finish_reason,
        ...(response.response_id ? { responseId: response.response_id } : {}),
        usage: normalizeUsage(response),
        responseHash: hashJson(response),
        safeResponseJson: safeResponse(response, input.maxLedgerResponseBytes),
      });
      return { response, target };
    } catch (error) {
      lastError = error;
      await logRepository.markFailed(createResult.record.model_call_id, {
        status: input.signal?.aborted
          ? 'cancelled'
          : errorClass(error) === 'timeout'
            ? 'timed_out'
            : 'failed',
        attemptCount: globalAttemptIndex,
        fallbackIndex,
        errorClass: errorClass(error),
        errorCode: errorCode(error),
      });
      if (
        !input.executionPlan.resolved_model_policy.fallback_policy.enabled ||
        !errorEligibleForFallback(
          error,
          input.executionPlan.resolved_model_policy.fallback_policy.eligible_error_classes,
        )
      ) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Model Gateway call failed');
}

function resolveAllowedTargets(options: ModelGatewayPiStreamOptions): ModelTarget[] {
  const targets = [...options.executionPlan.resolved_model_policy.resolved_targets].sort(
    (left, right) =>
      left.priority === right.priority
        ? left.target_id.localeCompare(right.target_id)
        : left.priority - right.priority,
  );
  const filtered =
    options.allowedModelIds && options.allowedModelIds.size > 0
      ? targets.filter(
          (target) =>
            options.allowedModelIds?.has(target.model_id) ||
            options.allowedModelIds?.has(target.target_id),
        )
      : targets;
  if (filtered.length === 0) {
    throw new Error(
      'AGENT_MODEL_DENIED_BY_TENANT_POLICY: no ModelPolicy target is allowed by tenant policy',
    );
  }
  return filtered;
}

function firstTarget(targets: ModelTarget[]): ModelTarget {
  const target = targets[0];
  if (!target) {
    throw new Error('AGENT_MODEL_DENIED_BY_TENANT_POLICY: no ModelPolicy target is available');
  }
  return target;
}

async function completeAttempt(
  repository: ModelCallAttemptRepository,
  attempts: Map<number, string>,
  event: ModelGatewayAttemptCompleteEvent,
): Promise<void> {
  const attemptId = attempts.get(event.attemptIndex);
  if (!attemptId) {
    return;
  }
  await repository.completeAttempt(attemptId, {
    status: event.status,
    ...(event.httpStatus !== undefined ? { http_status: event.httpStatus } : {}),
    ...(event.errorClass ? { error_class: event.errorClass } : {}),
    ...(event.errorCode ? { error_code: event.errorCode } : {}),
    latency_ms: event.latencyMs,
    ...(event.responseId ? { response_id: event.responseId } : {}),
  });
}

async function nextGlobalAttemptIndex(
  repository: ModelCallAttemptRepository,
  modelCallId: string,
  fallbackValue: number,
): Promise<number> {
  const attempts = await repository.listByModelCall(modelCallId);
  const maxRecordedIndex = attempts.reduce(
    (maxIndex, attempt) => Math.max(maxIndex, attempt.global_attempt_index),
    -1,
  );
  return Math.max(fallbackValue, maxRecordedIndex + 1);
}

function responseFromRecordedCall(
  createResult: Extract<ModelCallCreateOrGetResult, { decision: 'replay' }>,
): ModelGatewayResponse {
  const safe = createResult.record.safe_response_json;
  return modelGatewayRequestSafeResponseSchema.parse(safe);
}

const modelGatewayRequestSafeResponseSchema = modelGatewayResponseSchema;

function safeResponse(response: ModelGatewayResponse, maxBytes: number): Record<string, unknown> {
  const safe = {
    response_id: response.response_id,
    model: response.model,
    provider: response.provider,
    finish_reason: response.finish_reason,
    usage: normalizeUsage(response),
    message: {
      role: 'assistant',
      content: response.message.content.map((block) =>
        block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'tool_call', id: block.id, name: block.name, arguments: block.arguments },
      ),
    },
  };
  const size = Buffer.byteLength(JSON.stringify(safe), 'utf8');
  if (size > maxBytes) {
    throw new ModelGatewayError(
      'MODEL_RESPONSE_LEDGER_LIMIT_EXCEEDED',
      'Normalized model response exceeds ledger size limit',
      {
        errorClass: 'response_too_large',
      },
    );
  }
  return safe;
}

function normalizeUsage(response: ModelGatewayResponse): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_total_cost?: number;
} {
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const totalTokens = response.usage?.total_tokens ?? inputTokens + outputTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    ...(response.usage?.estimated_total_cost !== undefined
      ? { estimated_total_cost: response.usage.estimated_total_cost }
      : {}),
  };
}

function buildModelRequestKey(
  agentRunId: string,
  segmentIndex: number,
  modelTurnIndex: number,
  modelPolicyHash: string,
): string {
  return [
    'model',
    sanitizeKey(agentRunId),
    'segment',
    String(segmentIndex),
    'turn',
    String(modelTurnIndex),
    modelPolicyHash.slice(0, 16),
  ].join(':');
}

function pushFinal(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
): void {
  stream.push({ type: 'start', partial: message });
  for (const [index, block] of message.content.entries()) {
    if (block.type === 'text') {
      stream.push({ type: 'text_start', contentIndex: index, partial: message });
      stream.push({ type: 'text_delta', contentIndex: index, delta: block.text, partial: message });
      stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: message });
      continue;
    }
    if (block.type === 'toolCall') {
      stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
      stream.push({
        type: 'toolcall_delta',
        contentIndex: index,
        delta: JSON.stringify(block.arguments),
        partial: message,
      });
      stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial: message });
    }
  }
  stream.push({ type: 'done', reason: doneReason(message.stopReason), message });
  stream.end(message);
}

function withGatewayModel(
  message: AssistantMessage,
  target: Pick<ModelTarget, 'model_id' | 'gateway_profile'>,
): AssistantMessage {
  return {
    ...message,
    api: 'dar-model-gateway',
    provider: target.gateway_profile,
    model: target.model_id,
  };
}

function assistantMessageFromGatewayResponse(
  response: ModelGatewayResponse,
  target: Pick<ModelTarget, 'model_id' | 'gateway_profile'>,
): AssistantMessage {
  const content = response.message.content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    return {
      type: 'toolCall' as const,
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    };
  });
  const usage = normalizeUsage(response);
  return {
    ...fauxAssistantMessage(content, {
      stopReason: stopReasonFromFinishReason(response.finish_reason),
    }),
    model: response.model ?? target.model_id,
    usage: usageFromGateway(usage),
  };
}

function stopReasonFromFinishReason(
  finishReason: ModelGatewayResponse['finish_reason'],
): AssistantMessage['stopReason'] {
  switch (finishReason) {
    case 'tool_call':
      return 'toolUse';
    case 'length':
      return 'length';
    case 'error':
      return 'error';
    case 'stop':
      return 'stop';
  }
}

function doneReason(stopReason: AssistantMessage['stopReason']): 'stop' | 'length' | 'toolUse' {
  if (stopReason === 'toolUse' || stopReason === 'length') {
    return stopReason;
  }
  return 'stop';
}

function usageFromGateway(usage: {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_total_cost?: number;
}): Usage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: usage.total_tokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: usage.estimated_total_cost ?? 0,
    },
  };
}

function contextToGatewayMessages(context: Context): ModelGatewayMessage[] {
  const messages: ModelGatewayMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: contentToText(message.content) });
    } else if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: assistantContentToGateway(message.content) });
    } else if (message.role === 'toolResult') {
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: contentToText(message.content),
      });
    }
  }
  return messages;
}

function assistantContentToGateway(content: unknown): ModelGatewayMessage['content'] {
  if (!Array.isArray(content)) {
    return '';
  }
  const blocks: Extract<ModelGatewayMessage['content'], unknown[]> = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (
      block.type === 'toolCall' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      blocks.push({
        type: 'tool_call',
        id: block.id,
        name: block.name,
        arguments: isRecord(block.arguments) ? block.arguments : {},
      });
    }
  }
  return blocks;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .flatMap((block) => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block
      ) {
        return typeof block.text === 'string' ? [block.text] : [];
      }
      return [];
    })
    .join('\n');
}

function toolChoiceForTurn(
  policy: ModelRequestPolicy,
  messages: ModelGatewayMessage[],
): ModelRequestPolicy['initial_tool_choice_mode'] {
  return messages.some((message) => message.role === 'tool')
    ? policy.after_tool_result_tool_choice_mode
    : policy.initial_tool_choice_mode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hashJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortJson(value)))
    .digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function errorClass(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'errorClass' in error &&
    typeof error.errorClass === 'string'
    ? error.errorClass
    : 'unknown';
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : error instanceof Error
      ? error.name
      : 'MODEL_GATEWAY_FAILED';
}

function errorEligibleForFallback(error: unknown, eligibleClasses: string[]): boolean {
  return eligibleClasses.includes(errorClass(error));
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, '-');
}
