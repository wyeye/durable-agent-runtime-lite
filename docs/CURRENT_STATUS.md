# Current Status

Last updated: 2026-06-21 for AR-2B-UI-CLOSURE implementation pass.

## Platform Version

Current platform version: 0.8.0.

The root `package.json` version is the authority. `corepack pnpm version:check` verifies workspace package versions, `.env.example`, README, this file, and CHANGELOG alignment.

## Baseline

- Observed local HEAD and `origin/main` before the AR-2B-UI-CLOSURE pass: `e12104fbf2d54b2f4bfc88d1341541be6f7db066`.
- Platform Core Baseline file: `docs/PLATFORM_CORE_BASELINE.md`.
- Migration head: `016_evaluation_registry_and_tool_safety.sql`.

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

Historical AR-2A remote evidence checked for `origin/main` / `27598fee653fadc33ae9dc8d40fba4b806bf0d85`:

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

Evaluation backend E2E smoke entry points:

```bash
corepack pnpm smoke:evaluation-framework-e2e
corepack pnpm smoke:evaluation-regression-gate-e2e
corepack pnpm smoke:evaluation-publish-gate-e2e
corepack pnpm smoke:evaluation-ui-e2e
TEMPORAL_REPLAY_SMOKE_RESULT_FILE=artifacts/evaluation-backend-e2e/framework.json \
  corepack pnpm temporal:export-evaluation-replay-fixtures
corepack pnpm test:temporal-replay
```

These Evaluation smoke commands require the Docker/Temporal/PostgreSQL stack and a `model_gateway` runtime-worker using the mock OpenAI-compatible server. Backend smokes exercise control-plane API -> runtime-api -> Temporal EvaluationRunWorkflow/EvaluationCaseWorkflow -> Pi Durable Agent Runtime -> Tool Gateway -> Evidence Collector -> Scoring -> PostgreSQL. The UI smoke drives the React Evaluation pages through Playwright while setup only prepares immutable candidate snapshot / execution plan records that the UI does not create. They do not run Ollama Evaluation.

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

