# Control Plane API

This document describes the implemented CP-R3 + CP-R4 backend API surface.

## Runtime Shape

`apps/control-plane` is still one production app. It now runs a Fastify server that provides:

- `/healthz`
- `/readyz`
- `/api/v1/*`
- `/openapi.json`
- optional `/docs`
- production static hosting for Vite output

No `control-plane-api` app or fifth production service is introduced.

## Registry Management

Shared contracts live in `packages/contracts` and are reused by handlers, tests, and OpenAPI schemas.

Resource paths:

```text
/api/v1/flows
/api/v1/routes
/api/v1/tools
/api/v1/agents
/api/v1/prompts
```

Lifecycle operations:

```text
list
create draft
list versions
get version
update draft
clone version
validate
publish
gray
deprecate
disable
rollback
release history
```

Important write constraints:

- `updateDraft` requires `expected_revision`.
- Revision conflict returns `409 REGISTRY_OPTIMISTIC_LOCK_CONFLICT`.
- `published`, `gray`, `deprecated`, and `disabled` versions cannot be updated in place.
- Publishing and rollback use `RegistryReleaseService`.
- Successful release actions append `capability_release` and `audit_event`.

Flow + Route joint publish:

```text
POST /api/v1/releases/flow-route
```

The service publishes both resources in one database transaction and rolls the entire transaction back if either validation or write fails.

## Release API

```text
GET /api/v1/releases
GET /api/v1/releases/:releaseId
```

Supported filters:

- `resource_type`
- `resource_id`
- `action`
- `operator_id`
- `start_time`
- `end_time`
- `page`
- `page_size`

Release history is append-only.

## Operations BFF

control-plane does not reimplement runtime state machines.

runtime-api-backed endpoints:

```text
GET  /api/v1/operations/human-tasks
GET  /api/v1/operations/human-tasks/:humanTaskId
POST /api/v1/operations/human-tasks/:humanTaskId/approve
POST /api/v1/operations/human-tasks/:humanTaskId/reject
GET  /api/v1/operations/task-runs
GET  /api/v1/operations/task-runs/:taskRunId
```

tool-gateway-backed endpoints:

```text
GET /api/v1/operations/audit-events
GET /api/v1/operations/tool-calls
GET /api/v1/operations/tool-calls/:toolCallId
```

Dashboard:

```text
GET /api/v1/operations/dashboard
```

Dashboard returns registry published counts, pending human task count, running / waiting_human / failed task counts, recent releases, and recent failed tasks.

## Downstream Extensions

runtime-api now has minimal operations query endpoints:

```text
GET  /v1/human-tasks
GET  /v1/human-tasks/:id
POST /v1/human-tasks/:id/approve
POST /v1/human-tasks/:id/reject
GET  /v1/tasks
GET  /v1/tasks/:taskRunId
```

tool-gateway now has:

```text
GET /v1/audit-events
GET /v1/tool-calls
GET /v1/tool-calls/:toolCallId
```

The gateway masks sensitive fields in audit payloads and tool call preview/result JSON before returning them.

## OpenAPI

Fastify Swagger generates the API schema:

```text
GET /openapi.json
GET /docs
```

Swagger UI can be disabled with:

```text
CONTROL_PLANE_SWAGGER_ENABLED=false
```

The schema is generated from route schemas that use shared `packages/contracts` Zod schemas.

## Smoke

Control-plane API smoke:

```bash
corepack pnpm smoke:control-plane-api-e2e
```

It verifies health, readyz, auth failures, RBAC failures, draft creation, validation, Flow + Route publish, release history, runtime-api route preview, v2 optimistic locking, published immutability, rollback, and BFF operations queries.
