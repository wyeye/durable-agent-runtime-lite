import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';

interface GenerateRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
}

interface OpenAiChatRequest {
  model?: string;
  messages?: Array<{ role: string; content?: string | null }>;
  tools?: Array<{ function?: { name?: string } }>;
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
    const messages = (body.messages ?? []).map((message) => ({ role: message.role, content: message.content ?? '' }));
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

  return server;
}

const attempts = new Map<string, number>();

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
    case 'readonly_tool':
    case 'rate_limit_then_success':
    case 'upstream_500_then_success':
      return toolCallResponse(model, 'call_readonly_1', 'knowledge.search', { query: 'mock gateway lookup' });
    case 'l3_tool':
      return toolCallResponse(model, 'call_l3_1', 'record.write.mock', { record: { summary: 'mock gateway write' } });
    case 'user_input':
      return toolCallResponse(model, 'call_user_1', 'request_user_input', {
        question: 'Please provide the missing value.',
        requested_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      });
    case 'handoff':
      return toolCallResponse(model, 'call_handoff_1', 'handoff_to_workflow', {
        target_execution_plan_ref: 'db://flow-execution-plan/plan_handoff',
        arguments: { source: 'mock-gateway' },
      });
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

function toolCallResponse(model: string, id: string, name: string, args: Record<string, unknown>): MockGenerateResponse {
  return {
    id: `mock_${id}`,
    model,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_call', id, name, arguments: args }],
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

function scenarioFromMessages(messages: Array<{ role: string; content: string }>): string {
  const joined = messages.map((message) => message.content).join('\n').toLowerCase();
  for (const scenario of [
    'readonly_tool',
    'l3_tool',
    'user_input',
    'handoff',
    'final_only',
    'malformed_tool_call',
    'rate_limit_then_success',
    'upstream_500_then_success',
    'timeout',
    'excessive_tokens',
  ]) {
    if (joined.includes(scenario)) {
      return scenario;
    }
  }
  return 'readonly_tool';
}

function hasToolResult(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((message) => message.role === 'tool');
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
