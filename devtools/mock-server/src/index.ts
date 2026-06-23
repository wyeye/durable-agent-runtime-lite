import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyReply } from 'fastify';

interface GenerateRequest {
  model?: string;
  messages?: MockRequestMessage[];
}

interface OpenAiChatRequest {
  model?: string;
  messages?: MockRequestMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}

interface OpenAiEmbeddingRequest {
  model?: string;
  input?: string | string[];
}

interface MockRequestMessage {
  role: string;
  content?: string | null | Array<{ type?: string; text?: string }>;
}

type MockContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> | string };

interface MockGenerateResponse {
  id: string;
  model: string;
  message: {
    role: 'assistant';
    content: MockContentBlock[];
  };
  finish_reason: 'stop' | 'tool_call' | 'length' | 'error';
  usage: ReturnType<typeof usage>;
}

export function buildServer() {
  const server = Fastify({ logger: false });

  server.get('/healthz', async () => ({ status: 'ok', app: 'mock-server' }));
  server.get('/readyz', async () => ({ status: 'ready', app: 'mock-server' }));
  server.post('/business-api/v1/reset', async () => {
    businessApiRequestCount = 0;
    lastBusinessApiAuthorization = undefined;
    attempts.delete('business_api_rate_limit_then_success');
    return { ok: true };
  });
  server.get('/business-api/v1/stats', async () => ({
    request_count: businessApiRequestCount,
    last_authorization: lastBusinessApiAuthorization === 'Bearer business-read-secret' ? 'bearer_ok' : 'invalid_or_missing',
  }));
  server.get('/business-api/v1/policies', async (request, reply) => {
    businessApiRequestCount += 1;
    lastBusinessApiAuthorization = request.headers.authorization;
    if (!authorized(request.headers.authorization, ['business-read-secret'])) {
      reply.code(401);
      return { error: { code: 'unauthorized', message: 'Unauthorized' } };
    }
    const query = request.query as { keyword?: string; scenario?: string };
    const scenario = query.scenario ?? query.keyword;
    if (scenario === 'rate_limit_then_success') {
      const count = incrementAttempt('business_api_rate_limit_then_success');
      if (count === 1) {
        reply.code(429);
        return { error: { code: 'rate_limited', message: 'deterministic rate limit' } };
      }
    }
    if (scenario === '503') {
      reply.code(503);
      return { error: { code: 'temporarily_unavailable', message: 'Business API unavailable' } };
    }
    if (scenario === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    if (scenario === 'invalid_json') {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/json' });
      reply.raw.end('{not-json');
      return reply;
    }
    if (scenario === 'oversized') {
      return { items: [{ id: 'policy-big', title: '超大政策', summary: 'x'.repeat(2_000_000) }] };
    }
    return {
      items: [
        {
          id: 'policy-1',
          title: '差旅报销政策',
          summary: `差旅费用可按制度提交报销，关键词：${query.keyword ?? ''}`,
        },
      ],
    };
  });

  server.post('/v1/generate', async (request, reply) => {
    const body = request.body as GenerateRequest;
    const scenario = scenarioFromMessages(body.messages ?? []);
    if (scenario === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    if (scenario === 'rate_limit_then_success' && !hasToolResult(body.messages ?? [])) {
      const count = incrementAttempt('rate_limit_then_success');
      if (count === 1) {
        reply.code(429);
        return { error: { code: 'RATE_LIMITED', message: 'deterministic rate limit' } };
      }
    }
    if (scenario === 'upstream_500_then_success' && !hasToolResult(body.messages ?? [])) {
      const count = incrementAttempt('upstream_500_then_success');
      if (count === 1) {
        reply.code(500);
        return { error: { code: 'UPSTREAM_FAILED', message: 'deterministic upstream failure' } };
      }
    }
    return responseForScenario(scenario, body);
  });

  server.post('/v1/chat/completions', async (request, reply) => {
    const body = request.body as OpenAiChatRequest;
    const messages = (body.messages ?? []).map((message) => ({
      role: message.role,
      content: messageContentToText(message.content),
    }));
    const scenario = scenarioFromMessages(messages);
    if (scenario === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    if (scenario === 'rate_limit_then_success' && !hasToolResult(messages)) {
      const count = incrementAttempt('openai_rate_limit_then_success');
      if (count === 1) {
        reply.code(429);
        return { error: { code: 'rate_limit_exceeded', message: 'deterministic rate limit' } };
      }
    }
    if (scenario === 'upstream_500_then_success' && !hasToolResult(messages)) {
      const count = incrementAttempt('openai_upstream_500_then_success');
      if (count === 1) {
        reply.code(500);
        return { error: { code: 'server_error', message: 'deterministic upstream failure' } };
      }
    }
    return openAiResponseForScenario(scenario, {
      ...(body.model ? { model: body.model } : {}),
      messages,
      toolAliases: toolAliasesFromOpenAiTools(body.tools ?? []),
    });
  });

  server.post('/gateway-a/v1/chat/completions', async (request, reply) => {
    if (!authorized(request.headers.authorization, ['gateway-a-secret'])) {
      reply.code(401);
      return { error: { code: 'unauthorized', message: 'Unauthorized' } };
    }
    const body = request.body as OpenAiChatRequest;
    if (process.env.MOCK_GATEWAY_A_FORCE_503 === 'true' || body.model?.includes('force_503')) {
      reply.code(503);
      return { error: { code: 'temporarily_unavailable', message: 'Gateway A unavailable' } };
    }
    return openAiPrefixedGatewayResponse(body, 'gateway-a');
  });

  server.post('/gateway-a/v1/embeddings', async (request, reply) => {
    if (!authorized(request.headers.authorization, ['gateway-a-secret'])) {
      reply.code(401);
      return { error: { code: 'unauthorized', message: 'Unauthorized' } };
    }
    return embeddingResponse(request.body as OpenAiEmbeddingRequest, 'gateway-a', reply);
  });

  server.post('/gateway-b/v1/chat/completions', async (request, reply) => {
    if (!authorized(request.headers.authorization, ['gateway-b-secret', 'gateway-b-secret-v2'])) {
      reply.code(401);
      return { error: { code: 'unauthorized', message: 'Unauthorized' } };
    }
    return openAiPrefixedGatewayResponse(request.body as OpenAiChatRequest, 'gateway-b');
  });

  server.post('/gateway-b/v1/embeddings', async (request, reply) => {
    if (!authorized(request.headers.authorization, ['gateway-b-secret', 'gateway-b-secret-v2'])) {
      reply.code(401);
      return { error: { code: 'unauthorized', message: 'Unauthorized' } };
    }
    return embeddingResponse(request.body as OpenAiEmbeddingRequest, 'gateway-b', reply);
  });

  return server;
}

const attempts = new Map<string, number>();
let businessApiRequestCount = 0;
let lastBusinessApiAuthorization: string | undefined;

function incrementAttempt(key: string): number {
  const next = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, next);
  return next;
}

function responseForScenario(scenario: string, request: GenerateRequest): MockGenerateResponse {
  const model = request.model ?? 'dar-local-model';
  if (hasToolResult(request.messages ?? [])) {
    return finalResponse(model, `Mock final after ${scenario} boundary.`);
  }
  switch (scenario) {
    case 'regression_b_degraded':
      return finalResponse(model, 'Mock degraded regression answer.');
    case 'readonly_tool':
    case 'repeated_tool':
    case 'rate_limit_then_success':
    case 'upstream_500_then_success':
      return scenario === 'repeated_tool'
        ? toolCallResponse(model, [
            { id: 'call_readonly_1', name: 'knowledge.search', args: { query: 'mock gateway lookup 1' } },
            { id: 'call_readonly_2', name: 'knowledge.search', args: { query: 'mock gateway lookup 2' } },
          ])
        : toolCallResponse(model, [{ id: 'call_readonly_1', name: 'knowledge.search', args: { query: 'mock gateway lookup' } }]);
    case 'l3_tool':
      return toolCallResponse(model, [{ id: 'call_l3_1', name: 'record.write.mock', args: { record: { summary: 'mock gateway write' } } }]);
    case 'user_input':
      return toolCallResponse(model, [{ id: 'call_user_1', name: 'request_user_input', args: {
        question: 'Please provide the missing value.',
        requested_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      } }]);
    case 'handoff':
      return toolCallResponse(model, [{ id: 'call_handoff_1', name: 'handoff_to_workflow', args: {
        target_execution_plan_ref: 'db://flow-execution-plan/plan_handoff',
        arguments: { source: 'mock-gateway' },
      } }]);
    case 'malformed_tool_call':
      return {
        id: 'mock_malformed',
        model,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'call_bad', name: 'knowledge.search', arguments: 'not-object' }],
        },
        finish_reason: 'tool_call',
        usage: usage(),
      };
    case 'excessive_tokens':
      return {
        ...finalResponse(model, 'x'.repeat(20_000)),
        usage: { input_tokens: 20_000, output_tokens: 20_000, total_tokens: 40_000 },
      };
    case 'final_only':
    default:
      return finalResponse(model, 'Mock final answer.');
  }
}

