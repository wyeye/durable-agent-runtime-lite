# Docker Deployment - Multiple Dockerfiles

## Strategy

Use one Dockerfile per production app:

```text
apps/control-plane/Dockerfile
apps/runtime-api/Dockerfile
apps/runtime-worker/Dockerfile
apps/tool-gateway/Dockerfile
```

All builds must use the repository root as the build context:

```bash
docker build -f apps/runtime-api/Dockerfile -t durable-agent-runtime/runtime-api:local .
```

This keeps each image explicit while preserving access to `packages/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, and shared TypeScript configs.

## Local build

```bash
scripts/docker-build-all.sh
```

## Local run

```bash
docker compose -f infra/docker-compose.yml up --build
```

## Ports

| Service | Container port | Host port |
|---|---:|---:|
| control-plane | 3100 | 3100 |
| runtime-api | 3000 | 3000 |
| tool-gateway | 3200 | 3200 |
| runtime-worker | 3300 | 3300 |
| Temporal | 7233 | 7233 |
| Temporal UI | 8080 | 8233 |
| PostgreSQL | 5432 | 15432 |
| Valkey | 6379 | 16380 |

## Real Temporal DB smoke

The integrated Docker Compose smoke path uses the four production apps plus PostgreSQL, Valkey, Temporal, and Temporal UI. It does not add another production service.

```bash
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml build runtime-api runtime-worker tool-gateway control-plane
docker compose -f infra/docker-compose.yml up -d postgres valkey temporal temporal-ui
corepack pnpm db:migrate
corepack pnpm seed:examples
docker compose -f infra/docker-compose.yml up -d tool-gateway runtime-worker runtime-api control-plane
corepack pnpm smoke:temporal-db-e2e
corepack pnpm smoke:control-plane-api-e2e
corepack pnpm smoke:control-plane-ui-e2e
```

Host-side DB initialization can also use:

```bash
./scripts/docker-db-migrate.sh
./scripts/docker-seed-examples.sh
```

The compose file intentionally sets:

```text
RUNTIME_API_ROUTE_SOURCE=db
RUNTIME_API_WORKFLOW_STARTER=temporal
RUNTIME_API_AUTH_MODE=header
RUNTIME_WORKER_MODE=temporal
TOOL_GATEWAY_REGISTRY_SOURCE=db
TOOL_GATEWAY_AUTH_MODE=service_token
TOOL_GATEWAY_URL=http://tool-gateway:3200
CONTROL_PLANE_AUTH_MODE=header
RUNTIME_API_URL=http://runtime-api:3000
TOOL_GATEWAY_URL=http://tool-gateway:3200
```

Production-like Docker paths must not use memory sources, `defaultRouteSpecs`, `sample_flow@1`, or memory tool registry. `runtime-api` only starts Temporal workflows; tool invocation happens in `runtime-worker` activities through `tool-gateway`.

Local compose sets dev-only service-token placeholders for the `runtime-worker -> tool-gateway` and `control-plane -> tool-gateway` calls. Real deployments must inject `TOOL_GATEWAY_RUNTIME_WORKER_TOKEN`, `TOOL_GATEWAY_CONTROL_PLANE_TOKEN`, `RUNTIME_WORKER_TOOL_GATEWAY_TOKEN`, and `CONTROL_PLANE_TOOL_GATEWAY_TOKEN` through environment or secret management.

Successful smoke output includes `ok: true`, a `task_run_id`, a `workflow_id`, `completed` task status, approved `human_task`, committed `tool_call_log`, DB audit events for `knowledge.search`, `tool.preview`, `human_task.approve`, `tool.commit`, and DB idempotency records for tool invoke/commit.

The seeded flow uses L3 governance for `record.write.mock`:

```text
input.normalize
  -> knowledge.search invoke
  -> agent.plan
  -> record.write.mock preview
  -> human_task approve/reject through runtime-api
  -> record.write.mock commit
```

Risk policy summary:

- L0/L1 can be invoked directly.
- L2 can preview; commit behavior depends on policy.
- L3 cannot directly invoke side effects; preview writes `tool_call_log=pending_confirmation`, approve/reject writes `human_task` and audit, commit writes `tool_call_log=committed` and `idempotency_record`.
- L4 is denied by default and audited.

## Pi Runtime Smoke Override

`infra/docker-compose.pi-smoke.yml` is a development/test override. It adds only
the dev-only `mock-server` and changes runtime-worker Pi settings for smoke
tests. It does not add a fifth production app and is not required by production
compose.

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml up -d mock-server tool-gateway runtime-worker runtime-api control-plane
```

The override sets:

```text
PI_AGENT_MODE=deterministic by default
APP_ENV=development
MODEL_GATEWAY_BASE_URL=http://mock-server:4100
PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW=2
```

Smoke commands:

```bash
corepack pnpm smoke:pi-readonly-e2e
corepack pnpm smoke:pi-l3-e2e
corepack pnpm smoke:pi-user-input-e2e
corepack pnpm smoke:pi-handoff-e2e
corepack pnpm smoke:pi-restart-resume-e2e
corepack pnpm smoke:pi-worker-crash-resume-e2e
corepack pnpm smoke:pi-model-gateway-e2e
```

