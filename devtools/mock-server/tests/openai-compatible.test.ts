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

  it('prefers the explicit user scenario over later matching case text', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'dar-local-model',
        messages: [
          { role: 'system', content: 'Use readonly_tool as a fallback example only.' },
          {
            role: 'user',
            content: 'repeated_tool AR-2B evaluation smoke framework_tool_policy_deny',
          },
        ],
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
    expect(body.choices[0].message.tool_calls).toHaveLength(2);
    expect(body.choices[0].message.tool_calls.map((call: { id: string }) => call.id)).toEqual([
      'call_readonly_1',
      'call_readonly_2',
    ]);
  });

  it('lets the regression degraded prompt marker override passing case input', async () => {
    const server = buildServer();
    servers.push(server);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'dar-local-model',
        messages: [
          { role: 'system', content: 'AR-2B evaluation smoke. model_gateway:regression_b_degraded.' },
          { role: 'user', content: 'final_only AR-2B evaluation smoke regression_final_1' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.choices[0].message.content).toBe('Mock degraded regression answer.');
  });

  it('returns deterministic 503 for gateway A force_503 models only', async () => {
    const server = buildServer();
    servers.push(server);

    const failed = await server.inject({
      method: 'POST',
      url: '/gateway-a/v1/chat/completions',
      headers: { authorization: 'Bearer gateway-a-secret' },
      payload: {
        model: 'catalog_force_503_model',
        messages: [{ role: 'user', content: 'final_only' }],
      },
    });
    expect(failed.statusCode).toBe(503);

    const recovered = await server.inject({
      method: 'POST',
      url: '/gateway-b/v1/chat/completions',
      headers: { authorization: 'Bearer gateway-b-secret' },
      payload: {
        model: 'catalog_force_503_model',
        messages: [{ role: 'user', content: 'final_only' }],
      },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().id).toMatch(/^gateway-b_/u);
  });

  it('returns the remembered codename only when prior conversation history is present', async () => {
    const server = buildServer();
    servers.push(server);

    await server.inject({
      method: 'POST',
      url: '/__test/scenario',
      payload: { scenario: 'conversation_memory' },
    });

    const withHistory = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'dar-local-model',
        messages: [
          { role: 'user', content: '请记住项目代号是蓝鲸' },
          { role: 'assistant', content: '已记住项目代号“蓝鲸”。' },
          { role: 'user', content: '项目代号是什么？' },
        ],
      },
    });
    expect(withHistory.statusCode).toBe(200);
    expect(withHistory.json().choices[0].message.content).toBe('项目代号是“蓝鲸”。');

    const withoutHistory = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'dar-local-model',
        messages: [
          { role: 'user', content: '项目代号是什么？' },
        ],
      },
    });
    expect(withoutHistory.statusCode).toBe(200);
    expect(withoutHistory.json().choices[0].message.content).toBe('项目代号是“海豚”。');
  });
});
