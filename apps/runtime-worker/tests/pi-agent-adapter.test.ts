import { describe, expect, it } from 'vitest';
import type { AgentExecutionPlan } from '@dar/contracts';
import { createDeterministicPiStream } from '../src/agent/deterministic-pi-stream.js';
import { runPiAgentSegment } from '../src/agent/pi-agent-adapter.js';
import { restorePiMessages, serializePiContext, replaceDeferredToolResults } from '../src/agent/pi-context-codec.js';

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

      expect(result.segmentResult.status).toBe('tool_requested');
      if (result.segmentResult.status !== 'tool_requested') {
        throw new Error('expected tool request');
      }
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

  it('sanitizes hidden reasoning and replaces deferred tool result idempotently', () => {
    const context = serializePiContext([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret chain of thought', thinkingSignature: 'opaque' },
          { type: 'text', text: 'visible answer with Authorization: Bearer abc123' },
          { type: 'toolCall', id: 'call_1', name: 'knowledge.search', arguments: { api_key: 'secret', query: 'x' } },
        ],
        api: 'test',
        provider: 'test',
        model: 'test',
        diagnostics: [{ hidden_reasoning: 'do not store' }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'knowledge.search',
        content: [{ type: 'text', text: 'Deferred tool proposal captured for knowledge.search.' }],
        details: { kind: 'deferred_tool_proposal', token: 'secret-token' },
        isError: false,
        timestamp: 2,
      },
    ], { maxBytes: 262_144 });

    expect(JSON.stringify(context)).not.toContain('secret chain of thought');
    expect(JSON.stringify(context)).not.toContain('hidden_reasoning');
    expect(JSON.stringify(context)).not.toContain('abc123');
    expect(JSON.stringify(context)).toContain('[REDACTED]');

    const restored = restorePiMessages(context);
    const replaced = replaceDeferredToolResults(restored, [{
      tool_call_id: 'call_1',
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      result_summary: 'real result',
      is_error: false,
      content: [{ type: 'text', text: 'real result' }],
      details: { result_ref: 'ref_1' },
    }], { maxBytes: 262_144 });

    const toolResults = replaced.messages.filter((message) => message.role === 'toolResult');
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0])).toContain('authoritative_tool_result');
    expect(JSON.stringify(toolResults[0])).toContain('real result');
  });
});

function plan(modelPolicy: string): AgentExecutionPlan {
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
    allowed_tools: [{
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      tool_sha256: 'a'.repeat(64),
      risk_level: 'L1',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }],
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
      allowed_tools: [{
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        tool_sha256: 'a'.repeat(64),
        risk_level: 'L1',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }],
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
