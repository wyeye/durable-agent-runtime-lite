# AGENTS.md

## 1. Project Identity

**Project name:** Durable Agent Runtime Lite

This repository implements a compact, production-oriented Agent Runtime platform with a strict four-app architecture:

1. `control-plane`
2. `runtime-api`
3. `runtime-worker`
4. `tool-gateway`

The system provides:

- Config-driven preset workflow orchestration.
- Temporal-based durable execution.
- Pi-based bounded Agent Loop.
- Tool Gateway as the only tool invocation and side-effect boundary.
- Flow, Route, Tool, Agent, Prompt, Policy, Human Task and Audit management.
- Ability operation console for publishing, gray release, rollback, evaluation and runtime observation.
- Generic architecture without business-domain coupling.

This repository must remain a **generic runtime platform**. Do not introduce domain-specific business concepts unless the task explicitly requests it.

---

## 2. Architecture Principles

The intended runtime path is:

```text
User / Frontend / API / Webhook
  -> runtime-api
  -> Intent Router / Flow Router
  -> Temporal Workflow
  -> runtime-worker
  -> Pi Agent Loop, when needed
  -> tool-gateway
  -> External tools / APIs / MCP servers / Mock systems
```

Core rules:

- `runtime-api` is the only public runtime entry point.
- `runtime-worker` owns Temporal Workflow and Activity execution.
- Pi is a bounded Agent Loop, not the system controller.
- Pi must not directly call external business systems.
- All tool calls must go through `tool-gateway`.
- `tool-gateway` is the only external tool and side-effect boundary.
- Temporal Workflow code must remain deterministic.
- External calls, database calls, HTTP calls, LLM calls, Pi calls and tool calls must be implemented as Activities or service calls outside deterministic Workflow logic.
- FlowSpec version must be locked when a workflow starts.
- Running workflow instances must not be affected by newer FlowSpec versions.
- Medium-risk and high-risk side-effect actions must support preview, human confirmation, idempotency and audit.

Internationalization rules:

- First-version locale support is `zh-CN` only; do not add empty `en-US` resource files or a language switcher until real English copy is implemented.
- Keep machine fields stable and untranslated: error codes, event codes, event types, status enums, resource types, API paths, JSON field names, ids, hashes, model ids, tool names and provider ids.
- Localize only display text such as API `message`, UI labels, status labels, safe error explanations, log messages, audit display messages, OpenAPI descriptions, validation messages and health/readiness descriptions.
- API responses use request `Accept-Language` and set `Content-Language` plus `Vary: Accept-Language`; unsupported languages fall back to `zh-CN`.
- Runtime logs use deployment-level `LOG_LOCALE`, not per-request locale.
- Audit facts must remain `event_type`, `message_key` and `message_params`; `display_message` is a render result, not the source of truth.
- Locale must not affect Workflow branching, policy decisions, idempotency keys, hashes, signatures or authorization.

---

## 3. Production Apps

### 3.1 `apps/control-plane`

**Purpose:** Ability operation console and control plane.

Responsibilities:

- FlowSpec management.
- RouteSpec management.
- ToolManifest management.
- AgentSpec management.
- Prompt management.
- Model Gateway Profile and Model Definition management.
- Policy configuration.
- Publish, gray release, rollback and disable operations.
- Route examples and negative examples management.
- Human task console.
- Audit query UI.
- Runtime dashboard and evaluation views.
- Read-only Tenant Policy Snapshot and Tenant Agent Admission operations views.

Default stack:

- React 19.
- Vite.
- Ant Design.
- TypeScript.
- Shared contracts from `packages/contracts`.

Rules:

- Do not implement runtime execution logic here.
- Do not call tools directly from the frontend.
- Do not expose, echo, log, or render model API keys or encrypted credential fields; model gateway API keys are write-only inputs.
- Do not duplicate schemas in the frontend; import or generate from shared contracts.
- Writable Registry and Evaluation configuration uses visual forms; JSON views are read-only only.
- ModelPolicy editing uses exact published ModelDefinition selection and must not reintroduce raw `gateway_profile` / `model_id` manual target entry.
- Flow editing uses the visual sequence builder for the existing ordered `steps` array semantics; do not introduce arbitrary DAG semantics unless explicitly requested.
- Tenant Policy Snapshot and Tenant Agent Admission are runtime operations resources, not editable Registry resources; control-plane may read them but must not create, update or delete them.