## Verification In Current AR-2B-E2E-GATE Pass

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
corepack pnpm --filter @dar/runtime-worker test -- --runInBand
corepack pnpm --filter @dar/tool-gateway typecheck
corepack pnpm --filter @dar/tool-gateway test -- --runInBand
corepack pnpm --filter @dar/db build
corepack pnpm --filter @dar/db typecheck
corepack pnpm --filter @dar/db test
corepack pnpm --filter @dar/contracts test -- --runInBand
corepack pnpm --filter @dar/db test -- --runInBand
corepack pnpm --filter @dar/tool-gateway test -- --runInBand
corepack pnpm --filter @dar/runtime-worker test -- --runInBand
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config
git diff --check
```

The local `gh` CLI is not installed, but the public GitHub Actions API showed CI and Integration succeeded for `55cac36713a2b658650e432088fdbe62658d3419`. No Docker image build, container startup smoke, live Ollama evaluation smoke, or new evaluation E2E smoke was completed in this pass.

Current AR-2B-E2E-GATE implementation additions:

- Added `scripts/smoke-evaluation-backend-e2e.ts` with `framework`, `regression`, and `publish_gate` scenarios.
- Framework smoke asserts real TaskRun, AgentRun, ModelCall, ToolCall, Evidence refs, gate decision, audit, Tool Gateway redaction, and PostgreSQL reservation behavior.
- Regression smoke compares baseline/degraded candidates with the same dataset id/version/hash and waits for persisted comparison and gate decision.
- Publish gate smoke covers PromptDefinition, AgentSpec, ModelPolicy exact decision publishing, stale hash blocking, override RBAC, expired override failure, and ModelPolicy release history.
- EvaluationCaseWorkflow now forwards evaluation context into `piDurableAgentWorkflow`, so Tool Gateway policy sees `execution_context_type=evaluation`, evaluation run/case ids, and execution plan ref/hash.
- Temporal replay fixture export now recognizes Evaluation smoke summaries and exports `evaluation-run-success`, `evaluation-case-success`, and `evaluation-case-system-error` histories.
- Integration workflow now runs three Evaluation smoke steps, exports Evaluation histories, and replays them while runtime-worker is in `model_gateway` smoke mode.

## AR-2B UI Closure

Current AR-2B status: `AR-2B PARTIAL`.

Implemented in this UI closure pass:

- Evaluation navigation group with Datasets, Runs, and Gates.
- Dataset List/Detail pages with draft creation, Case create/update/delete, validate, publish, clone, rollback, exact hash display, JSON parse blocking, and published read-only behavior.
- Run List/Detail pages with create exact-version Run modal, polling for queued/running states, cancel, Case Results, safe evidence drawer, aggregate/progress, Comparison, and Gate Decision panels.
- Gate Policy List/Detail pages with exact Dataset refs, validate/publish confirmation, version viewing, clone, thresholds, regression rules, and allow_override display.
- Gate Decision Detail with freshness/stale reasons, exact hashes, run links, and platform_admin-only Override form.
- Prompt, Agent, and ModelPolicy Registry detail Gate Card with latest run/decision/freshness, exact resource hash, candidate bundle hash, decision links, and publish metadata fields for exact decision/override.
- `apps/control-plane/src/web/api/evaluation-api.ts` using the existing API client, identity headers, Standard Error parsing, pagination params, AbortSignal, and `@dar/contracts` types.
- `scripts/smoke-evaluation-ui-e2e.ts` and root `corepack pnpm smoke:evaluation-ui-e2e`.
- Integration workflow `Evaluation UI Smoke` step after backend Evaluation smoke, plus artifact secret-pattern scan.
- `docs/53_evaluation_ui.md`.
- Local Docker-backed verification in this pass ran the backend Evaluation framework/regression/publish-gate smokes and the Evaluation UI smoke on the existing stack after rebuilding/restarting the control-plane image.

Backend AR-2B implementation already includes:

- Evaluation dataset, case, subject snapshot, execution plan, run, result, gate policy, gate decision, and override contracts.
- Forward migration `013_evaluation_and_release_gates.sql`.
- Forward migration `014_evaluation_runtime_closure.sql`.
- Forward migration `015_evaluation_runtime_state_machine.sql`.
- Forward migration `016_evaluation_registry_and_tool_safety.sql`.
- Evaluation dataset content hash now includes dataset metadata plus all enabled and disabled cases in stable order.
- Draft case create/update/delete paths refresh the draft dataset content hash and published datasets are immutable at the repository layer.
- Evaluation execution plan build and evaluation run plan loading verify exact dataset content hash before use.
- Gate Policy required dataset refs are typed as `dataset_id/version/dataset_hash` and publish validation checks exact published dataset hashes.
- DB repositories, stable hashes, deterministic scoring, same-dataset regression comparison, and publish gate decision checks.
- `prompt`, `agent`, and `model_policy` Registry publish gate hooks with exact candidate bundle hash checks.
- `capability_release` now stores evaluation gate decision and override ids.
- Evaluation run workflow now uses deterministic bounded fixed batches from `EVALUATION_MAX_CONCURRENT_CASES`.
- Evaluation case workflow records per-case `system_error` or `cancelled` results instead of letting a single candidate/Pi child failure fail the whole run.
- Evaluation run finalization now persists comparison and gate decision before marking the run completed.
- Evaluation run cancellation now has explicit `cancelling` and `cancelled` states and a repository-backed cancel finalization path.
- Cancelled case results are treated as skipped and excluded from aggregate score denominators.
- Evaluation Evidence Collector now emits explicit safe output refs, agent step refs, model call attempt refs, idempotency refs, human task refs, audit refs, tool order/result refs, completeness status, and `EVALUATION_EVIDENCE_INCOMPLETE` when required DB evidence is missing.
- Evaluation case `system_error` recording now attempts authoritative evidence collection before persisting the case result, so existing model/tool refs are not discarded on failure paths.
- Incomplete Evidence now fails closed through system-error scoring, and collector fallback stores safe error codes rather than raw internal error messages.
- Tool Gateway evaluation policy now enforces `maximum_calls_per_case` through logical-call reservations scoped by tenant, evaluation run, case, and tool.
- Preview and commit with the same `tool_call_id` are counted as one logical evaluation tool call; idempotent retries do not consume additional executed-call capacity.

Still open:

- Fresh four-image Docker rebuild evidence from a clean Docker state for this pass.
- Real Ollama Evaluation E2E.

Current version remains `0.8.0`. No tag or release has been created.
