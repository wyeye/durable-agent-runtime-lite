# Current Status

Last updated: 2026-06-19 for R0 + AR-2A local Ollama hardening.

## Platform Version

Current platform version: 0.8.0.

The root `package.json` version is the authority. `corepack pnpm version:check` verifies workspace package versions, `.env.example`, README, this file, and CHANGELOG alignment.

## Baseline

- Observed local HEAD and `origin/main` before this pass: `170b327b4dd3cc280095e38eb17734fb10d06d2c`.
- Platform Core Baseline file: `docs/PLATFORM_CORE_BASELINE.md`.
- Migration head: `012_model_call_attempt_indexes.sql`.

## AR-1 Platform Core

**COMPLETE / FROZEN**

The AR-1 core remains the four-app runtime:

- `apps/control-plane`
- `apps/runtime-api`
- `apps/runtime-worker`
- `apps/tool-gateway`

The frozen baseline includes DB-backed registry, immutable execution plans, Temporal workflows, Pi Agent Core segmented runtime, Tool Gateway as the only tool boundary, L3 human approval, Tenant Policy Snapshot lineage, Tenant Agent Admission, crash recovery, and Temporal replay gates.

## AR-2A Status

**PARTIAL**

Implemented and locally verified in this pass:

- ModelPolicy contracts and Zod DTOs.
- `model_policy`, `model_call_log`, and `model_call_attempt` migration.
- ModelPolicy repository and model call ledger repositories.
- AgentSpec exact `model_policy_ref` requirement for new execution plans.
- AgentExecutionPlan lock of `model_policy_id`, version, hash, and `resolved_model_policy`.
- Tenant model enforcement against ModelPolicy target/model aliases.
- OpenAI-compatible Model Gateway client adapter.
- Runtime-worker Pi stream integration through existing Pi Agent Core.
- Stable local model request keys and safe model response replay.
- OpenAI-compatible assistant `tool_calls` / `tool_call_id` round-trip preservation.
- Provider-safe tool-name encoding/decoding for tools such as `knowledge.search`.
- Retry/fallback attempt ledger indexes (`global_attempt_index`, `target_attempt_index`, `fallback_index`).
- Local Ollama OpenAI-compatible probe script for exact model `qwen2.5:7b-instruct-q4_K_M`.
- Docker compose override for development/test local Ollama via `host.docker.internal:11434`.
- Local current-code runtime smokes for Ollama final, readonly tool, and L3 human-confirmed tool paths.
- Mock OpenAI-compatible `/v1/chat/completions` endpoint.
- Control-plane ModelPolicy registry entry and JSON editor template.
- Protected live Model Gateway probe commands that skip unless explicitly enabled.

Not completed in this local pass:

- Full protected GitHub live-model runtime workflow with Docker stack, migrations, seed, runtime live smokes, artifacts, and teardown. A protected provider-level probe workflow exists at `.github/workflows/live-model.yml`.
- Full Docker image rebuild and containerized Ollama runtime smoke after the final AR-2A edits. The local runtime smokes were executed with current host-built runtime-api/runtime-worker code against Docker PostgreSQL, Temporal, and Tool Gateway.
- Complete Model Usage dashboard and operations model-call query UI.

Because the final Docker image rebuild and containerized Ollama runtime smoke are not complete, this repository must not be labeled `0.9.0-rc.1` yet.

## Model Gateway Runtime

Production requirements:

```text
PI_AGENT_MODE=model_gateway
MODEL_GATEWAY_MODE=openai_compatible
MODEL_GATEWAY_PROTOCOL=openai_chat_completions
MODEL_GATEWAY_BASE_URL
MODEL_GATEWAY_API_KEY
```

Development/test mock gateway is only available through `infra/docker-compose.pi-smoke.yml` and `devtools/mock-server`.

Local Ollama development/test profile:

```text
MODEL_GATEWAY_PROFILE_ID=local-ollama
MODEL_GATEWAY_BASE_URL=http://host.docker.internal:11434/v1
MODEL_GATEWAY_API_KEY=ollama
MODEL_GATEWAY_MODEL=qwen2.5:7b-instruct-q4_K_M
MODEL_GATEWAY_ALLOW_INSECURE_HTTP=true
```

`local-ollama`, insecure HTTP, and the placeholder `ollama` API key are rejected by production readiness.

## Smoke Commands

Existing local/deterministic and mock-gateway smoke entry points:

```bash
corepack pnpm smoke:temporal-db-e2e
corepack pnpm smoke:control-plane-api-e2e
corepack pnpm smoke:control-plane-ui-e2e
corepack pnpm smoke:pi-readonly-e2e
corepack pnpm smoke:pi-l3-e2e
corepack pnpm smoke:pi-user-input-e2e
corepack pnpm smoke:pi-handoff-e2e
corepack pnpm smoke:pi-restart-resume-e2e
corepack pnpm smoke:pi-model-gateway-e2e
corepack pnpm smoke:model-gateway-retry-e2e
corepack pnpm smoke:pi-worker-crash-resume-e2e
corepack pnpm smoke:tenant-policy-e2e
corepack pnpm smoke:tenant-policy-snapshot-e2e
corepack pnpm smoke:tenant-concurrency-e2e
corepack pnpm smoke:tenant-flow-agent-e2e
corepack pnpm smoke:tenant-handoff-lineage-e2e
corepack pnpm smoke:tenant-policy-crash-snapshot-e2e
corepack pnpm smoke:tenant-admission-reconcile-e2e
```

Protected live probes:

```bash
corepack pnpm smoke:model-gateway-live-final-e2e
corepack pnpm smoke:model-gateway-live-readonly-e2e
corepack pnpm smoke:model-gateway-live-l3-e2e
```

These live commands require `LIVE_MODEL_GATEWAY_ENABLED=true`; otherwise they print `skipped: true`.

Local Ollama probe and runtime smokes:

```bash
corepack pnpm ollama:probe
corepack pnpm smoke:ollama-runtime-final-e2e
corepack pnpm smoke:ollama-runtime-readonly-e2e
corepack pnpm smoke:ollama-runtime-l3-e2e
```

`ollama:probe` checks the real local Ollama OpenAI-compatible API and exact model availability. The `smoke:ollama-runtime-*` commands use `/v1/agent-tasks` and require the DB, Temporal, runtime-api, runtime-worker, and tool-gateway stack to be running with `infra/docker-compose.ollama.yml`.

## Verification In This Pass

Passed:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm version:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:temporal-replay
corepack pnpm ollama:probe
corepack pnpm smoke:ollama-runtime-final-e2e
corepack pnpm smoke:ollama-runtime-readonly-e2e
corepack pnpm smoke:ollama-runtime-l3-e2e
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.ollama.yml config
git diff --check
```

Completed with the protected expected skip because `LIVE_MODEL_GATEWAY_ENABLED` was not `true`:

```bash
corepack pnpm smoke:model-gateway-live
corepack pnpm smoke:model-gateway-live-final-e2e
corepack pnpm smoke:model-gateway-live-readonly-e2e
corepack pnpm smoke:model-gateway-live-l3-e2e
```

The Ollama runtime smokes used current host-built `runtime-api` and `runtime-worker` processes with Docker PostgreSQL, Temporal, and Tool Gateway; this proved the real runtime data path but did not prove rebuilt app images.

## Next AR-2B Work

- Run full Docker build and integrated smoke suite after credentials are available.
- Run the protected `.github/workflows/live-model.yml` provider probes against real credentials.
- Promote AR-2A only after protected live final, readonly, and L3 checks plus containerized Docker runtime smokes pass without deterministic Pi or mock-server.
- Add evaluation and release gate metrics in AR-2B.