---

### 3.2 `apps/runtime-api`

**Purpose:** Unified runtime entry, session layer, intent routing and workflow starter.

Responsibilities:

- Public API entry.
- Tenant, user and request context normalization.
- Authentication and authorization placeholders.
- Session handling.
- Intent Router.
- Flow Router.
- Rule-based route matching.
- Vector recall integration placeholder.
- Pi or LLM Top-K classification adapter placeholder.
- Workflow starter through Temporal Client.
- Task creation and status query.
- Streaming response placeholder.

Default stack:

- Node.js 24 LTS.
- TypeScript 5.x.
- Fastify 5.x.
- Zod 4.
- OpenAPI 3.1.
- Temporal Client.
- PostgreSQL 17 and pgvector through shared DB package.
- Valkey where needed.

Rules:

- Do not call external business systems from `runtime-api`.
- Do not execute tools directly.
- Do not run Pi directly here.
- Only start workflows or return route previews.
- Route results must be explicit and auditable.
- Low-confidence routing must return clarification, fallback to GenericAgentWorkflow or escalate according to policy.

---

### 3.3 `apps/runtime-worker`

**Purpose:** Durable execution layer with Temporal Worker, Activity Worker and Pi Runner wrapper.

Responsibilities:

- Temporal Worker bootstrap.
- Temporal Workflow definitions.
- Temporal Activity implementations.
- `ConfigDrivenWorkflow`.
- `GenericAgentWorkflow`.
- Human task wait and Signal handling.
- FlowSpec snapshot loading through Activity.
- Tool invocation through Tool Gateway client.
- Pi Runner wrapper.
- Model Gateway adapter placeholder.
- DB-backed Model Gateway Profile / Model Definition resolution and credential decryption outside deterministic Workflow code.
- Workflow tests.

Default stack:

- Node.js 24 LTS.
- TypeScript 5.x.
- Temporal TypeScript SDK.
- Pi Agent Loop.
- Zod 4.
- OpenTelemetry.
- Pino.

Temporal rules:

- Workflow code must be deterministic.
- Do not call databases, HTTP APIs, LLMs, Pi, random functions or current time directly in Workflow code.
- Put external calls in Activities.
- Use deterministic timers and Temporal APIs.
- Use stable Workflow inputs and immutable FlowSpec versions.
- Use idempotency keys for side-effect Activities.
- Keep large documents, long prompts, large tool results and attachments outside Temporal history; store references instead.

Pi rules:

- Pi can plan, summarize, classify, generate text and propose tool calls.
- Pi must not directly call external systems.
- Pi must not receive Tool Gateway, DB, Temporal Client, filesystem, shell, MCP or business API capabilities.
- Pi Deferred Tools may only emit proposals; real tool invocation must be mediated by Workflow -> Activity -> Tool Gateway.
- Pi should return structured results.
- In mediated mode, Pi returns proposed tool calls; Workflow and Tool Gateway decide whether to execute them.
- Pi output statuses should be limited to known states such as `final`, `need_tool`, `need_user`, `handoff_to_workflow` and `failed`.
- `PI_AGENT_MODE=deterministic` is development/test only; production must use `PI_AGENT_MODE=model_gateway`.
- In `model_gateway` mode, runtime-worker must use ModelDefinition and ModelGatewayProfile data as the model-call source of truth; production model calls must not fall back to deployment-level `MODEL_GATEWAY_BASE_URL`, `MODEL_GATEWAY_API_KEY`, `MODEL_GATEWAY_MODEL`, or default/latest models.
- Model gateway credentials must never be exposed to Pi, Workflow code, runtime-api, tool-gateway, frontend, logs, audit payloads, traces, or Temporal history.
- `handoff_to_workflow` may only start an allowed exact `FlowExecutionPlan` child workflow.

---

### 3.4 `apps/tool-gateway`

**Purpose:** Single tool invocation gateway and side-effect safety boundary.

