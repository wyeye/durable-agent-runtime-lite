# V1 Release Criteria

V1 is releasable only when these gates pass from a clean checkout:

- `corepack pnpm install --frozen-lockfile`
- `corepack pnpm version:check`
- `corepack pnpm lint`
- `corepack pnpm typecheck`
- `corepack pnpm test`
- `corepack pnpm build`
- `corepack pnpm test:temporal-replay`
- `docker compose -f infra/docker-compose.yml config`
- `docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config`
- Four production images build: `control-plane`, `runtime-api`, `runtime-worker`, `tool-gateway`.
- Existing deterministic, model-gateway mock, tenant policy, crash recovery, and replay smokes pass.
- Protected live model final, readonly tool, and L3 smokes pass without deterministic Pi or mock-server.

Security gates:

- No API keys, Authorization headers, cookies, service tokens, hidden reasoning, full raw provider responses, or sensitive prompts are persisted to DB, logs, audit, traces, Docker layers, or artifacts.
- Production `PI_AGENT_MODE=model_gateway` requires `MODEL_GATEWAY_MODE=openai_compatible`.
- Tool calls still pass through Tool Gateway; Model Gateway never executes tools.

Data gates:

- AgentSpec references exact ModelPolicy id/version/hash.
- AgentExecutionPlan freezes ResolvedModelPolicy and never reads `latest` at runtime.
- Tenant policy model allow/deny applies to primary and fallback model targets.
- Model call ledger prevents duplicate provider calls after successful persistence.
