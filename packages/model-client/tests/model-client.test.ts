import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelGatewayClient,
  ModelGatewayError,
  ModelToolNameCodec,
  modelGenerateResponseSchema,
} from '../src/index.js';

const servers: Array<{ close: () => void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error?: Error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

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
    const parsed = modelGenerateResponseSchema.parse({
      id: 'resp_legacy',
      content: 'legacy answer',
    });

    expect(parsed.content).toBe('legacy answer');
    expect(parsed.message.content).toEqual([{ type: 'text', text: 'legacy answer' }]);
    expect(parsed.finish_reason).toBe('stop');
  });

  it('rejects malformed tool call arguments', () => {
    expect(() =>
      modelGenerateResponseSchema.parse({
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'call_bad',
              name: 'knowledge.search',
              arguments: 'not-json-object',
            },
          ],
        },
        finish_reason: 'tool_call',
      }),
    ).toThrow();
  });

  it('maps OpenAI-compatible chat completion tool calls and usage', async () => {
    const seen: Array<{ url?: string; idempotencyKey?: string; body: unknown }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        seen.push({
          url: request.url,
          idempotencyKey: request.headers['idempotency-key']?.toString(),
          body: JSON.parse(body),
        });
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'chatcmpl_1',
            model: 'gpt-test',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'tool_knowledge_search_f2405c6159c9',
                        arguments: '{"query":"target"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }

    const client = new ModelGatewayClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      protocol: 'openai_chat_completions',
      allowInsecureHttp: true,
      maxRetries: 0,
    });

    const response = await client.call({
      model_request_key: 'model-call-1',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'search target' }],
      tools: [{ name: 'knowledge.search', input_schema: { type: 'object' } }],
      tool_choice: 'auto',
      response_format: 'text',
    });

    expect(seen[0]).toMatchObject({
      url: '/v1/chat/completions',
      idempotencyKey: 'model-call-1',
    });
    expect(seen[0]?.body).toMatchObject({
      tools: [
        {
          function: {
            name: 'tool_knowledge_search_f2405c6159c9',
          },
        },
      ],
    });
    expect(response.finish_reason).toBe('tool_call');
    expect(response.usage?.total_tokens).toBe(18);
    expect(response.message.content[0]).toMatchObject({
      type: 'tool_call',
      name: 'knowledge.search',
      arguments: { query: 'target' },
    });
  });

  it('preserves assistant tool_calls and matching tool results in OpenAI-compatible requests', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        seen.push(JSON.parse(body) as Record<string, unknown>);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'chatcmpl_2',
            model: 'gpt-test',
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }

    const client = new ModelGatewayClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      protocol: 'openai_chat_completions',
      allowInsecureHttp: true,
      maxRetries: 0,
    });

    await client.call({
      model_request_key: 'roundtrip',
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'knowledge.search',
              arguments: { query: 'target' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'knowledge.search', content: 'result text' },
      ],
      tools: [{ name: 'knowledge.search', input_schema: { type: 'object' } }],
      tool_choice: 'none',
      response_format: 'text',
    });

    expect(seen[0]).toMatchObject({
      tool_choice: 'none',
      messages: [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'tool_knowledge_search_f2405c6159c9',
                arguments: '{"query":"target"}',
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result text' },
      ],
    });
  });

  it('fails closed on unmatched tool result ids and unknown provider aliases', async () => {
    const client = new ModelGatewayClient({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'test-key',
      protocol: 'openai_chat_completions',
      allowInsecureHttp: true,
      maxRetries: 0,
    });

    await expect(
      client.call({
        model_request_key: 'bad-tool-result',
        model: 'gpt-test',
        messages: [{ role: 'tool', tool_call_id: 'call_missing', content: 'orphan result' }],
        tools: [{ name: 'knowledge.search', input_schema: { type: 'object' } }],
        tool_choice: 'none',
        response_format: 'text',
      }),
    ).rejects.toMatchObject({
      code: 'MODEL_GATEWAY_UNKNOWN_TOOL_RESULT_ID',
      errorClass: 'validation',
    });

    const codec = ModelToolNameCodec.fromTools([
      { name: 'knowledge.search', input_schema: { type: 'object' } },
    ]);
    expect(() => codec.decode('unknown_tool')).toThrow(ModelGatewayError);
  });

  it('does not retry authentication failures', async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    const client = new ModelGatewayClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'bad-key',
      protocol: 'openai_chat_completions',
      allowInsecureHttp: true,
      maxRetries: 2,
    });

    await expect(
      client.call({
        model_request_key: 'auth-fail',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        tool_choice: 'auto',
        response_format: 'text',
      }),
    ).rejects.toMatchObject({ code: 'MODEL_GATEWAY_AUTH_FAILED', errorClass: 'auth' });
    expect(attempts).toBe(1);
  });

  it('enforces response size limits before parsing provider payloads', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ payload: 'x'.repeat(128) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    const client = new ModelGatewayClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key',
      protocol: 'openai_chat_completions',
      allowInsecureHttp: true,
      maxResponseBytes: 32,
      maxRetries: 0,
    });

    await expect(
      client.call({
        model_request_key: 'too-large',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        tool_choice: 'auto',
        response_format: 'text',
      }),
    ).rejects.toBeInstanceOf(ModelGatewayError);
  });
});