function toolCallResponse(
  model: string,
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): MockGenerateResponse {
  return {
    id: `mock_${calls.map((call) => call.id).join('_')}`,
    model,
    message: {
      role: 'assistant',
      content: calls.map((call): MockContentBlock => ({
        type: 'tool_call',
        id: call.id,
        name: call.name,
        arguments: call.args,
      })),
    },
    finish_reason: 'tool_call',
    usage: usage(),
  };
}

function finalResponse(model: string, text: string): MockGenerateResponse {
  return {
    id: 'mock_final',
    model,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    finish_reason: 'stop',
    usage: usage(),
  };
}

function openAiResponseForScenario(
  scenario: string,
  request: GenerateRequest & { toolAliases?: ToolAliasMap },
) {
  const response = responseForScenario(scenario, request);
  const message = response.message;
  const contentBlocks = message.content;
  const toolCalls = contentBlocks.filter(isToolCallBlock).map((block) => ({
    ...block,
    name: request.toolAliases?.[block.name] ?? block.name,
  }));
  const text = contentBlocks.filter(isTextBlock).map((block) => block.text).join('\n') || null;
  return {
    id: response.id,
    object: 'chat.completion',
    model: response.model,
    choices: [{
      index: 0,
      finish_reason: response.finish_reason === 'tool_call' ? 'tool_calls' : response.finish_reason,
      message: {
        role: 'assistant',
        content: toolCalls.length > 0 ? null : text,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((block) => ({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.arguments),
                },
              })),
            }
          : {}),
      },
    }],
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.total_tokens,
    },
  };
}

