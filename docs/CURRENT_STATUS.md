# Current Status

Last updated for CP-R3 + CP-R4: control-plane Registry API and single-container API/static runtime.

## Completed Before CP-R3 + CP-R4

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
14. Docker + PostgreSQL + Temporal smoke path: `smoke:temporal-db-e2e`.

## Completed In CP-R3 + CP-R4

1. Shared control-plane API contracts in `packages/contracts`.
2. Header authentication and minimal RBAC in `packages/security`.
3. control-plane Fastify server structure under `apps/control-plane/src/server`.
4. Standard control-plane error mapping to `StandardErrorResponse`.
5. OpenAPI generation at `/openapi.json` and optional Swagger UI at `/docs`.
6. Registry management API for Flow, Route, Tool, Agent, and Prompt.
7. Flow + Route atomic publish API: `POST /api/v1/releases/flow-route`.
8. Release list and release detail APIs.
9. Operations BFF:
   - Human Task list/detail/approve/reject through runtime-api;
   - TaskRun list/detail through runtime-api;
   - Audit and ToolCall query through tool-gateway.
10. runtime-api minimal Human Task and TaskRun query extensions.
11. tool-gateway minimal Audit and ToolCall query extensions.
12. Sensitive field masking for audit payload and tool call preview/result output.
13. control-plane production static hosting of Vite build output through Fastify.
14. control-plane Dockerfile switched from Nginx static image to Node/Fastify single container.
15. Docker Compose environment updated for control-plane DB, runtime-api, tool-gateway, auth, and port `3100`.
16. API E2E smoke script: `smoke:control-plane-api-e2e`.

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

runtime-api avoids DB production fallback to memory/default/sample routes. tool-gateway avoids production fallback to built-in manifests when DB registry mode is configured.

Temporal workflow inputs continue to use immutable `db://flow/{flow_id}/versions/{version}` refs, so running workflows are not changed by later publish, gray, rollback, disable, or deprecate operations.

control-plane does not execute tools and does not copy the Human Task state machine. It acts as Registry management API plus BFF for runtime-api and tool-gateway operations queries.

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

## Documentation

Primary current docs:

- `docs/15_registry_lifecycle.md`
- `docs/16_control_plane_api.md`
- `docs/17_control_plane_security.md`
- `apps/control-plane/docs/API.md`
- `apps/control-plane/docs/DEV_PLAN.md`
- `apps/control-plane/docs/DEV_SPEC.md`
- `docs/13_docker_deployment.md`

## Verification Status

Targeted checks already run during CP-R3 + CP-R4 implementation:

```bash
corepack pnpm --filter @dar/contracts test
corepack pnpm --filter @dar/security test
corepack pnpm --filter @dar/control-plane typecheck
corepack pnpm typecheck
corepack pnpm --filter @dar/control-plane test
corepack pnpm --filter @dar/runtime-api test
corepack pnpm --filter @dar/tool-gateway test
corepack pnpm test
```

Final full verification before handoff should include:

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
```

## Not Completed Yet

This stage intentionally does not implement:

1. Full React operations pages.
2. Low-code flow canvas.
3. Real Pi integration.
4. Real model calls.
5. Real business system adapters.
6. Enterprise SSO.
7. Any fifth production app.

## Suggested Next Batch

Implement the first real control-plane React Registry pages on top of the completed API:

1. Registry list/detail/version pages.
2. JSON editor for Flow, Route, Tool, Agent, and Prompt drafts.
3. Validate/publish/gray/rollback action panels.
4. Release history view.
5. Operations dashboard and Human Task queue UI.