Responsibilities:

- Tool registry read APIs.
- Tool invocation APIs.
- Tool input and output schema validation.
- Permission and policy checks.
- Risk level handling.
- Human confirmation decision support.
- Idempotency.
- Rate limiting placeholder.
- Audit log.
- Tool adapters.
- HTTP, MCP and mock adapter abstraction.

Default stack:

- Node.js 24 LTS.
- TypeScript 5.x.
- Fastify 5.x.
- Zod 4.
- PostgreSQL 17.
- Valkey.
- Kysely.
- OpenTelemetry.
- Pino.

Rules:

- All tool invocations must pass through `tool-gateway`.
- Every tool call must include tenant context, user context, task context, tool name, tool version, arguments, idempotency key and risk metadata.
- Validate all tool arguments against registered schema before invoking adapters.
- Apply policy before invocation.
- Write audit logs for allowed, denied, failed and idempotent replayed calls.
- Never expose adapter secrets to Pi, runtime-api or frontend.
- Do not add domain-specific tool logic directly into generic gateway core; use adapters.

Long-term note:

- `tool-gateway` may be replaced by Go or Java in a later phase if throughput, enterprise integration or security isolation requirements increase. For the MVP, keep it in Node.js to share contracts and speed up delivery.

---

## 4. Non-Production App

### `devtools/mock-server`

**Purpose:** Local development and integration testing only.

Responsibilities:

- Mock external business systems.
- Mock tools.
- Mock MCP-like endpoints.
- Provide deterministic test responses.

Rules:

- Do not treat this as a production app.
- Do not put production logic here.
- Do not let production services depend on mock-only behavior.

---

## 5. Shared Packages

Use shared packages under `packages/`:

```text
packages/
  contracts/
  config/
  db/
  logger/
  telemetry/
  security/
  temporal/
```

### 5.1 `packages/contracts`

Must contain shared DTOs, schemas, enums and API contracts:

- `FlowSpec`.
- `RouteSpec`.
- `AgentSpec`.
- `ToolManifest`.
- `TaskRun`.
- `RouteResult`.
- `ToolInvokeRequest`.
- `ToolInvokeResponse`.
- `HumanTask`.
- `AuditEvent`.
- `RuntimeError`.
- Common enums and status codes.

Rules:

- Use Zod for external input schemas.
- Export TypeScript types from Zod schemas.
- Do not duplicate DTOs inside apps.
- API contracts must be versioned when changed incompatibly.

### 5.2 `packages/config`

Responsibilities:

- Environment loading.
- Typed configuration.
- Shared config validation.

Rules:

- Do not access raw `process.env` throughout apps except inside this package or app bootstrap.
- Validate required environment variables.
- Never commit real secrets.

### 5.3 `packages/db`

Responsibilities:

- Kysely database client.
- Database type definitions.
- Migration helpers.
- Transaction helpers.

Rules:

- Database schemas must be changed through migrations under `db/migrations`.
- Do not make ad hoc schema changes.
- Keep vector index tables separate from main FlowSpec tables.

### 5.4 `packages/logger`

Responsibilities:

- Shared structured logger.
- Request context log bindings.
- Standard log fields.

Required log fields when available:

- `request_id`.
- `tenant_id`.
- `user_id`.
- `task_run_id`.
- `workflow_id`.
- `flow_id`.
- `flow_version`.
- `tool_name`.

### 5.5 `packages/telemetry`

Responsibilities:

- OpenTelemetry bootstrap.
- Trace propagation helpers.
- Common span attributes.
- Metrics naming conventions.

### 5.6 `packages/security`

Responsibilities:

- Auth context parsing.
- Permission placeholder.
- Policy helper types.
- Sensitive data masking helpers.

### 5.7 `packages/temporal`

Responsibilities:

- Shared Temporal client creation.
- Task queue names.
- Workflow IDs and idempotency key helpers.
- Temporal-related shared types.

---

## 6. Technology Baseline

Use the documented v1.5 technical baseline unless a task explicitly says otherwise:

