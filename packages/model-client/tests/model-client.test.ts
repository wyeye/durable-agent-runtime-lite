import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelGatewayClient,
  ModelGatewayError,
  ModelToolNameCodec,
  OpenAICompatibleEmbeddingClient,
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

  it('preserves gateway path prefixes when posting OpenAI-compatible requests', async () => {
    const seen: Array<{ url?: string }> = [];
    const server = createServer((request, response) => {
      seen.push({ url: request.url });
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'chatcmpl_prefixed_gateway',
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
      baseUrl: `http://127.0.0.1:${address.port}/gateway-a`,
      apiKey: 'test-key',
      protocol: 'openai_chat_completions',
      allowInsecureHttp: true,
      maxRetries: 0,
    });

    await client.call({
      model_request_key: 'prefixed-gateway',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      tool_choice: 'none',
      response_format: 'text',
    });

    expect(seen[0]?.url).toBe('/gateway-a/v1/chat/completions');
  });

  it('does not duplicate OpenAI v1 path when base URL already includes it', async () => {
    const seen: Array<{ url?: string }> = [];
    const server = createServer((request, response) => {
      seen.push({ url: request.url });
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'chatcmpl_v1_base',
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
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      protocol: 'openai_chat_completions',
      allowInsecureHttp: true,
      maxRetries: 0,
    });

    await client.call({
      model_request_key: 'v1-base',
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      tool_choice: 'none',
      response_format: 'text',
    });

    expect(seen[0]?.url).toBe('/v1/chat/completions');
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

  it('calls OpenAI-compatible embeddings in batch and validates dimensions', async () => {
    const seen: unknown[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        const parsed = JSON.parse(body) as { input: string[] };
        seen.push(parsed);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          data: parsed.input.map((_text, index) => ({
            index,
            embedding: new Array(4).fill(index + 1),
          })),
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }

    const client = new OpenAICompatibleEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}/gateway-a`,
      apiKey: 'secret-key',
      allowInsecureHttp: true,
      expectedDimensions: 4,
      maxRetries: 0,
    });
    const vectors = await client.embed('embedding-model', ['text 1', 'text 2']);
    expect(vectors).toHaveLength(2);
    expect(vectors[1]).toEqual([2, 2, 2, 2]);
    expect(seen[0]).toMatchObject({
      model: 'embedding-model',
      input: ['text 1', 'text 2'],
      encoding_format: 'float',
    });
  });

  it('retries 429 and 503 embedding responses but not auth failures', async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.setHeader('content-type', 'application/json');
      if (attempts < 3) {
        response.statusCode = attempts === 1 ? 429 : 503;
        response.end(JSON.stringify({ error: { message: 'retry me' } }));
        return;
      }
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    const client = new OpenAICompatibleEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'secret-key',
      allowInsecureHttp: true,
      expectedDimensions: 2,
      maxRetries: 2,
      retryBackoffMs: 1,
    });
    await expect(client.embed('embedding-model', 'hello')).resolves.toEqual([[1, 0]]);
    expect(attempts).toBe(3);

    let authAttempts = 0;
    const authServer = createServer((_request, response) => {
      authAttempts += 1;
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: 'bad key' } }));
    });
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
    servers.push(authServer);
    const authAddress = authServer.address();
    if (!authAddress || typeof authAddress === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    const authClient = new OpenAICompatibleEmbeddingClient({
      baseUrl: `http://127.0.0.1:${authAddress.port}`,
      apiKey: 'bad-key',
      allowInsecureHttp: true,
      expectedDimensions: 2,
      maxRetries: 2,
    });
    await expect(authClient.embed('embedding-model', 'hello')).rejects.toMatchObject({
      code: 'MODEL_GATEWAY_AUTH_FAILED',
      errorClass: 'auth',
    });
    expect(authAttempts).toBe(1);
  });

  it('fails closed for invalid embedding JSON, dimensions, non-finite values, timeout, and AbortSignal', async () => {
    const invalidServer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{not json');
    });
    await new Promise<void>((resolve) => invalidServer.listen(0, '127.0.0.1', resolve));
    servers.push(invalidServer);
    const invalidAddress = invalidServer.address();
    if (!invalidAddress || typeof invalidAddress === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    const invalidClient = new OpenAICompatibleEmbeddingClient({
      baseUrl: `http://127.0.0.1:${invalidAddress.port}`,
      allowInsecureHttp: true,
      expectedDimensions: 2,
      maxRetries: 0,
    });
    await expect(invalidClient.embed('embedding-model', 'hello')).rejects.toMatchObject({
      code: 'MODEL_GATEWAY_INVALID_RESPONSE',
      errorClass: 'validation',
    });

    const badPayloadServer = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }));
    });
    await new Promise<void>((resolve) => badPayloadServer.listen(0, '127.0.0.1', resolve));
    servers.push(badPayloadServer);
    const badPayloadAddress = badPayloadServer.address();
    if (!badPayloadAddress || typeof badPayloadAddress === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    const badPayloadClient = new OpenAICompatibleEmbeddingClient({
      baseUrl: `http://127.0.0.1:${badPayloadAddress.port}`,
      allowInsecureHttp: true,
      expectedDimensions: 2,
      maxRetries: 0,
    });
    await expect(badPayloadClient.embed('embedding-model', 'hello')).rejects.toMatchObject({
      code: 'MODEL_EMBEDDING_DIMENSIONS_MISMATCH',
      errorClass: 'validation',
    });

    const slowServer = createServer((_request, _response) => {
      // Hold the socket open so timeout and AbortSignal behavior are observable.
    });
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    servers.push(slowServer);
    const slowAddress = slowServer.address();
    if (!slowAddress || typeof slowAddress === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    const timeoutClient = new OpenAICompatibleEmbeddingClient({
      baseUrl: `http://127.0.0.1:${slowAddress.port}`,
      allowInsecureHttp: true,
      expectedDimensions: 2,
      timeoutMs: 10,
      maxRetries: 0,
    });
    await expect(timeoutClient.embed('embedding-model', 'hello')).rejects.toMatchObject({
      errorClass: 'timeout',
    });

    const abort = new AbortController();
    abort.abort();
    await expect(timeoutClient.embed('embedding-model', 'hello', { signal: abort.signal })).rejects.toMatchObject({
      errorClass: 'aborted',
    });
  });
});
