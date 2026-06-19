import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';

interface GenerateRequest {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
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

  return server;
}

const attempts = new Map<string, number>();

function incrementAttempt(key: string): number {
  const next = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, next);
  return next;
}

function responseForScenario(scenario: string, request: GenerateRequest) {
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

function toolCallResponse(model: string, id: string, name: string, args: Record<string, unknown>) {
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

function finalResponse(model: string, text: string) {
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