- Node.js 24 LTS.
- TypeScript 5.x.
- pnpm workspace.
- Turborepo.
- Fastify 5.x.
- React 19.
- Vite.
- Ant Design.
- Zod 4.
- OpenAPI 3.1.
- PostgreSQL 17.
- pgvector.
- Kysely.
- Valkey 8.x.
- Temporal TypeScript SDK.
- Pi Agent Loop.
- OpenTelemetry.
- Pino.
- Vitest.
- Playwright.

Do not introduce a new framework, ORM, package manager, testing framework or language runtime unless explicitly requested.

---

## 7. Repository Layout

Expected structure:

```text
durable-agent-runtime-lite/
  apps/
    control-plane/
    runtime-api/
    runtime-worker/
    tool-gateway/
  packages/
    contracts/
    config/
    db/
    logger/
    telemetry/
    security/
    temporal/
  db/
    migrations/
    seeds/
  examples/
    flows/
    agents/
    tools/
    prompts/
    router-tests/
  infra/
    docker-compose.yml
  devtools/
    mock-server/
  tests/
    e2e/
    contract/
  scripts/
  docs/
  AGENTS.md
  README.md
  package.json
  pnpm-workspace.yaml
  turbo.json
  tsconfig.base.json
```

Rules:

- Keep each app focused on its responsibility.
- Put shared schemas and helpers in packages.
- Avoid circular dependencies between packages.
- Apps may depend on packages; packages must not depend on apps.
- Do not create additional production apps without explicit approval.

---

## 8. Development Commands

Use these commands when available:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

For local infrastructure:

```bash
docker compose -f infra/docker-compose.yml up -d
```

Before completing a task, run relevant checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

If a command fails because the repository is not fully initialized yet, either fix the missing script or explain clearly why it cannot run.

---

## 9. Coding Standards

General rules:

- Use TypeScript strict mode.
- Prefer explicit public API types.
- Validate external inputs with Zod.
- Use structured JSON logs.
- Use consistent error shapes from `packages/contracts`.
- Do not swallow errors silently.
- Do not expose internal stack traces through public APIs.
- Do not store secrets in code.
- Do not hardcode tenant-specific or user-specific values.
- Do not introduce business-domain coupling into generic runtime code.
- Prefer small modules and explicit boundaries.
- Add tests for new logic.
- Keep implementation aligned with docs.

Naming rules:

- Use `camelCase` for variables and functions.
- Use `PascalCase` for classes, types and interfaces.
- Use `UPPER_SNAKE_CASE` for environment variable names.
- Use kebab-case for file and directory names unless framework convention says otherwise.

Error handling rules:

- All public API errors must use the standard error response contract.
- Include a stable error code.
- Include safe, user-readable messages.
- Do not include secrets, tokens, stack traces or raw adapter responses in public error payloads.

---

## 10. API Standards

Each production app must expose:

- `GET /healthz`.
- `GET /readyz`.
- Metrics or OpenTelemetry-ready instrumentation.

Public APIs must have:

- Request schema.
- Response schema.
- Standard error schema.
- OpenAPI documentation or a path to generate it.

Common request metadata should include where applicable:

- `request_id`.
- `tenant_id`.
- `user_id`.
- `session_id`.
- `task_run_id`.
- `workflow_id`.

Do not expose internal implementation details such as adapter stack traces, database error strings or raw model provider payloads.

---

## 11. Data and Migration Standards

Core tables should include, at minimum:

- `flow_definition`.
- `flow_route_config`.
- `flow_route_embedding`.
- `agent_spec`.
- `tool_manifest`.
- `prompt_definition`.
- `task_run`.
- `human_task`.
- `audit_event`.
- `idempotency_record`.

Rules:

- Use migrations for all schema changes.
- Migrations must be deterministic and reviewable.
- Do not modify old migrations after they are applied; create new migrations.
- Keep seed data separate from migrations.
- Store immutable published specs by version and hash.
- Do not mutate already published FlowSpec versions in place.

---

## 12. Flow, Route and Publish Rules

FlowSpec rules:

- FlowSpec must be versioned.
- Published FlowSpec versions are immutable.
- FlowSpec must include input schema, output schema and step definitions.
- Step types should be constrained to approved types such as `activity`, `tool`, `agent`, `human_task` and `condition`.
- High-risk steps must be marked and routed through confirmation or policy.

