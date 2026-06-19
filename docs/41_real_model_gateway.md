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

`devtools/mock-server` is development/test only. It is exposed by `infra/docker-compose.pi-smoke.yml` and must not be used as a production dependency.

The OpenAI-compatible adapter supports system/user/assistant/tool messages, tool definitions, structured tool calls, tool choice, parallel tool call flag, response format, usage, response id, timeout, AbortSignal, response-size limit, and bounded retry for retryable transport errors.

Tool calls returned by the model remain deferred proposals. Execution still follows:

```text
Pi -> Deferred Tool -> Temporal -> Activity -> Tool Gateway
```

L3 still follows:

```text
preview -> Human Task -> Signal -> commit
```
