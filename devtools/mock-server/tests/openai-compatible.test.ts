import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('mock OpenAI-compatible endpoint', () => {
  it('returns provider-safe tool aliases from the request tool list', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'dar-local-model',
        messages: [{ role: 'user', content: 'readonly_tool' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'tool_knowledge_search_f2405c6159c9',
              parameters: { type: 'object' },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe(
      'tool_knowledge_search_f2405c6159c9',
    );
    expect(JSON.stringify(body)).not.toContain('"knowledge.search"');
  });

  it('keeps canonical names for legacy /v1/generate responses', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/generate',
      payload: {
        model: 'dar-local-model',
        messages: [{ role: 'user', content: 'readonly_tool' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.message.content[0]).toMatchObject({
      type: 'tool_call',
      name: 'knowledge.search',
    });
  });
});