RouteSpec rules:

- Route configuration must include examples, negative examples, keywords, supported channels, role constraints, priority and thresholds where applicable.
- Router should use a hybrid approach:
  - rule match;
  - vector recall;
  - Top-K LLM or Pi classification;
  - policy fallback.
- Low-confidence route decisions must not silently execute high-risk flows.

Publish rules:

- Publish must validate FlowSpec, RouteSpec, ToolManifest dependencies, AgentSpec dependencies and Prompt dependencies.
- Publish should emit a publish event.
- Runtime routing should load the latest eligible published or gray version.
- Rollback should switch routing version pointers; running workflows remain version-locked.

---

## 13. Tool Invocation Rules

Every tool invocation must include:

- `tenant_id`.
- `user_id`.
- `task_run_id`.
- `workflow_id`, when available.
- `tool_name`.
- `tool_version`.
- `arguments`.
- `idempotency_key`.
- `risk_level`.
- `request_id`.

Tool invocation lifecycle:

```text
validate request
  -> load ToolManifest
  -> validate arguments schema
  -> check policy
  -> check idempotency
  -> invoke adapter
  -> validate output schema when configured
  -> write audit event
  -> return normalized response
```

Rules:

- Unknown tools must return a standard error.
- Schema validation failures must return a standard error.
- Denied policy decisions must be audited.
- Repeated idempotency keys must return the original recorded result or a safe conflict response.
- Tool outputs must be normalized and safe for downstream use.

---

## 14. Human Task Rules

Human tasks are required for:

- Medium-risk side-effect actions when policy says confirmation is required.
- High-risk actions unless explicitly configured otherwise.
- Low-confidence or ambiguous route decisions requiring user clarification.
- Agent requests for missing information.
- Exception handling and manual takeover.

Human task records must include:

- `human_task_id`.
- `tenant_id`.
- `task_run_id`.
- `workflow_id`.
- `status`.
- `assignee` or candidate groups when available.
- `payload`.
- `created_at`.
- `completed_at`.
- `decision`.

---

## 15. Observability and Audit Rules

Logging:

- Use structured JSON logs.
- Include trace and request context where available.
- Avoid logging sensitive data.
- Mask tokens, credentials and personal data where applicable.

Tracing:

- Use OpenTelemetry conventions where possible.
- Create spans for route decision, workflow start, activity execution, Pi call, model call, tool invocation and policy decision.

Audit:

- Audit must be append-only.
- Audit tool invocations, route decisions, publish actions, human approvals, policy denials, workflow failures and rollback actions.
- Audit events should include actor, action, target, result, reason and timestamp.

---

## 16. Testing Standards

Use this testing pyramid:

- Unit tests for pure functions and schema validation.
- Integration tests for API and DB interactions.
- Contract tests for shared DTOs and API schemas.
- Temporal workflow tests for workflow behavior.
- Tool Gateway tests for policy, idempotency and audit.
- E2E smoke tests for route -> workflow -> tool invocation path.
- Frontend component tests for key control-plane pages.
- Playwright smoke tests for core console flows when available.

Minimum expectations for new features:

- Happy path.
- Validation failure.
- Permission or policy denial where applicable.
- Idempotency behavior where applicable.
- Audit event creation where applicable.
- Typecheck coverage.

Do not mark a task as complete if tests are missing and no clear explanation is provided.

---

## 17. Security Rules

- Do not commit secrets.
- Do not hardcode tokens, API keys or model credentials.
- Use environment variables and secret management placeholders.
- Do not log secrets.
- Mask sensitive fields in logs and audit where appropriate.
- Apply tenant isolation to runtime requests, registry queries and tool invocations.
- Do not allow Pi, prompts or user input to bypass policy checks.
- Treat tool adapters as privileged code paths.
- Validate all external inputs.

---

## 18. Dependency Rules

- Use pnpm workspace.
- Prefer workspace packages for shared code.
- Do not introduce duplicate libraries for the same purpose.
- Do not add heavy dependencies without justification.
- Do not switch framework choices without approval.
- Keep dependency changes small and explain why they are needed.

