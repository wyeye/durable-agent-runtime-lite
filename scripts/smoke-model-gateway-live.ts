import assert from 'node:assert/strict';
import type { ModelGatewayContentBlock, ModelGatewayToolDefinition } from '@dar/contracts';
import { ModelGatewayClient } from '@dar/model-client';

type LiveScenario = 'final' | 'readonly' | 'l3';

async function main() {
  const scenario = liveScenario();
  if (process.env.LIVE_MODEL_GATEWAY_ENABLED !== 'true') {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          scenario,
          reason: 'LIVE_MODEL_GATEWAY_ENABLED is not true',
        },
        null,
        2,
      ),
    );
    return;
  }

  const baseUrl = requiredEnv('LIVE_MODEL_GATEWAY_BASE_URL');
  const apiKey = requiredEnv('LIVE_MODEL_GATEWAY_API_KEY');
  const model = requiredEnv('LIVE_MODEL_GATEWAY_MODEL');
  const provider = process.env.LIVE_MODEL_GATEWAY_PROVIDER ?? 'live-openai-compatible';
  const client = new ModelGatewayClient({
    baseUrl,
    apiKey,
    protocol: 'openai_chat_completions',
    allowInsecureHttp: process.env.LIVE_MODEL_GATEWAY_ALLOW_INSECURE_HTTP === 'true',
    maxRetries: Number(process.env.LIVE_MODEL_GATEWAY_MAX_RETRIES ?? 1),
    timeoutMs: Number(process.env.LIVE_MODEL_GATEWAY_TIMEOUT_MS ?? 30_000),
  });

  const response = await client.call(
    {
      model_request_key: `live-smoke-${scenario}-${Date.now()}`,
      model,
      messages: [{ role: 'user', content: promptForScenario(scenario) }],
      tools: toolsForScenario(scenario),
      tool_choice: scenario === 'final' ? 'none' : 'required',
      response_format: 'text',
      max_output_tokens: 64,
    },
    {
      protocol: 'openai_chat_completions',
      target: {
        target_id: 'live-primary',
        gateway_profile: provider,
        model_id: model,
      },
    },
  );

  const text = response.message.content
    .flatMap((block: ModelGatewayContentBlock) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  const toolCalls = response.message.content.filter(
    (block: ModelGatewayContentBlock) => block.type === 'tool_call',
  );
  if (scenario === 'final') {
    assert.ok(text.length > 0, 'live final smoke response must include text');
  } else {
    assert.ok(
      toolCalls.length > 0,
      `live ${scenario} smoke response must include a structured tool call`,
    );
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        skipped: false,
        scenario,
        model: response.model ?? model,
        finish_reason: response.finish_reason,
        response_id_present: Boolean(response.response_id),
        tool_call_count: toolCalls.length,
        total_tokens: response.usage?.total_tokens ?? 0,
      },
      null,
      2,
    ),
  );
}

function liveScenario(): LiveScenario {
  const value = process.env.LIVE_MODEL_GATEWAY_SCENARIO ?? 'final';
  if (value === 'final' || value === 'readonly' || value === 'l3') {
    return value;
  }
  throw new Error(`Unsupported LIVE_MODEL_GATEWAY_SCENARIO: ${value}`);
}

function promptForScenario(scenario: LiveScenario): string {
  switch (scenario) {
    case 'final':
      return 'Reply with the exact text: durable-agent-runtime-lite-live-smoke-ok';
    case 'readonly':
      return 'Call the provided knowledge.search tool exactly once with query "durable agent runtime live readonly smoke".';
    case 'l3':
      return 'Call the provided record.write.mock tool exactly once with a record summary "durable agent runtime live l3 smoke".';
  }
}

function toolsForScenario(scenario: LiveScenario): ModelGatewayToolDefinition[] {
  if (scenario === 'final') {
    return [];
  }
  if (scenario === 'readonly') {
    return [
      {
        name: 'knowledge.search',
        description: 'Search safe test knowledge.',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ];
  }
  return [
    {
      name: 'record.write.mock',
      description: 'Preview a safe sandbox write.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          record: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
            },
            required: ['summary'],
          },
        },
        required: ['record'],
      },
    },
  ];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when LIVE_MODEL_GATEWAY_ENABLED=true`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
