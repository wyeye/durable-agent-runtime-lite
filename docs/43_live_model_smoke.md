# Live Model Smoke

Protected live model probes are opt-in.

Required environment:

```text
LIVE_MODEL_GATEWAY_ENABLED=true
LIVE_MODEL_GATEWAY_BASE_URL
LIVE_MODEL_GATEWAY_API_KEY
LIVE_MODEL_GATEWAY_MODEL
LIVE_MODEL_GATEWAY_PROVIDER
LIVE_MODEL_GATEWAY_TIMEOUT_MS
```

Commands:

```bash
corepack pnpm smoke:model-gateway-live-final-e2e
corepack pnpm smoke:model-gateway-live-readonly-e2e
corepack pnpm smoke:model-gateway-live-l3-e2e
```

If `LIVE_MODEL_GATEWAY_ENABLED` is not `true`, each command prints `skipped: true` and exits 0. If enabled but required configuration is missing, it exits non-zero.

Current local implementation verifies the external OpenAI-compatible protocol and structured tool-call capability directly through `ModelGatewayClient`.

For local Ollama, the full runtime chain is covered by:

```bash
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm smoke:ollama-containerized-e2e
```

That command proves:

```text
runtime-api -> Temporal -> runtime-worker -> Pi -> Tool Gateway -> Pi final
```

with the host Ollama OpenAI-compatible API and exact model `qwen2.5:7b-instruct-q4_K_M`.

For external providers, a protected runtime live chain still needs a secure environment with real credentials. Until the containerized gate, full regression, and latest GitHub CI/Integration all pass on the committed diff, AR-2A remains `PARTIAL`.