---


## 19. Docker Deployment Rules

The project is expected to be deployed with Docker. Every production app must be buildable and runnable as a container image.

Production apps requiring Docker support:

```text
apps/control-plane
apps/runtime-api
apps/runtime-worker
apps/tool-gateway
```

`devtools/mock-server` may have a development-only Docker image, but it must not be treated as a production service.

### 19.1 Required Docker Files

Use **multiple app-specific Dockerfiles**. Each production app owns its Dockerfile so that build context, exposed port, healthcheck and runtime entrypoint are explicit.

Required files:

```text
apps/control-plane/Dockerfile          # static console image, normally Nginx/unprivileged
apps/runtime-api/Dockerfile            # runtime API image
apps/runtime-worker/Dockerfile         # Temporal worker image
apps/tool-gateway/Dockerfile           # tool gateway image
.dockerignore                          # required for all Docker builds
infra/docker-compose.yml               # local integrated runtime, including dependencies
scripts/docker-build-all.sh            # builds all production app images
scripts/docker-run-local.sh            # starts local Docker stack
docs/13_docker_deployment.md           # Docker deployment notes
```

### 19.0.1 AR-2A Ollama Container Gate

The local Ollama release gate is a manual validation path, not a fifth production app.

Rules:

- Ollama runs on the host machine only.
- The exact model is `qwen2.5:7b-instruct-q4_K_M`.
- The four production apps must run from Docker images.
- `runtime-worker` must use `PI_AGENT_MODE=model_gateway`, `MODEL_GATEWAY_PROFILE_ID=local-ollama`, and `MODEL_GATEWAY_BASE_URL=http://host.docker.internal:11434/v1`.
- `mock-server` must not run for the Ollama gate.
- deterministic Pi must not be used for the Ollama gate.
- Container acceptance must prove `/version` build metadata and DB model-call evidence, not merely a non-crashing flow.
- Ordinary GitHub hosted CI must not download or run the 7B Ollama model; use `.github/workflows/ollama-runtime.yml` on `[self-hosted, ollama]`.

Build context rule:

- All Docker builds must use the **repository root** as the Docker build context.
- Do not use `apps/<app>` as the build context, because app images need access to workspace packages, lockfiles and shared configs.

Expected build pattern:

```bash
docker build \
  -f apps/runtime-api/Dockerfile \
  -t durable-agent-runtime/runtime-api:local \
  .
```

Per-app Dockerfiles may share the same build pattern, base images and comments, but they must remain separate files. This makes it easier for Codex and reviewers to reason about each app image independently.

### 19.2 Docker Build Rules

- Use multi-stage builds.
- Use the documented Node.js baseline from the technology stack document.
- Use `corepack` and `pnpm`; do not switch to npm or yarn.
- Use `pnpm install --frozen-lockfile` inside Docker builds.
- Prefer Turborepo filter/deploy or an equivalent workspace-pruning approach for smaller images.
- Do not copy local `node_modules` into images.
- Do not bake `.env`, tokens, model keys, database passwords or other secrets into images.
- Do not use `latest` tags for production images.
- Run runtime containers as a non-root user or use an unprivileged base image.
- Keep final runtime images as small as practical.
- Add a Docker healthcheck using `/healthz` where possible.
- Backend production apps must expose `HOST` and `PORT` environment variables.
- Backend production apps must bind to `0.0.0.0` inside the container.
- Backend production apps must support graceful shutdown on `SIGTERM`.
- `control-plane` may be served as static files by an unprivileged Nginx image. In that case, document its internal port and provide `/healthz`, `/readyz` and SPA fallback.

### 19.3 Required App Scripts

Each production app package should provide these scripts:

```json
{
  "scripts": {
    "dev": "...",
    "build": "...",
    "start": "node dist/index.js",
    "typecheck": "...",
    "test": "...",
    "lint": "..."
  }
}
```

For backend apps, the Docker runtime command should normally use the production entrypoint:

```bash
node dist/index.js
```

For `control-plane`, the Docker runtime may be a static web server. If so, document it in `apps/control-plane/README.md` and keep Docker Compose port mapping explicit.

