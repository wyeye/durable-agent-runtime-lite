# Current Status

Last updated: 2026-06-19 for R0 + AR-2A Platform Core Freeze and Real Model Gateway Integration.

## Platform Version

Current platform version: 0.8.0.

The root `package.json` version is the authority. `corepack pnpm version:check` verifies workspace package versions, `.env.example`, README, this file, and CHANGELOG alignment.

## Baseline

- Observed local HEAD and `origin/main` during this pass: `b4ead47817c1c32f71045139cbdee434a8709afe`.
- User-provided expected baseline: `ab7cec9`.
- Platform Core Baseline file: `docs/PLATFORM_CORE_BASELINE.md`.
- Migration head: `011_model_policy_and_calls.sql`.

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
- Mock OpenAI-compatible `/v1/chat/completions` endpoint.
- Control-plane ModelPolicy registry entry and JSON editor template.
- Protected live Model Gateway probe commands that skip unless explicitly enabled.

Not completed in this local pass:

- Full runtime live final, readonly, and L3 smokes against real external credentials.
- Full protected GitHub live-model runtime workflow with Docker stack, migrations, seed, runtime live smokes, artifacts, and teardown. A protected provider-level probe workflow exists at `.github/workflows/live-model.yml`.
- Full local fallback/crash model-gateway smoke commands requested for AR-2A.
- Full Docker image rebuild and long-running smoke suite after the final AR-2A partial edits.
- Complete Model Usage dashboard and operations model-call query UI.

Because live runtime smokes were not executed with real credentials, this repository must not be labeled `0.9.0-rc.1` yet.

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
corepack pnpm smoke:model-gateway-live
corepack pnpm smoke:model-gateway-live-final-e2e
corepack pnpm smoke:model-gateway-live-readonly-e2e
corepack pnpm smoke:model-gateway-live-l3-e2e
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config
git diff --check
```

`smoke:model-gateway-live` skipped because `LIVE_MODEL_GATEWAY_ENABLED` was not `true`.

## Next AR-2B Work

- Run full Docker build and integrated smoke suite after credentials are available.
- Add protected `.github/workflows/live-model.yml`.
- Promote AR-2A only after live final, readonly, and L3 runtime smokes pass without deterministic Pi or mock-server.
- Add evaluation and release gate metrics in AR-2B.
