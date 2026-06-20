import assert from 'node:assert/strict';
import { ModelGatewayClient } from '@dar/model-client';
import type { ModelGatewayContentBlock } from '@dar/contracts';

const OLLAMA_BASE_URL = process.env.OLLAMA_OPENAI_BASE_URL ?? 'http://localhost:11434/v1';
const OLLAMA_TAGS_URL = process.env.OLLAMA_TAGS_URL ?? 'http://localhost:11434/api/tags';
const OLLAMA_MODEL = 'qwen2.5:7b-instruct-q4_K_M';

async function main(): Promise<void> {
  const models = await fetchJson<{ data?: Array<{ id?: string }> }>(
    new URL('/v1/models', OLLAMA_BASE_URL).toString(),
  );
  const modelIds = (models.data ?? []).flatMap((model) => (model.id ? [model.id] : []));
  if (!modelIds.includes(OLLAMA_MODEL)) {
    throw new Error(`Ollama exact model is not available: ${OLLAMA_MODEL}`);
  }
  await fetchJson(OLLAMA_TAGS_URL);

  const client = new ModelGatewayClient({
    baseUrl: OLLAMA_BASE_URL,
    apiKey: process.env.OLLAMA_OPENAI_API_KEY ?? 'ollama',
    protocol: 'openai_chat_completions',
    allowInsecureHttp: true,
    timeoutMs: Number(process.env.OLLAMA_PROBE_TIMEOUT_MS ?? 300_000),
    maxRetries: 0,
    maxResponseBytes: 1_048_576,
  });

  const final = await client.call(
    {
      model_request_key: 'ollama-probe-final',
      model: OLLAMA_MODEL,
      messages: [
        { role: 'user', content: 'Reply with only: durable-agent-runtime-lite-ollama-final-ok' },
      ],
      tools: [],
      tool_choice: 'none',
      response_format: 'text',
      temperature: 0,
      top_p: 1,
      max_output_tokens: 64,
    },
    target(),
  );
  assert.ok(text(final.message.content).length > 0, 'final text probe must return text');

  const toolTurn = await client.call(
    {
      model_request_key: 'ollama-probe-tool-call',
      model: OLLAMA_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a tool-calling assistant. When tool_choice is required, return exactly one structured tool call and no text.',
        },
        {
          role: 'user',
          content:
            'Call the provided search tool exactly once. Query: durable agent runtime ollama probe.',
        },
      ],
      tools: [
        {
          name: 'knowledge.search',
          description: 'Search local probe knowledge.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      tool_choice: 'required',
      response_format: 'text',
      temperature: 0,
      top_p: 1,
      max_output_tokens: 128,
    },
    target(),
  );
  const toolCalls = toolTurn.message.content.filter(
    (block): block is Extract<ModelGatewayContentBlock, { type: 'tool_call' }> =>
      block.type === 'tool_call',
  );
  assert.equal(toolCalls.length, 1, 'tool probe must return exactly one structured tool call');
  assert.equal(toolCalls[0]?.name, 'knowledge.search');
  assert.ok(toolCalls[0]?.id, 'tool probe must return tool call id');

  const afterTool = await client.call(
    {
      model_request_key: 'ollama-probe-tool-result',
      model: OLLAMA_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a tool-calling assistant. When tool_choice is required, return exactly one structured tool call and no text.',
        },
        {
          role: 'user',
          content:
            'Call the provided search tool exactly once. Query: durable agent runtime ollama probe.',
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: toolCalls[0].id,
              name: toolCalls[0].name,
              arguments: toolCalls[0].arguments,
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: toolCalls[0].id,
          name: toolCalls[0].name,
          content: 'local probe result: ok',
        },
      ],
      tools: [
        {
          name: 'knowledge.search',
          description: 'Search local probe knowledge.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      tool_choice: 'none',
      response_format: 'text',
      temperature: 0,
      top_p: 1,
      max_output_tokens: 128,
    },
    target(),
  );
  assert.ok(text(afterTool.message.content).length > 0, 'tool result probe must return final text');

  const jsonObject = await client.call(
    {
      model_request_key: 'ollama-probe-json-object',
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: 'Return a JSON object with key "ok" set to true.' }],
      tools: [],
      tool_choice: 'none',
      response_format: 'json_object',
      temperature: 0,
      top_p: 1,
      max_output_tokens: 128,
    },
    target(),
  );
  JSON.parse(text(jsonObject.message.content));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.call(
      {
        model_request_key: 'ollama-probe-abort',
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: 'This request should be aborted.' }],
        tools: [],
        tool_choice: 'none',
        response_format: 'text',
      },
      { ...target(), signal: controller.signal },
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        model: OLLAMA_MODEL,
        base_url: OLLAMA_BASE_URL,
        final_text_present: text(final.message.content).length > 0,
        usage_present: Boolean(final.usage ?? toolTurn.usage ?? afterTool.usage),
        structured_tool_call: true,
        tool_result_final_text_present: text(afterTool.message.content).length > 0,
        json_object_present: true,
        abort_checked: true,
      },
      null,
      2,
    ),
  );
}

function target() {
  return {
    protocol: 'openai_chat_completions' as const,
    target: {
      target_id: 'ollama-qwen25-7b',
      gateway_profile: 'local-ollama',
      model_id: OLLAMA_MODEL,
    },
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Ollama probe request failed: ${url} ${response.status}`);
  }
  return (await response.json()) as T;
}

function text(content: ModelGatewayContentBlock[]): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
