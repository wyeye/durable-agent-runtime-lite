# Model Gateway Contract

`packages/model-client` defines the Model Gateway contract used by
`PI_AGENT_MODE=model_gateway`. It supports the legacy `dar_generate` test
contract and the production-oriented OpenAI-compatible Chat Completions adapter.

## Request

```json
{
  "model": "dar-local-model",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
    { "role": "tool", "content": "..." }
  ],
  "max_tokens": 1000,
  "request_id": "optional",
  "task_run_id": "optional",
  "agent_run_id": "optional"
}
```

The client supports `AbortSignal`, request timeout, response-size limit, and
retry for 429/5xx/network failures. The request has no tool side effect; tool
execution remains mediated by Temporal and Tool Gateway.

## Response

Preferred structured response:

```json
{
  "id": "resp_1",
  "model": "dar-local-model",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "..." },
      {
        "type": "tool_call",
        "id": "call_1",
        "name": "knowledge.search",
        "arguments": { "query": "..." }
      }
    ]
  },
  "finish_reason": "tool_call",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5,
    "total_tokens": 15
  },
  "provider_metadata": {}
}
```

`finish_reason` values:

```text
stop
tool_call
length
error
```

Backward compatibility: legacy responses with `content: "..."` are parsed as a
single assistant text block. New code prefers `message.content`.

Tool call `arguments` must be a JSON object. Invalid tool-call arguments fail
schema parsing with an explicit client-side error; they are not coerced into
empty objects.

## Pi Mapping

`createModelGatewayPiStream` maps the response into Pi assistant events:

- text blocks -> Pi text blocks;
- `tool_call` blocks -> Pi `toolCall` blocks;
- `finish_reason=tool_call` -> Pi `stopReason=toolUse`;
- `finish_reason=length` -> Pi `stopReason=length`;
- `finish_reason=error` -> Pi `stopReason=error`;
- usage -> Pi usage and then `agent_run` cumulative usage.

The adapter never logs API keys or full prompts.

## Local Mock Gateway

`devtools/mock-server` exposes:

```text
GET /healthz
GET /readyz
POST /v1/generate
POST /v1/chat/completions
```

Supported deterministic scenarios:

- `readonly_tool`
- `l3_tool`
- `user_input`
- `handoff`
- `final_only`
- `malformed_tool_call`
- `rate_limit_then_success`
- `upstream_500_then_success`
- `timeout`
- `excessive_tokens`

The mock gateway chooses a scenario from message content. When it later sees a
tool-role message, it returns a final answer. It is available only through the
dev/test Docker override and is not a production service.

The OpenAI-compatible endpoint returns `choices[].message.tool_calls` with JSON
string arguments, matching the provider shape consumed by the adapter.

## Production Mode

Production readiness requires:

```text
PI_AGENT_MODE=model_gateway
MODEL_GATEWAY_MODE=openai_compatible
MODEL_GATEWAY_PROTOCOL=openai_chat_completions
MODEL_GATEWAY_BASE_URL
MODEL_GATEWAY_API_KEY
```

`PI_AGENT_MODE=deterministic` is rejected in production. Missing or invalid
model gateway configuration should make runtime-worker not ready instead of
falling back to mock data.