function openAiPrefixedGatewayResponse(body: OpenAiChatRequest, gateway: 'gateway-a' | 'gateway-b') {
  const messages = (body.messages ?? []).map((message) => ({
    role: message.role,
    content: messageContentToText(message.content),
  }));
  const scenario = scenarioFromMessages(messages);
  const response = openAiResponseForScenario(scenario, {
    ...(body.model ? { model: body.model } : {}),
    messages,
    toolAliases: toolAliasesFromOpenAiTools(body.tools ?? []),
  });
  return {
    ...response,
    id: `${gateway}_${response.id}`,
  };
}

function embeddingResponse(
  body: OpenAiEmbeddingRequest,
  gateway: 'gateway-a' | 'gateway-b',
  reply: FastifyReply,
) {
  const model = body.model ?? `${gateway}-embedding-model`;
  if (process.env.MOCK_EMBEDDINGS_FORCE_429 === 'true' || model.includes('force_429')) {
    reply.code(429);
    return { error: { code: 'rate_limit_exceeded', message: 'deterministic rate limit' } };
  }
  if (process.env.MOCK_EMBEDDINGS_FORCE_503 === 'true' || model.includes('force_503')) {
    reply.code(503);
    return { error: { code: 'temporarily_unavailable', message: 'Embedding gateway unavailable' } };
  }
  const dimensions = process.env.MOCK_EMBEDDINGS_WRONG_DIMENSIONS === 'true' || model.includes('wrong_dimensions')
    ? 8
    : 1536;
  const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
  return {
    object: 'list',
    model,
    data: inputs.map((text, index) => ({
      object: 'embedding',
      index,
      embedding: deterministicEmbedding(String(text), dimensions),
    })),
    usage: {
      prompt_tokens: inputs.join(' ').length,
      total_tokens: inputs.join(' ').length,
    },
  };
}