### 19.4 Docker Compose Rules

The local Docker Compose stack should include:

- `control-plane`
- `runtime-api`
- `runtime-worker`
- `tool-gateway`
- PostgreSQL with pgvector support
- Valkey
- Temporal Server
- Temporal UI, if useful for local development

The local Docker Compose stack may include `devtools/mock-server`, but it must be clearly marked as development-only.

Expected local command:

```bash
docker compose -f infra/docker-compose.yml up --build
```

Expected image build command:

```bash
scripts/docker-build-all.sh
```

### 19.5 Container Configuration Rules

Configuration must come from environment variables. Required variables should be documented in `.env.example`.

Common variables:

```text
NODE_ENV
HOST
PORT
DATABASE_URL
VALKEY_URL
TEMPORAL_ADDRESS
TEMPORAL_NAMESPACE
TOOL_GATEWAY_URL
RUNTIME_API_URL
MODEL_GATEWAY_URL
LOG_LEVEL
OTEL_EXPORTER_OTLP_ENDPOINT
```

Do not introduce environment variables without updating `.env.example` and the relevant app documentation.

### 19.6 Docker Definition of Done

For any task that changes runtime startup, app scripts, dependencies or deployment behavior, the task is not complete until:

- The affected app image builds successfully.
- The container starts successfully.
- `/healthz` returns success.
- `/readyz` returns success or a clearly documented not-ready state.
- Logs are written to stdout/stderr as structured logs.
- No secrets are copied into the image.
- The Dockerfile and compose files remain aligned with the four-app architecture.
- The app-specific Dockerfile is updated when that app's runtime entrypoint, build output or package name changes.

### 19.7 Docker Do-Not List

Do not:

- Add a production Docker image for an unapproved fifth app.
- Add business systems directly to the production runtime image.
- Use Docker containers to bypass `tool-gateway`.
- Use bind-mounted local source code in production compose files.
- Run production containers as root unless explicitly approved.
- Store secrets in Dockerfile, docker-compose.yml or committed `.env` files.
- Change the Node.js major version in Docker without updating the technology stack document.
- Build images from `apps/<app>` context if shared workspace packages are needed.

---

## 20. Pull Request Expectations

Each task should produce a small, reviewable diff.

Before finishing, summarize:

1. Files changed.
2. Main behavior added.
3. Commands run.
4. Tests added or updated.
5. Remaining TODOs.
6. Risks or design tradeoffs.

Do not make broad refactors unless explicitly requested.

---

## 21. Definition of Done

A task is done only when:

- Code compiles.
- Relevant tests pass.
- Lint and typecheck pass, or failures are explicitly explained.
- Docs are updated if behavior changed.
- Public API schemas are updated if APIs changed.
- No hardcoded secrets are added.
- New runtime behavior is logged and auditable.
- The result follows the four-app architecture.
- The task does not introduce unapproved production services.
- Docker-related changes build and run successfully when the task affects deployment.

---

## 22. Strict Do-Not List

Do not:

- Add a fifth production app without explicit approval.
- Bypass `tool-gateway` for tool invocation.
- Let Pi directly access external business systems.
- Put non-deterministic code in Temporal Workflows.
- Duplicate shared contracts inside apps.
- Introduce domain-specific business logic into the generic runtime.
- Store secrets in code.
- Make broad unrelated refactors.
- Change the technology stack without explicit approval.
- Implement a complex visual workflow designer unless requested.
- Treat `devtools/mock-server` as a production component.

---

## 23. Recommended First Development Order

When starting from a skeleton repository, implement in this order:

1. Monorepo baseline and health endpoints.
2. Shared contracts in `packages/contracts`.
3. Database migrations and `packages/db`.
4. `tool-gateway` first-stage APIs.
5. `runtime-api` first-stage Intent Router and Workflow Starter.
6. `runtime-worker` first-stage `ConfigDrivenWorkflow`.
7. Pi Runner adapter.
8. Human task flow.
9. Control-plane first-stage pages.
10. Docker build and local compose smoke test.
11. E2E smoke path.

Do not attempt to implement the whole system in one change.
