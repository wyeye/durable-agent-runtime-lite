import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';

interface GenerateRequest {
  model?: string;
  messages?: MockRequestMessage[];
}

interface OpenAiChatRequest {
  model?: string;
  messages?: MockRequestMessage[];
  tools?: Array<{ function?: { name?: string } }>;
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
