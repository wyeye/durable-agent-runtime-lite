import { describe, expect, it } from 'vitest';
import { modelGenerateResponseSchema } from '../src/index.js';

describe('Model Gateway contract', () => {
  it('parses structured assistant tool calls', () => {
    const parsed = modelGenerateResponseSchema.parse({
      id: 'resp_1',
      model: 'dar-local-model',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'knowledge.search',
            arguments: { query: 'target document' },
          },
        ],
      },
      finish_reason: 'tool_call',
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    });

    expect(parsed.message.content[0]).toMatchObject({
      type: 'tool_call',
      id: 'call_1',
      name: 'knowledge.search',
      arguments: { query: 'target document' },
    });
    expect(parsed.usage.total_tokens).toBe(18);
  });

  it('keeps old string content responses compatible', () => {
    const parsed = modelGenerateResponseSchema.parse({ id: 'resp_legacy', content: 'legacy answer' });

    expect(parsed.content).toBe('legacy answer');
    expect(parsed.message.content).toEqual([{ type: 'text', text: 'legacy answer' }]);
    expect(parsed.finish_reason).toBe('stop');
  });

  it('rejects malformed tool call arguments', () => {
    expect(() =>
      modelGenerateResponseSchema.parse({
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'call_bad', name: 'knowledge.search', arguments: 'not-json-object' }],
        },
        finish_reason: 'tool_call',
      }),
    ).toThrow();
  });
});
