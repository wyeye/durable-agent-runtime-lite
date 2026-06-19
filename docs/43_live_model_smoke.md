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

Current local implementation verifies the external OpenAI-compatible protocol and structured tool-call capability directly through `ModelGatewayClient`. The full runtime live chain still needs a protected environment with real credentials to prove:

```text
runtime-api -> Temporal -> runtime-worker -> Pi -> Tool Gateway -> Pi final
```

Until that protected runtime live chain passes, AR-2A remains `PARTIAL`.
