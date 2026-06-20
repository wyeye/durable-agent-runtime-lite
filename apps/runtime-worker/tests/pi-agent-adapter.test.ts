import { describe, expect, it } from 'vitest';
import type { AgentExecutionPlan, AgentRunRecord, ResolvedModelPolicy } from '@dar/contracts';
import type { Database } from '@dar/db';
import type { Kysely } from 'kysely';
import { createDeterministicPiStream } from '../src/agent/deterministic-pi-stream.js';
import {
  createModelGatewayModel,
  createModelGatewayPiStream,
} from '../src/agent/model-gateway-pi-stream.js';
import { runPiAgentSegment } from '../src/agent/pi-agent-adapter.js';
import {
  restorePiMessages,
  serializePiContext,
  replaceDeferredToolResults,
} from '../src/agent/pi-context-codec.js';

describe('PiAgentAdapter', () => {
  it('runs the real Pi Agent loop and stops at deferred tool boundary', async () => {
    const runtime = createDeterministicPiStream('readonly_tool');
    try {
      const result = await runPiAgentSegment({
        executionPlan: plan('deterministic:readonly_tool'),
        model: runtime.model,
        streamFn: runtime.streamFn,
        initialUserInput: 'find context',
        segmentIndex: 0,
        budgetRemaining: plan('deterministic:readonly_tool').budget,
        maxContextBytes: 262_144,
      });

      if (result.segmentResult.status !== 'tool_requested') {
        throw new Error(`expected tool request, got ${JSON.stringify(result.segmentResult)}`);
      }
      expect(result.segmentResult.status).toBe('tool_requested');
      expect(result.segmentResult.proposed_tool_calls[0]).toMatchObject({
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        tool_sha256: 'a'.repeat(64),
      });
      expect(result.context.messages.some((message) => message.role === 'toolResult')).toBe(true);
    } finally {
      runtime.unregister();
    }
  });

  it('returns cancelled when an AbortSignal is already aborted before the Pi turn starts', async () => {
    const runtime = createDeterministicPiStream('readonly_tool');
    const controller = new AbortController();
    controller.abort('test cancellation');

    try {
      const result = await runPiAgentSegment({
        executionPlan: plan('deterministic:readonly_tool'),
        model: runtime.model,
        streamFn: runtime.streamFn,
        initialUserInput: 'find context',
        segmentIndex: 0,
        budgetRemaining: plan('deterministic:readonly_tool').budget,
        maxContextBytes: 262_144,
        abortSignal: controller.signal,
      });

      expect(result.segmentResult).toMatchObject({
        status: 'cancelled',
        error_code: 'AGENT_CANCELLED',
      });
    } finally {
      runtime.unregister();
    }
  });

  it('sanitizes hidden reasoning and replaces deferred tool result idempotently', () => {
    const context = serializePiContext(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret chain of thought', thinkingSignature: 'opaque' },
            { type: 'text', text: 'visible answer with Authorization: Bearer abc123' },
            {
              type: 'toolCall',
              id: 'call_1',
              name: 'knowledge.search',
              arguments: { api_key: 'secret', query: 'x' },
            },
          ],
          api: 'test',
          provider: 'test',
          model: 'test',
          diagnostics: [{ hidden_reasoning: 'do not store' }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'knowledge.search',
          content: [
            { type: 'text', text: 'Deferred tool proposal captured for knowledge.search.' },
          ],
          details: { kind: 'deferred_tool_proposal', token: 'secret-token' },
          isError: false,
          timestamp: 2,
        },
      ],
      { maxBytes: 262_144 },
    );

    expect(JSON.stringify(context)).not.toContain('secret chain of thought');
    expect(JSON.stringify(context)).not.toContain('hidden_reasoning');
    expect(JSON.stringify(context)).not.toContain('abc123');
    expect(JSON.stringify(context)).toContain('[REDACTED]');

    const restored = restorePiMessages(context);
    const replaced = replaceDeferredToolResults(
      restored,
      [
        {
          tool_call_id: 'call_1',
          tool_name: 'knowledge.search',
          tool_version: '1.0.0',
          result_summary: 'real result',
          is_error: false,
          content: [{ type: 'text', text: 'real result' }],
          details: { result_ref: 'ref_1' },
        },
      ],
      { maxBytes: 262_144 },
    );

    const toolResults = replaced.messages.filter((message) => message.role === 'toolResult');
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0])).toContain('authoritative_tool_result');
    expect(JSON.stringify(toolResults[0])).toContain('real result');
  });

  it('preserves handoff call id for authoritative result replacement', async () => {
    const runtime = createDeterministicPiStream('handoff');
    try {
      const executionPlan = {
        ...plan('deterministic:handoff'),
        allowed_handoffs: ['db://flow-execution-plan/plan_handoff'],
        plan: {
          ...plan('deterministic:handoff').plan,
          allowed_handoffs: ['db://flow-execution-plan/plan_handoff'],
        },
      };
      const result = await runPiAgentSegment({
        executionPlan,
        model: runtime.model,
        streamFn: runtime.streamFn,
        initialUserInput: 'handoff',
        segmentIndex: 0,
        budgetRemaining: executionPlan.budget,
        maxContextBytes: 262_144,
      });

      expect(result.segmentResult.status).toBe('handoff_requested');
      if (result.segmentResult.status !== 'handoff_requested') {
        throw new Error('expected handoff request');
      }
      expect(result.segmentResult.call_id).toBe('call_handoff_1');
    } finally {
      runtime.unregister();
    }
  });

  it('maps structured Model Gateway tool calls into Pi deferred tool proposals', async () => {
    const observedRequests: Array<{
      url: string;
      idempotencyKey: string | undefined;
      body: Record<string, unknown>;
    }> = [];
    const server = await import('node:http').then(({ createServer }) =>
      createServer((request, response) => {
        if (request.url !== '/v1/chat/completions') {
          response.statusCode = 404;
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          observedRequests.push({
            url: request.url ?? '',
            idempotencyKey:
              typeof request.headers['idempotency-key'] === 'string'
                ? request.headers['idempotency-key']
                : undefined,
            body: JSON.parse(bodyText) as Record<string, unknown>,
          });
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              id: 'chatcmpl_1',
              model: 'dar-local-model',
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_model_1',
                        type: 'function',
                        function: {
                          name: 'tool_knowledge_search_f2405c6159c9',
                          arguments: JSON.stringify({ query: 'from model gateway' }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
            }),
          );
        });
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server did not bind to a TCP port');
    }
    const executionPlan = plan('model_gateway:readonly_tool');
    const target = firstModelTarget(executionPlan);
    const ledger = createModelCallLedgerDb();
    try {
      const result = await runPiAgentSegment({
        executionPlan,
        model: createModelGatewayModel(target),
        streamFn: createModelGatewayPiStream({
          db: ledger.db,
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: 'test-key',
          executionPlan,
          agentRun: agentRunFor(executionPlan),
          segmentIndex: 0,
          timeoutMs: 5_000,
          maxRetries: 0,
          maxResponseBytes: 1_000_000,
          maxLedgerResponseBytes: 1_048_576,
          allowInsecureHttp: true,
          idempotencyHeader: 'Idempotency-Key',
          userAgent: 'durable-agent-runtime-lite/runtime-worker-test',
          allowedModelIds: new Set([target.model_id]),
        }),
        initialUserInput: 'readonly_tool',
        segmentIndex: 0,
        budgetRemaining: executionPlan.budget,
        maxContextBytes: 262_144,
      });

      if (result.segmentResult.status !== 'tool_requested') {
        throw new Error(`expected tool request, got ${JSON.stringify(result.segmentResult)}`);
      }
      expect(result.segmentResult.status).toBe('tool_requested');
      expect(result.segmentResult.proposed_tool_calls[0]).toMatchObject({
        call_id: 'call_model_1',
        tool_name: 'knowledge.search',
        arguments: { query: 'from model gateway' },
      });
      expect(result.segmentResult.usage.total_tokens).toBe(7);
      expect(observedRequests[0]).toMatchObject({
        url: '/v1/chat/completions',
        idempotencyKey: expect.stringContaining('model:agent_run_1:segment:0:turn:0:'),
      });
      expect(observedRequests[0]?.body).toMatchObject({
        model: 'dar-local-model',
        tool_choice: 'auto',
      });
      expect(JSON.stringify(observedRequests[0]?.body)).not.toContain('knowledge.search');
      expect(JSON.stringify(observedRequests[0]?.body)).toContain(
        'tool_knowledge_search_f2405c6159c9',
      );
      expect(ledger.modelCalls[0]).toMatchObject({
        tenant_id: 'tenant_1',
        agent_run_id: 'agent_run_1',
        model_policy_id: executionPlan.model_policy_id,
        model_policy_version: executionPlan.model_policy_version,
        model_policy_hash: executionPlan.model_policy_hash,
        target_id: target.target_id,
        model_id: target.model_id,
        protocol: 'openai_chat_completions',
        status: 'succeeded',
        total_tokens: 7,
      });
      expect(ledger.attempts[0]).toMatchObject({
        model_call_id: ledger.modelCalls[0]?.model_call_id,
        target_id: target.target_id,
        model_id: target.model_id,
        status: 'succeeded',
      });
      expect(JSON.stringify(ledger.modelCalls[0]?.safe_response_json)).not.toContain('test-key');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('keeps assistant tool call ids and sends tool results with after-tool tool choice', async () => {
    const observedRequests: Array<Record<string, unknown>> = [];
    const server = await import('node:http').then(({ createServer }) =>
      createServer((request, response) => {
        if (request.url !== '/v1/chat/completions') {
          response.statusCode = 404;
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >;
          observedRequests.push(body);
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              id: `chatcmpl_${observedRequests.length}`,
              model: 'dar-local-model',
              choices:
                observedRequests.length === 1
                  ? [
                      {
                        finish_reason: 'tool_calls',
                        message: {
                          role: 'assistant',
                          content: null,
                          tool_calls: [
                            {
                              id: 'call_model_1',
                              type: 'function',
                              function: {
                                name: 'tool_knowledge_search_f2405c6159c9',
                                arguments: JSON.stringify({ query: 'from model gateway' }),
                              },
                            },
                          ],
                        },
                      },
                    ]
                  : [
                      {
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: 'final after tool' },
                      },
                    ],
              usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
            }),
          );
        });
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server did not bind to a TCP port');
    }
    const executionPlan = {
      ...plan('model_gateway:readonly_tool'),
      resolved_model_policy: {
        ...plan('model_gateway:readonly_tool').resolved_model_policy,
        request_policy: {
          ...plan('model_gateway:readonly_tool').resolved_model_policy.request_policy,
          initial_tool_choice_mode: 'required',
          after_tool_result_tool_choice_mode: 'none',
        },
      },
    };
    const target = firstModelTarget(executionPlan);
    const ledger = createModelCallLedgerDb();
    const streamFn = createModelGatewayPiStream({
      db: ledger.db,
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      executionPlan,
      agentRun: agentRunFor(executionPlan),
      segmentIndex: 0,
      timeoutMs: 5_000,
      maxRetries: 0,
      maxResponseBytes: 1_000_000,
      maxLedgerResponseBytes: 1_048_576,
      allowInsecureHttp: true,
      idempotencyHeader: 'Idempotency-Key',
      userAgent: 'durable-agent-runtime-lite/runtime-worker-test',
      allowedModelIds: new Set([target.model_id]),
    });
    try {
      const first = await runPiAgentSegment({
        executionPlan,
        model: createModelGatewayModel(target),
        streamFn,
        initialUserInput: 'readonly_tool',
        segmentIndex: 0,
        budgetRemaining: executionPlan.budget,
        maxContextBytes: 262_144,
      });
      if (first.segmentResult.status !== 'tool_requested') {
        throw new Error(`expected tool request, got ${JSON.stringify(first.segmentResult)}`);
      }
      expect(first.segmentResult.status).toBe('tool_requested');
      const nextContext = replaceDeferredToolResults(
        first.messages,
        [
          {
            tool_call_id: 'call_model_1',
            tool_name: 'knowledge.search',
            tool_version: '1.0.0',
            result_summary: 'real result',
            is_error: false,
            content: [{ type: 'text', text: 'real result' }],
            details: { result_ref: 'ref_1' },
          },
        ],
        { maxBytes: 262_144 },
      );

      const second = await runPiAgentSegment({
        executionPlan,
        model: createModelGatewayModel(target),
        streamFn,
        contextMessages: nextContext.messages,
        segmentIndex: 1,
        budgetRemaining: executionPlan.budget,
        maxContextBytes: 262_144,
      });

      expect(second.segmentResult.status).toBe('completed');
      expect(observedRequests[0]).toMatchObject({ tool_choice: 'required' });
      expect(observedRequests[1]).toMatchObject({
        tool_choice: 'none',
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            tool_calls: [
              expect.objectContaining({
                id: 'call_model_1',
                function: expect.objectContaining({ name: 'tool_knowledge_search_f2405c6159c9' }),
              }),
            ],
          }),
          expect.objectContaining({
            role: 'tool',
            tool_call_id: 'call_model_1',
            content: 'real result',
          }),
        ]),
      });
      expect(ledger.modelCalls).toHaveLength(2);
      expect(String(ledger.modelCalls[0]?.model_request_key)).not.toContain(target.target_id);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('resumes failed logical model calls with the next global attempt index', async () => {
    let requestCount = 0;
    const server = await import('node:http').then(({ createServer }) =>
      createServer((request, response) => {
        if (request.url !== '/v1/chat/completions') {
          response.statusCode = 404;
          response.end();
          return;
        }
        request.resume();
        request.on('end', () => {
          requestCount += 1;
          response.setHeader('content-type', 'application/json');
          if (requestCount === 1) {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: { message: 'temporary unavailable' } }));
            return;
          }
          response.end(
            JSON.stringify({
              id: 'chatcmpl_recovered',
              model: 'dar-local-model',
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_recovered_1',
                        type: 'function',
                        function: {
                          name: 'tool_knowledge_search_f2405c6159c9',
                          arguments: JSON.stringify({ query: 'after retry recovery' }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
            }),
          );
        });
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server did not bind to a TCP port');
    }
    const executionPlan = plan('model_gateway:readonly_tool');
    const target = firstModelTarget(executionPlan);
    const ledger = createModelCallLedgerDb();
    const streamOptions = {
      db: ledger.db,
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      executionPlan,
      agentRun: agentRunFor(executionPlan),
      segmentIndex: 0,
      timeoutMs: 5_000,
      maxRetries: 0,
      maxResponseBytes: 1_000_000,
      maxLedgerResponseBytes: 1_048_576,
      allowInsecureHttp: true,
      idempotencyHeader: 'Idempotency-Key',
      userAgent: 'durable-agent-runtime-lite/runtime-worker-test',
      allowedModelIds: new Set([target.model_id]),
    };
    try {
      const failed = await runPiAgentSegment({
        executionPlan,
        model: createModelGatewayModel(target),
        streamFn: createModelGatewayPiStream(streamOptions),
        initialUserInput: 'readonly_tool',
        segmentIndex: 0,
        budgetRemaining: executionPlan.budget,
        maxContextBytes: 262_144,
      });
      expect(failed.segmentResult.status).toBe('failed');

      const recovered = await runPiAgentSegment({
        executionPlan,
        model: createModelGatewayModel(target),
        streamFn: createModelGatewayPiStream(streamOptions),
        initialUserInput: 'readonly_tool',
        segmentIndex: 0,
        budgetRemaining: executionPlan.budget,
        maxContextBytes: 262_144,
      });

      expect(recovered.segmentResult.status).toBe('tool_requested');
      expect(ledger.modelCalls).toHaveLength(1);
      expect(ledger.modelCalls[0]).toMatchObject({
        status: 'succeeded',
        attempt_count: 2,
        model_request_key: expect.stringContaining('model:agent_run_1:segment:0:turn:0:'),
      });
      expect(ledger.attempts).toHaveLength(2);
      expect(ledger.attempts.map((attempt) => attempt.global_attempt_index)).toEqual([0, 1]);
      expect(ledger.attempts.map((attempt) => attempt.target_attempt_index)).toEqual([0, 0]);
      expect(ledger.attempts.map((attempt) => attempt.fallback_index)).toEqual([0, 0]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

function plan(modelPolicy: string): AgentExecutionPlan {
  const resolvedModelPolicy = resolvedModelPolicyFor(modelPolicy);
  return {
    execution_plan_id: 'agent_plan_1',
    execution_plan_ref: 'db://agent-execution-plan/agent_plan_1',
    tenant_id: 'tenant_1',
    agent_id: 'agent_1',
    agent_version: 1,
    agent_sha256: 'b'.repeat(64),
    prompt_id: 'prompt_1',
    prompt_version: 1,
    prompt_sha256: 'c'.repeat(64),
    model_policy: modelPolicy,
    model_policy_id: resolvedModelPolicy.model_policy_id,
    model_policy_version: resolvedModelPolicy.model_policy_version,
    model_policy_hash: resolvedModelPolicy.model_policy_hash,
    resolved_model_policy: resolvedModelPolicy,
    allowed_tools: [
      {
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        tool_sha256: 'a'.repeat(64),
        risk_level: 'L1',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
    allowed_handoffs: [],
    budget: {
      max_segments: 8,
      max_model_turns: 16,
      max_tool_calls: 8,
      max_input_tokens: 0,
      max_output_tokens: 0,
      max_total_tokens: 12_000,
      max_duration_ms: 300_000,
      max_handoffs: 2,
      max_context_bytes: 262_144,
    },
    plan: {
      agent_id: 'agent_1',
      agent_version: 1,
      agent_sha256: 'b'.repeat(64),
      prompt_id: 'prompt_1',
      prompt_version: 1,
      prompt_sha256: 'c'.repeat(64),
      system_prompt: 'You are a deterministic test agent.',
      model_policy: modelPolicy,
      model_policy_id: resolvedModelPolicy.model_policy_id,
      model_policy_version: resolvedModelPolicy.model_policy_version,
      model_policy_hash: resolvedModelPolicy.model_policy_hash,
      resolved_model_policy: resolvedModelPolicy,
      allowed_tools: [
        {
          tool_name: 'knowledge.search',
          tool_version: '1.0.0',
          tool_sha256: 'a'.repeat(64),
          risk_level: 'L1',
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      allowed_handoffs: [],
      budget: {
        max_segments: 8,
        max_model_turns: 16,
        max_tool_calls: 8,
        max_input_tokens: 0,
        max_output_tokens: 0,
        max_total_tokens: 12_000,
        max_duration_ms: 300_000,
        max_handoffs: 2,
        max_context_bytes: 262_144,
      },
    },
    generated_at: '2026-01-01T00:00:00.000Z',
    execution_plan_hash: 'd'.repeat(64),
  };
}

function resolvedModelPolicyFor(modelPolicy: string): ResolvedModelPolicy {
  const isModelGateway = modelPolicy.startsWith('model_gateway:');
  const capabilities: ResolvedModelPolicy['resolved_targets'][number]['capabilities'] =
    isModelGateway ? ['text', 'tools', 'usage'] : ['text', 'tools'];
  const modelId = isModelGateway ? 'dar-local-model' : modelPolicy;
  const gatewayProfile = isModelGateway ? 'local-openai-compatible' : 'local-deterministic';
  return {
    model_policy_id: isModelGateway
      ? 'model-gateway-readonly-tool'
      : modelPolicy.replace(/[^a-z0-9_-]+/giu, '-'),
    model_policy_version: 1,
    model_policy_hash: 'f'.repeat(64),
    protocol: isModelGateway ? 'openai_chat_completions' : 'dar_generate',
    resolved_targets: [
      {
        target_id: isModelGateway
          ? 'local-openai-compatible-primary'
          : 'local-deterministic-primary',
        gateway_profile: gatewayProfile,
        model_id: modelId,
        priority: 0,
        enabled: true,
        capabilities,
      },
    ],
    retry_policy: {
      max_attempts_per_target: 1,
      retryable_status_codes: [408, 429, 500, 502, 503, 504],
      retry_on_timeout: true,
      retry_on_network_error: true,
      backoff_ms: 0,
      max_backoff_ms: 0,
    },
    fallback_policy: {
      enabled: false,
      ordered_target_ids: [],
      eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'],
      stop_on_auth_error: true,
      stop_on_validation_error: true,
      stop_on_policy_denial: true,
    },
    request_policy: {
      temperature: 0,
      top_p: 1,
      max_output_tokens: 1000,
      initial_tool_choice_mode: 'auto',
      after_tool_result_tool_choice_mode: 'auto',
      response_format: 'text',
      allow_parallel_tool_calls: false,
    },
  };
}

function firstModelTarget(
  executionPlan: AgentExecutionPlan,
): ResolvedModelPolicy['resolved_targets'][number] {
  const target = executionPlan.resolved_model_policy.resolved_targets[0];
  if (!target) {
    throw new Error('test execution plan must include a ModelPolicy target');
  }
  return target;
}

function agentRunFor(executionPlan: AgentExecutionPlan): AgentRunRecord {
  const target = firstModelTarget(executionPlan);
  return {
    agent_run_id: 'agent_run_1',
    tenant_id: executionPlan.tenant_id,
    user_id: 'user_1',
    task_run_id: 'task_1',
    workflow_id: 'workflow_1',
    execution_plan_ref: executionPlan.execution_plan_ref,
    execution_plan_hash: executionPlan.execution_plan_hash,
    agent_id: executionPlan.agent_id,
    agent_version: executionPlan.agent_version,
    prompt_id: executionPlan.prompt_id,
    prompt_version: executionPlan.prompt_version,
    model: executionPlan.model_policy,
    model_policy_id: executionPlan.model_policy_id,
    model_policy_version: executionPlan.model_policy_version,
    model_policy_hash: executionPlan.model_policy_hash,
    selected_model_id: target.model_id,
    selected_provider: target.gateway_profile,
    fallback_count: 0,
    model_call_count: 0,
    execution_mode: 'mediated_tool_call',
    status: 'running',
    current_segment_index: 0,
    model_turn_count: 0,
    tool_call_count: 0,
    handoff_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    started_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

interface ModelCallLedgerDb {
  db: Kysely<Database>;
  modelCalls: LedgerRow[];
  attempts: LedgerRow[];
}

type LedgerTableName = 'model_call_log' | 'model_call_attempt';
type LedgerRow = Record<string, unknown>;

function createModelCallLedgerDb(): ModelCallLedgerDb {
  const rows: Record<LedgerTableName, LedgerRow[]> = {
    model_call_log: [],
    model_call_attempt: [],
  };
  const db = {
    selectFrom: (table: string) => new LedgerQuery(rows, table, 'select'),
    insertInto: (table: string) => new LedgerQuery(rows, table, 'insert'),
    updateTable: (table: string) => new LedgerQuery(rows, table, 'update'),
  } as unknown as Kysely<Database>;
  return {
    db,
    modelCalls: rows.model_call_log,
    attempts: rows.model_call_attempt,
  };
}

class LedgerQuery {
  private pendingValue: LedgerRow = {};
  private whereColumn: string | undefined;
  private whereValue: unknown;

  constructor(
    private readonly rows: Record<LedgerTableName, LedgerRow[]>,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update',
  ) {}

  selectAll(): this {
    return this;
  }

  where(column: string, _operator: string, value: unknown): this {
    this.whereColumn = column;
    this.whereValue = value;
    return this;
  }

  orderBy(): this {
    return this;
  }

  values(value: unknown): this {
    this.pendingValue = value as LedgerRow;
    return this;
  }

  set(value: unknown): this {
    this.pendingValue = value as LedgerRow;
    return this;
  }

  onConflict(_handler?: unknown): this {
    return this;
  }

  column(): this {
    return this;
  }

  columns(): this {
    return this;
  }

  doNothing(): this {
    return this;
  }

  returningAll(): this {
    return this;
  }

  async executeTakeFirst(): Promise<LedgerRow | undefined> {
    if (this.op === 'insert') {
      const row = withLedgerDefaults(this.table, this.pendingValue);
      this.tableRows().push(row);
      return row;
    }
    if (this.op === 'update') {
      const row = this.tableRows().find((candidate) => this.matchesWhere(candidate));
      if (!row) {
        return undefined;
      }
      Object.assign(row, this.pendingValue);
      return row;
    }
    return this.tableRows().find((row) => this.matchesWhere(row));
  }

  async executeTakeFirstOrThrow(): Promise<LedgerRow> {
    const row = await this.executeTakeFirst();
    if (!row) {
      throw new Error(`missing fake ledger row for ${this.table}`);
    }
    return row;
  }

  async execute(): Promise<LedgerRow[]> {
    if (this.op === 'update') {
      for (const row of this.tableRows().filter((candidate) => this.matchesWhere(candidate))) {
        Object.assign(row, this.pendingValue);
      }
    }
    return this.tableRows().filter((row) => this.matchesWhere(row));
  }

  private tableRows(): LedgerRow[] {
    const rows = this.rows[this.table as LedgerTableName];
    if (!rows) {
      throw new Error(`unexpected fake ledger table: ${this.table}`);
    }
    return rows;
  }

  private matchesWhere(row: LedgerRow): boolean {
    return this.whereColumn ? row[this.whereColumn] === this.whereValue : true;
  }
}

function withLedgerDefaults(table: string, row: LedgerRow): LedgerRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  if (table === 'model_call_log') {
    return {
      created_at: now,
      updated_at: now,
      ...row,
    };
  }
  return {
    created_at: now,
    ...row,
  };
}