function deterministicEmbedding(text: string, dimensions: number): number[] {
  const normalized = text.toLowerCase();
  const vector = new Array<number>(dimensions).fill(0);
  const cluster = semanticCluster(normalized);
  for (const [index, value] of cluster.entries()) {
    if (index < dimensions) {
      vector[index] = (vector[index] ?? 0) + value;
    }
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    const position = 32 + ((code * 31 + index * 17) % Math.max(1, dimensions - 32));
    vector[position] = (vector[position] ?? 0) + ((code % 13) + 1) / 1000;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

function semanticCluster(text: string): number[] {
  const expense = /(报销|费用|差旅|发票|申请)/u.test(text);
  const ticket = /(工单|故障单|报修|维修|提交)/u.test(text);
  if (expense && ticket) {
    return [1, 0.98, 0.02, 0, 0, 0, 0, 0];
  }
  if (expense) {
    return [1, 0.05, 0.02, 0, 0, 0, 0, 0];
  }
  if (ticket) {
    return [0.02, 1, 0.05, 0, 0, 0, 0, 0];
  }
  if (/(权限|账号|登录|访问)/u.test(text)) {
    return [0, 0.02, 1, 0.05, 0, 0, 0, 0];
  }
  return [0, 0, 0, 1, 0.05, 0.02, 0, 0];
}

function authorized(header: string | undefined, acceptedTokens: string[]): boolean {
  const token = /^Bearer\s+(.+)$/iu.exec(header ?? '')?.[1];
  return Boolean(token && acceptedTokens.includes(token));
}

interface ToolAliasMap {
  [canonicalName: string]: string;
}

const knownOpenAiToolAliases: ToolAliasMap = {
  'knowledge.search': 'tool_knowledge_search_f2405c6159c9',
  'record.write.mock': 'tool_record_write_mock_a0195543d17f',
  request_user_input: 'request_user_input',
  handoff_to_workflow: 'handoff_to_workflow',
};

function toolAliasesFromOpenAiTools(tools: Array<{ function?: { name?: string } }>): ToolAliasMap {
  const providerToolNames = new Set(
    tools.map((tool) => tool.function?.name).filter((name): name is string => Boolean(name)),
  );
  const aliases: ToolAliasMap = {};
  for (const [canonicalName, providerName] of Object.entries(knownOpenAiToolAliases)) {
    if (providerToolNames.has(providerName)) {
      aliases[canonicalName] = providerName;
    }
  }
  return aliases;
}

function isTextBlock(block: MockContentBlock): block is Extract<MockContentBlock, { type: 'text' }> {
  return block.type === 'text';
}

function isToolCallBlock(block: MockContentBlock): block is Extract<MockContentBlock, { type: 'tool_call' }> {
  return block.type === 'tool_call';
}

function usage() {
  return { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
}

const supportedScenarios = [
  'regression_b_degraded',
  'repeated_tool',
  'readonly_tool',
  'malformed_tool_call',
  'rate_limit_then_success',
  'upstream_500_then_success',
  'excessive_tokens',
  'l3_tool',
  'user_input',
  'handoff',
  'final_only',
  'timeout',
] as const;

function scenarioFromMessages(messages: MockRequestMessage[]): string {
  const joined = messages.map((message) => messageContentToText(message.content)).join('\n').toLowerCase();
  if (joined.includes('regression_b_degraded')) {
    return 'regression_b_degraded';
  }
  for (const message of messages) {
    const content = messageContentToText(message.content).trim().toLowerCase();
    if (message.role === 'user') {
      const explicit = supportedScenarios.find((scenario) =>
        content === scenario || content.startsWith(`${scenario} `) || content.startsWith(`${scenario}\n`),
      );
      if (explicit) {
        return explicit;
      }
    }
  }
  for (const scenario of supportedScenarios) {
    if (joined.includes(scenario)) {
      return scenario;
    }
  }
  return 'readonly_tool';
}

function hasToolResult(messages: MockRequestMessage[]): boolean {
  return messages.some((message) => message.role === 'tool');
}

function messageContentToText(content: MockRequestMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .flatMap((block) => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n');
}

async function start() {
  const server = buildServer();
  await server.listen({
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 4100),
  });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
