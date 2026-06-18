# Current Status

Last updated for AR-1: Pi segmented agent loop and Temporal durable supervisor.

## Completed Platform Capabilities

1. DB-backed FlowSpec / RouteSpec / ToolManifest source of truth.
2. runtime-api DB route source without production fallback to memory sample data.
3. Temporal workflow start and runtime-worker consumption.
4. runtime-worker tool orchestration through tool-gateway.
5. L3 `preview -> human approve/reject -> commit` governance.
6. Persistent `human_task`, `audit_event`, `tool_call_log`, and `idempotency_record`.
7. Registry lifecycle states: `draft`, `validated`, `published`, `gray`, `deprecated`, `disabled`.
8. Migration `004_control_plane_registry.sql`, governance columns, `capability_release`, and `archived -> deprecated` migration.
9. Five DB Registry repositories and `CapabilityReleaseRepository`.
10. `RegistryValidationService`.
11. `RegistryReleaseService`.
12. Publish, Flow + Route joint publish, gray, rollback, deprecate, disable.
13. Deterministic gray allowlist selection.
14. Header authentication and RBAC for control-plane.
15. control-plane Registry management API.
16. control-plane standard error mapping and OpenAPI.
17. control-plane operations BFF for Human Task, TaskRun, Audit and ToolCall.
18. runtime-api minimal Human Task and TaskRun query extensions.
19. tool-gateway minimal Audit and ToolCall query extensions with sensitive field masking.
20. control-plane Fastify API + Vite static resources in one Node/Fastify container.
21. Docker + PostgreSQL + Temporal smoke path: `smoke:temporal-db-e2e`.
22. control-plane API smoke: `smoke:control-plane-api-e2e`.
23. control-plane UI smoke: `smoke:control-plane-ui-e2e`.
24. Real Pi Agent Core inner loop in runtime-worker.
25. Temporal `piDurableAgentWorkflow` supervisor for Pi segment boundaries.
26. Persistent `agent_execution_plan`, `agent_run`, `agent_step`, and `agent_context_snapshot`.
27. Safe Pi context snapshot serialization without hidden reasoning or secret-like fields.
28. Deferred Pi tools that propose tool calls without executing side effects.
29. Agent L3 governance path through Tool Gateway preview, Human Task Signal, commit, and Pi context resume.
30. Explicit `/v1/agent-tasks`, `/v1/agent-runs`, `/v1/agent-runs/:id/steps`, and user-input Human Task response APIs.

## Completed In AR-0

1. Immutable `FlowExecutionPlan` contract and `flow_execution_plan` table.
2. Registry publish creates an execution plan that locks Flow, Agent, Prompt, Tool, risk, allowed tools and budget references.
3. runtime-api resolves and stores `execution_plan_ref` before starting `ConfigDrivenWorkflow`.
4. runtime-worker loads execution plans by exact ref and does not select `latest` during workflow execution.
5. Tool Gateway validates exact tool version/hash/risk from the execution plan.
6. L3 Human Task wait now uses Temporal Signal after runtime-api writes the DB decision.
7. runtime-worker readiness tracks the real Temporal Worker state and graceful shutdown closes Worker, NativeConnection and shared DB resources.
8. CI workflow added for install, lint, typecheck, test, build, PostgreSQL repository tests and docker compose config.

## Completed In CP-R5 + CP-R6

1. React app moved under `apps/control-plane/src/web`.
2. Unified same-origin API client for `/api/v1/...`.
3. Development Identity Panel with `user_id`, `tenant_id`, and `roles`.
4. RBAC-aware write buttons and auditor read-only notice.
5. Dashboard page.
6. Generic Registry ResourcePage for Flow, Route, Tool, Agent and Prompt.
7. JSON draft create/edit with local parse guard and formatting.
8. `expected_revision` draft update support.
9. Validate result display with errors, warnings and dependency graph.
10. Publish, gray, rollback, deprecate and disable confirmation modals with `release_note`.
11. Gray tenant/user allowlist input.
12. Release history and Release Center.
13. Simple side-by-side JSON version comparison.
14. Flow step summary.
15. Route threshold, examples, channel, role and gray allowlist summary.
16. Tool L3/L4 risk labels and warnings.
17. Agent Prompt/Tool dependency summary.
18. Prompt content and variable summary.
19. Human Task list/detail and approve/reject through BFF.
20. TaskRun list/detail with links to Human Task, Audit and ToolCall.
21. AuditEvent list/detail through BFF.
22. ToolCall list/detail through BFF.
23. Frontend tests for API client, auth headers, error mapping, Registry page model and no legacy sample default rows.
24. Browser UI smoke script that validates Registry publish/rollback and UI Human Task approval.

## Runtime Compatibility

Executable Registry statuses remain:

```text
published
gray
```

The following statuses must not enter production execution:

```text
draft
validated
deprecated
disabled
```

runtime-api avoids DB production fallback to memory/default/sample routes. Non-matched DB routing does not start a default Agent workflow without an execution plan. tool-gateway avoids production fallback to built-in manifests when DB registry mode is configured.

Temporal workflow inputs use immutable `execution_plan_ref` values. The execution plan contains the FlowSpec snapshot plus exact Agent, Prompt and Tool version/hash references, so running workflows are not changed by later publish, gray, rollback, disable, deprecate or tool version changes.

Agent runtime inputs use immutable `agent_execution_plan_ref` values. `GenericAgentWorkflow` no longer constructs runtime agent metadata from loose `agent_id` fields; it delegates to `piDurableAgentWorkflow`.

control-plane does not execute tools and does not copy the Human Task state machine. UI operations go through control-plane API/BFF.

## Security Model

Header identity:

```text
x-user-id
x-tenant-id
x-roles
x-request-id
```

Roles:

- `platform_admin`
- `capability_operator`
- `auditor`

Production requires:

```text
CONTROL_PLANE_AUTH_MODE=header
```

`disabled` auth mode is allowed only in development/test. Production never silently uses a default administrator.

## Primary Docs

- `docs/15_registry_lifecycle.md`
- `docs/16_control_plane_api.md`
- `docs/17_control_plane_security.md`
- `docs/18_control_plane_ui.md`
- `docs/19_pi_segmented_agent_runtime.md`
- `apps/control-plane/docs/API.md`
- `apps/control-plane/docs/DEV_PLAN.md`
- `apps/control-plane/docs/DEV_SPEC.md`
- `docs/13_docker_deployment.md`

## Verification Commands

The expected final verification set is:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml build control-plane runtime-api runtime-worker tool-gateway
docker compose -f infra/docker-compose.yml up -d postgres valkey temporal temporal-ui
corepack pnpm db:migrate
corepack pnpm seed:examples
docker compose -f infra/docker-compose.yml up -d tool-gateway runtime-worker runtime-api control-plane
corepack pnpm smoke:temporal-db-e2e
corepack pnpm smoke:control-plane-api-e2e
corepack pnpm smoke:control-plane-ui-e2e
```

## Not Completed Yet

This stage intentionally does not implement:

1. Low-code flow canvas or drag-and-drop designer.
2. Live production model-gateway smoke with real credentials.
3. Real business system adapters.
4. Full workflow handoff child execution policy beyond fail-closed validation.
5. Enterprise SSO.
6. Random gray traffic splitting.
7. Any fifth production app or production container.

## Suggested Next Batch

1. Add full Pi smoke scripts for readonly tool, L3 resume, user input, handoff and restart recovery.
2. Improve UI ergonomics around AgentRun/AgentStep inspection and context refs.
3. Add evaluation/test-set operations for Route and Flow releases.
4. Add production identity integration behind the existing Header Auth boundary.
