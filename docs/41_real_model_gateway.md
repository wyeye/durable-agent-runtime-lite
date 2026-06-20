# Real Model Gateway

The runtime integrates external model providers through `packages/model-client`.

Supported protocols:

- `dar_generate`
- `openai_chat_completions`

Production `runtime-worker` readiness requires:

```text
PI_AGENT_MODE=model_gateway
MODEL_GATEWAY_MODE=openai_compatible
MODEL_GATEWAY_PROTOCOL=openai_chat_completions
MODEL_GATEWAY_BASE_URL
MODEL_GATEWAY_API_KEY
```

Production readiness rejects the development-only `local-ollama` profile, the
placeholder `ollama` API key, and insecure HTTP transport.

`devtools/mock-server` is development/test only. It is exposed by `infra/docker-compose.pi-smoke.yml` and must not be used as a production dependency.

The OpenAI-compatible adapter supports system/user/assistant/tool messages, tool definitions, structured tool calls, tool choice, parallel tool call flag, response format, usage, response id, timeout, AbortSignal, response-size limit, and bounded retry for retryable transport errors.

Provider-facing tool names are request-local aliases. Canonical runtime names
such as `knowledge.search` are encoded to OpenAI-compatible names before the
request and decoded before the response enters Pi. Unknown aliases, duplicate
tool call ids, missing `tool_call_id`, duplicate tool results, and unmatched
tool results fail closed.

Tool calls returned by the model remain deferred proposals. Execution still follows:

```text
Pi -> Deferred Tool -> Temporal -> Activity -> Tool Gateway
```

L3 still follows:

```text
preview -> Human Task -> Signal -> commit
```

Model-call ledger records use a logical request key per agent run segment and
model turn. The key does not include the selected target id, so retry/fallback
attempts remain attached to one logical call. Attempts record
`global_attempt_index`, `target_attempt_index`, and `fallback_index`; replay only
uses stored successful safe responses. Oversized normalized model responses fail
with `MODEL_RESPONSE_LEDGER_LIMIT_EXCEEDED` instead of being silently truncated.

Local Ollama validation:

```bash
corepack pnpm ollama:probe
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm runtime:assert-containerized
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm smoke:ollama-containerized-e2e
corepack pnpm smoke:ollama-runtime-final-e2e
corepack pnpm smoke:ollama-runtime-readonly-e2e
corepack pnpm smoke:ollama-runtime-l3-e2e
```

`ollama:probe` checks the exact local model `qwen2.5:7b-instruct-q4_K_M`.
The containerized smoke requires Dockerized `runtime-api`, `runtime-worker`,
`tool-gateway`, and `control-plane`; only Ollama runs on the host. It fails if
`mock-server` is running, deterministic Pi is enabled, or the DB evidence does
not show `provider=local-ollama` and model `qwen2.5:7b-instruct-q4_K_M`.