The model-gateway smoke uses `PI_SMOKE_MODE=model_gateway` and
`devtools/mock-server /v1/generate` to return structured tool-call blocks. The
other Pi smokes use deterministic Pi-compatible streams, but still exercise real
Pi Agent Core, Temporal workflow supervision, Tool Gateway, DB state, Human Task
signals, and context snapshot recovery.

`smoke:pi-worker-crash-resume-e2e` is the real crash recovery gate. It kills the
compose `runtime-worker` service with `SIGKILL`, verifies `/readyz` is no longer
available, sends waiting-user and L3 approval signals through `runtime-api`
while the worker is down, restarts `runtime-worker`, and verifies the original
Temporal workflow resumes without duplicate Human Tasks, AgentSteps, audit
events, or Tool Gateway commit idempotency records.

For replay fixture export, write the crash smoke result to a file and export
Temporal histories from the actual workflow IDs:

```bash
PI_CRASH_RESULT_FILE=artifacts/pi-worker-crash-resume/result.json \
  corepack pnpm smoke:pi-worker-crash-resume-e2e
TEMPORAL_REPLAY_SMOKE_RESULT_FILE=artifacts/pi-worker-crash-resume/result.json \
  corepack pnpm temporal:export-replay-fixtures
corepack pnpm test:temporal-replay
```

## Control-plane single container

`apps/control-plane/Dockerfile` now builds both:

- Fastify server output under `apps/control-plane/dist/server`
- Vite frontend output under `apps/control-plane/dist/public`

The final image uses a Node.js runtime, not Nginx. Fastify serves:

- `/healthz`
- `/readyz`
- `/api/*`
- `/openapi.json`
- optional `/docs`
- SPA fallback to `index.html` for non-API frontend routes

Required runtime environment:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=3100
DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
RUNTIME_API_URL=http://runtime-api:3000
TOOL_GATEWAY_URL=http://tool-gateway:3200
CONTROL_PLANE_AUTH_MODE=header
CONTROL_PLANE_TOOL_GATEWAY_TOKEN=<secret>
CONTROL_PLANE_SWAGGER_ENABLED=true
```

`/api/*`, `/healthz`, `/readyz`, `/openapi.json`, and `/docs` are excluded from SPA fallback.

## Control-plane API smoke

After the integrated stack is running:

```bash
corepack pnpm smoke:control-plane-api-e2e
```

The smoke checks:

- healthz and readyz;
- missing identity returns 401;
- auditor write returns 403;
- capability operator creates Prompt, Tool, Agent, Flow, and Route drafts;
- validation and Flow + Route joint publish;
- release history;
- runtime-api router preview sees the newly published Route;
- v2 optimistic locking conflict;
- published v1 immutable update conflict;
- v2 publish and rollback to v1;
- BFF Human Task, Audit, and ToolCall query endpoints.

## Control-plane UI smoke

After the same integrated stack is running:

```bash
corepack pnpm smoke:control-plane-ui-e2e
```

The UI smoke uses Playwright from `apps/control-plane` and opens `http://localhost:3100` by default. It verifies:

- the Fastify-served React app opens;
- development identity can be set in the Identity Panel;
- Registry pages render data from `/api/v1`, not embedded sample rows;
- Prompt, Tool, Agent, Flow and Route drafts can be created and published through control-plane API in a browser context;
- runtime-api router preview sees the newly published Route;
- v2 publish and rollback return new requests to v1;
- Human Task page can approve a pending L3 task through the BFF;
- TaskRun, Audit and ToolCall pages are reachable.

If browser dependencies are missing:

```bash
corepack pnpm --filter @dar/control-plane exec playwright install chromium
```

If smoke fails, inspect:

1. `docker compose -f infra/docker-compose.yml logs runtime-api runtime-worker tool-gateway temporal`
2. whether `corepack pnpm db:migrate` applied all migrations;
3. whether `corepack pnpm seed:examples` inserted the sample FlowSpec, RouteSpec, and ToolManifest rows;
4. whether runtime-api and worker use the same Temporal task queue, `runtime-worker-main`;
5. whether worker uses `TOOL_GATEWAY_URL=http://tool-gateway:3200` inside Docker;
6. whether `/v1/human-tasks?tenant_id=default&user_id=smoke_user&task_run_id=<id>&status=pending` returns a task if workflow is waiting;
7. whether `tool_call_log` has a `pending_confirmation`, `approved`, `rejected`, or `committed` L3 record;
8. whether `task_run.error_code` / `task_run.error_message` explains a workflow failure.
9. for Pi smoke, whether `mock-server` is running when `PI_AGENT_MODE=model_gateway`;
10. whether `agent_step.authoritative_tool_result_refs_json` or `handoff_refs_json` explains a boundary failure.

## Notes for Codex

When modifying Docker support:

1. Do not replace app-specific Dockerfiles with a single root Dockerfile.
2. Keep the root build context.
3. Do not introduce a fifth production image.
4. Do not place secrets in Dockerfiles or compose files.
5. Update `.env.example` and app docs when new environment variables are introduced.
6. Validate `/healthz` and `/readyz` after changing startup behavior.
