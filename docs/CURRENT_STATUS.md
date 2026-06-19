# Current Status

Last updated for AR-1.2C-FINAL completion: Tenant Policy Production Closure, operational visibility, readiness hardening, admission reconcile, audit idempotency, and full regression gates.

CI-HOTFIX-1 local validation note: GitHub Actions pnpm bootstrap verification completed locally; remote CI/Integration still require verification after this hotfix is committed and pushed.

## AR-1.2C Status

**COMPLETE**

The repository now includes the AR-1.2C implementation pieces, unit coverage, deep-chain smoke entry points, expanded integration workflow, and documentation. The full static, Docker, live compose, legacy smoke, Pi smoke, tenant policy smoke, new deep-chain smoke, crash-resume, Temporal fixture export, and replay sequence has been rerun successfully against the current diff.

## Completed Platform Capabilities

1. DB-backed FlowSpec / RouteSpec / ToolManifest source of truth.
2. Runtime API DB route source without production fallback to memory sample data.
3. Temporal workflow start and runtime-worker consumption.
4. runtime-worker tool orchestration through Tool Gateway.
5. L3 `preview -> human approve/reject -> commit` governance using Temporal Signals.
6. Persistent `human_task`, `audit_event`, `tool_call_log`, and `idempotency_record`.
7. Registry lifecycle states: `draft`, `validated`, `published`, `gray`, `deprecated`, `disabled`.
8. Immutable `FlowExecutionPlan` and exact runtime `execution_plan_ref` usage.
9. Real Pi Agent Core inner loop in runtime-worker.
10. Temporal `piDurableAgentWorkflow` supervisor for Pi segment boundaries.
11. Persistent `agent_execution_plan`, `agent_run`, `agent_step`, and `agent_context_snapshot`.
12. Safe Pi context snapshot serialization without hidden reasoning or secret-like fields.
13. Deferred Pi tools that propose tool calls without executing side effects.
14. Agent L3 governance through Tool Gateway preview, Human Task Signal, commit, and Pi context resume.
15. Controlled `handoff_to_workflow` child `ConfigDrivenWorkflow` execution for allowed handoff targets.
16. Model Gateway contract with development mock server under `devtools/mock-server`.
17. Runtime API header auth mode with production fail-closed identity requirements.
18. Tool Gateway service-token identity checks for runtime-worker and control-plane callers.
19. Real Docker `SIGKILL` Pi worker crash recovery smoke script and Temporal replay gate.

## Completed Tenant Policy Runtime

1. TenantRuntimePolicy lifecycle and migration `008_tenant_runtime_policy.sql`.
2. Immutable Tenant Policy Snapshot.
3. Snapshot lineage and migration `009_tenant_policy_snapshot_lineage.sql`.
4. Root, Flow Agent Child, Workflow Handoff Child, and nested handoff snapshot derivation types.
5. Worker model, tool, handoff, and budget effective policy enforcement.
6. ConfigDrivenWorkflow non-agent tool step policy enforcement.
7. Tool Gateway invoke/preview/commit final policy validation.
8. PostgreSQL advisory transaction lock for concurrent Tenant Agent Admission.
9. Tenant policy seed path in `scripts/seed-examples.ts`.
10. Tenant policy, snapshot, and concurrency smoke scripts.
11. Admission reconcile CLI with dry-run default, `--tenant-id`, `--batch-size`, `--stale-after-ms`, fail-closed Temporal connection handling, safe JSON output, idempotent `agent.admission.reconciled` audit, and DB/Temporal cleanup.
12. Runtime API and Tool Gateway real `/readyz` services.
13. Production service-token placeholder/length/difference validation.
14. Tool Gateway debug idempotency endpoint disabled by default and gated by `idempotency:debug`.
15. Tool Gateway readonly invoke now records committed `tool_call_log` rows for operational proof.

## Operations Visibility

Control-plane has read-only APIs and UI pages for runtime policy snapshots and tenant admissions:

```text
GET /api/v1/tenant-runtime-policy-snapshots
GET /api/v1/tenant-runtime-policy-snapshots/:snapshotId
GET /api/v1/tenant-agent-admissions
GET /api/v1/tenant-agent-admissions/:admissionId
/policy-snapshots
/tenant-admissions
```

Supported filters include snapshot root/parent/execution plan/source policy/derivation/created time and admission status/task/agent/workflow/acquired time. No create/update/delete routes are exposed for these resources.

## Smoke Commands

Existing smoke:

```bash
corepack pnpm smoke:temporal-db-e2e
corepack pnpm smoke:control-plane-api-e2e
corepack pnpm smoke:control-plane-ui-e2e
corepack pnpm smoke:pi-readonly-e2e
corepack pnpm smoke:pi-l3-e2e
corepack pnpm smoke:pi-user-input-e2e
corepack pnpm smoke:pi-handoff-e2e
corepack pnpm smoke:pi-model-gateway-e2e
corepack pnpm smoke:pi-worker-crash-resume-e2e
corepack pnpm smoke:tenant-policy-e2e
corepack pnpm smoke:tenant-policy-snapshot-e2e
corepack pnpm smoke:tenant-concurrency-e2e
```

