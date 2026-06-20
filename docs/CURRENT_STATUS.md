# Current Status

Last updated: 2026-06-20 for AR-2B development pass.

## Platform Version

Current platform version: 0.8.0.

The root `package.json` version is the authority. `corepack pnpm version:check` verifies workspace package versions, `.env.example`, README, this file, and CHANGELOG alignment.

## Baseline

- Observed local HEAD and `origin/main` before the AR-2B-CLOSURE pass: `a1c363aab4c0e0d6e3330165737aa18a6bc03d08`.
- Platform Core Baseline file: `docs/PLATFORM_CORE_BASELINE.md`.
- Migration head: `015_evaluation_runtime_state_machine.sql`.

## AR-1 Platform Core

**COMPLETE / FROZEN**

The AR-1 core remains the four-app runtime:

- `apps/control-plane`
- `apps/runtime-api`
- `apps/runtime-worker`
- `apps/tool-gateway`

The frozen baseline includes DB-backed registry, immutable execution plans, Temporal workflows, Pi Agent Core segmented runtime, Tool Gateway as the only tool boundary, L3 human approval, Tenant Policy Snapshot lineage, Tenant Agent Admission, crash recovery, and Temporal replay gates.

## AR-2A Status

**AR-2A IMPLEMENTATION COMPLETE**

No tag, release, or version promotion has been performed. Platform version remains `0.8.0` during development.

Implemented and locally verified:

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
- `/version` endpoints for all four production apps with `APP_VERSION`, `BUILD_SHA`, and `BUILD_TIME`.
- Docker image build args and OCI labels for all four production app images.
- Trimmed runner images that exclude `.git`, `.env`, app/package source, tests, and Ollama models.
- Container provenance assertion script: `corepack pnpm runtime:assert-containerized`.
- Containerized Ollama runtime gate: `corepack pnpm smoke:ollama-containerized-e2e`.
- Optional self-hosted Ollama workflow: `.github/workflows/ollama-runtime.yml`.
- Mock OpenAI-compatible `/v1/chat/completions` endpoint.
- Control-plane ModelPolicy registry entry and JSON editor template.
- Protected live Model Gateway probe commands that skip unless explicitly enabled.

Verified in this local pass:

- Four production images built from the current working tree with build SHA `d2b9e41f13380fa730a6946e110a6ba196ac1b23-dirty`.
- Docker containers for `control-plane`, `runtime-api`, `runtime-worker`, and `tool-gateway` were healthy.
- `/version` returned `0.8.0` and the dirty build SHA for all four apps.
- `runtime-worker` ran with `PI_AGENT_MODE=model_gateway`, `MODEL_GATEWAY_MODE=openai_compatible`, `MODEL_GATEWAY_PROFILE_ID=local-ollama`, and model `qwen2.5:7b-instruct-q4_K_M`.
- `mock-server` was not running.
- `smoke:ollama-containerized-e2e` passed final, readonly, and L3 paths through the containerized runtime.
- DB evidence showed `provider=local-ollama`, exact model id, readonly/L3 two model calls, one readonly tool call, one L3 committed tool call, one approved L3 Human Task, audit events, and idempotency records.

Remote evidence checked for `origin/main` / `27598fee653fadc33ae9dc8d40fba4b806bf0d85`:

- GitHub CI Run 18 passed.
- GitHub Integration Run 12 passed.

This repository must still not be labeled `0.9.0-rc.1`; AR-2A completion is a development status, not a version promotion.

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
corepack pnpm runtime:assert-containerized
corepack pnpm smoke:ollama-containerized-e2e
corepack pnpm smoke:ollama-runtime-final-e2e
corepack pnpm smoke:ollama-runtime-readonly-e2e
corepack pnpm smoke:ollama-runtime-l3-e2e
```

`ollama:probe` checks the real local Ollama OpenAI-compatible API and exact model availability. `runtime:assert-containerized` proves the four app containers are healthy, versioned, and not using mock/deterministic runtime. `smoke:ollama-containerized-e2e` runs final, readonly, and L3 through the containerized runtime and checks DB evidence.

## Verification In Previous AR-2A Container Pass

Passed:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm version:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:temporal-replay
corepack pnpm runtime:assert-containerized
corepack pnpm ollama:probe
corepack pnpm smoke:ollama-containerized-e2e
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

The Ollama containerized smoke used Dockerized `runtime-api`, `runtime-worker`, `tool-gateway`, and `control-plane`; only Ollama ran on the host.

## Verification In Current AR-2B-CLOSURE Pass

Passed:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm version:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:temporal-replay
corepack pnpm --filter @dar/runtime-worker typecheck
corepack pnpm --filter @dar/db test
corepack pnpm --dir apps/runtime-worker exec vitest run tests/evaluation-workflow.test.ts --reporter=verbose
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.ollama.yml config
```

The local `gh` CLI is not installed, but the public GitHub Actions API showed CI and Integration succeeded for `a1c363aab4c0e0d6e3330165737aa18a6bc03d08`. No Docker image build, container startup smoke, live Ollama evaluation smoke, or new evaluation E2E smoke was completed in this pass.

## Next AR-2B Work

Current AR-2B status: `AR-2B PARTIAL`.

Implemented in this development pass:

- Evaluation dataset, case, subject snapshot, execution plan, run, result, gate policy, gate decision, and override contracts.
- Forward migration `013_evaluation_and_release_gates.sql`.
- Forward migration `014_evaluation_runtime_closure.sql`.
- Forward migration `015_evaluation_runtime_state_machine.sql`.
- DB repositories, stable hashes, deterministic scoring, same-dataset regression comparison, and publish gate decision checks.
- `prompt`, `agent`, and `model_policy` Registry publish gate hooks with exact candidate bundle hash checks.
- `capability_release` now stores evaluation gate decision and override ids.
- Evaluation run workflow now uses deterministic bounded fixed batches from `EVALUATION_MAX_CONCURRENT_CASES`.
- Evaluation case workflow records per-case `system_error` or `cancelled` results instead of letting a single candidate/Pi child failure fail the whole run.
- Evaluation run finalization now persists comparison and gate decision before marking the run completed.
- Evaluation run cancellation now has explicit `cancelling` and `cancelled` states and a repository-backed cancel finalization path.
- Cancelled case results are treated as skipped and excluded from aggregate score denominators.

Still open:

- Production-complete Temporal-backed evaluation smoke coverage.
- Dataset/Case full CRUD and publish lifecycle.
- Gate Policy full CRUD and publish lifecycle.
- Full authoritative Evidence Collector, Tool Evaluation Safety policy enforcement, and tamper tests.
- Gate Decision stale/override closed loop and publish UI selection flow.
- Real Ollama Evaluation E2E.
- Control-plane evaluation pages.
- Evaluation smoke scripts, CI workflow coverage, and full regression suite rerun.