AR-1.2C smoke entry points:

```bash
corepack pnpm smoke:tenant-flow-agent-e2e
corepack pnpm smoke:tenant-handoff-lineage-e2e
corepack pnpm smoke:tenant-policy-crash-snapshot-e2e
corepack pnpm smoke:tenant-admission-reconcile-e2e
```

## Runtime Compatibility

Production requires:

```text
CONTROL_PLANE_AUTH_MODE=header
RUNTIME_API_AUTH_MODE=header
RUNTIME_API_ROUTE_SOURCE=db
RUNTIME_API_WORKFLOW_STARTER=temporal
TOOL_GATEWAY_AUTH_MODE=service_token
TOOL_GATEWAY_REGISTRY_SOURCE=db
TENANT_RUNTIME_POLICY_MODE=required
PI_AGENT_MODE=model_gateway
```

Development/test may use deterministic Pi and mock Model Gateway through `infra/docker-compose.pi-smoke.yml`; `devtools/mock-server` is not a production app or production container.

## Audit State

Implemented event families include:

- `policy.publish`
- `policy.rollback`
- `policy.deprecated`
- `policy.disabled`
- `policy.snapshot.created`
- `policy.snapshot.derived`
- `policy.snapshot.hash_mismatch`
- `policy.resolve.allowed`
- `policy.resolve.denied`
- `agent.admission.reconciled`
- `agent.human_task.created`
- existing human task decision events
- `tool.invoke`
- `tool.preview`
- `tool.commit`
- `tool.idempotency_replay`

Migration `010_runtime_audit_and_ops.sql` adds `audit_event.event_key` plus indexes for retry-safe logical events and operations queries.

## Verified Regression Gate

The following gate passed for this completion. Commands are shown without the local `rtk` wrapper used in this workspace.

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config
COMPOSE_PARALLEL_LIMIT=1 docker compose -f infra/docker-compose.yml build control-plane runtime-api runtime-worker tool-gateway
docker compose -f infra/docker-compose.yml up -d postgres valkey temporal temporal-ui
corepack pnpm db:migrate
corepack pnpm seed:examples
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml up -d mock-server tool-gateway runtime-worker runtime-api control-plane
curl http://localhost:3000/readyz
curl http://localhost:3200/readyz
curl http://localhost:3100/readyz
curl http://localhost:3300/readyz
corepack pnpm smoke:temporal-db-e2e
corepack pnpm smoke:control-plane-api-e2e
corepack pnpm smoke:control-plane-ui-e2e
corepack pnpm smoke:pi-readonly-e2e
corepack pnpm smoke:pi-l3-e2e
corepack pnpm smoke:pi-user-input-e2e
corepack pnpm smoke:pi-handoff-e2e
PI_AGENT_MODE=model_gateway docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml up -d runtime-worker
corepack pnpm smoke:pi-model-gateway-e2e
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml up -d runtime-worker
corepack pnpm smoke:pi-worker-crash-resume-e2e
corepack pnpm smoke:tenant-policy-e2e
corepack pnpm smoke:tenant-policy-snapshot-e2e
corepack pnpm smoke:tenant-concurrency-e2e
corepack pnpm smoke:tenant-flow-agent-e2e
corepack pnpm smoke:tenant-handoff-lineage-e2e
corepack pnpm smoke:tenant-policy-crash-snapshot-e2e
corepack pnpm smoke:tenant-admission-reconcile-e2e
TEMPORAL_REPLAY_SMOKE_RESULT_FILE=artifacts/pi-worker-crash-resume/result.json corepack pnpm temporal:export-replay-fixtures
corepack pnpm test:temporal-replay
git diff --check
```

Runtime API `/readyz` verified `config`, `database`, `route_registry`, `temporal`, `tenant_policy`, and `auth`. Tool Gateway `/readyz` verified `config`, `database`, `tool_registry`, `policy_snapshot_store`, and `service_auth`. Control-plane and runtime-worker returned ready states; runtime-worker was restored to deterministic smoke mode after the model-gateway smoke.

## Out Of Scope / Remaining

1. Full aspirational `agent.run.*`, `agent.segment.*`, `agent.tool.*`, `agent.handoff.*`, `agent.continue_as_new`, and `agent.worker.recovered` audit taxonomy is not completely implemented.
2. No production OpenTelemetry completeness work was attempted.
3. No live production model-gateway smoke with real credentials was attempted.
4. No real business system adapters, fifth production app, or fifth production container were added.
