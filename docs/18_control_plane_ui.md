# Control-plane UI

## Overview

CP-R5 + CP-R6 adds the first complete React ability operations console for `control-plane`. The UI is served by the same Fastify process that serves the management API, so production still has one `control-plane` app and one container.

The UI is intentionally operations-focused. It does not implement a low-code canvas, drag-and-drop designer, real Pi, real model calls, real business adapters, or enterprise SSO.

## Pages

| Route | Purpose |
|---|---|
| `/dashboard` | Published Registry counts, pending Human Tasks, running/waiting/failed TaskRuns, recent releases, recent Audit and ToolCall rows |
| `/registry/flows` | FlowSpec lifecycle management and step summary |
| `/registry/routes` | RouteSpec lifecycle, thresholds, examples, channels, roles, gray allowlist |
| `/registry/tools` | ToolManifest lifecycle, risk level, side effect and adapter summary |
| `/registry/agents` | AgentSpec lifecycle, Prompt and Tool dependencies |
| `/registry/prompts` | PromptDefinition lifecycle, content and variable review |
| `/releases` | capability_release query, detail, metadata, validation_result and rollback entry |
| `/human-tasks` | Human Task list/detail and approve/reject |
| `/task-runs` | TaskRun list/detail and links to Human Task/Audit/ToolCall |
| `/audit-events` | AuditEvent query and payload viewing |
| `/tool-calls` | ToolCall query, preview/result/idempotency viewing |

## Identity

The backend uses Header Auth. In development, the UI exposes an Identity Panel:

```text
user_id
tenant_id
roles
```

The API client injects:

```text
x-user-id
x-tenant-id
x-roles
x-request-id
```

Production does not silently create an administrator identity. If identity headers are missing, the API returns 401 and the UI displays a clear error.

## RBAC

- `platform_admin`: full Registry and operations access.
- `capability_operator`: Registry draft/edit/validate/publish/gray/rollback, operations read, Human Task approve/reject.
- `auditor`: read-only Registry, Release, TaskRun, Human Task, Audit and ToolCall.

The UI hides write buttons for users that lack the corresponding permission. The API remains the source of truth and still returns 403 for unauthorized writes.

## Registry Operations

All Registry pages use the same backend lifecycle:

```text
draft -> validated -> published -> gray/deprecated/disabled
```

Draft editing:

- Create draft with `POST /api/v1/<resources>`.
- Edit JSON in a textarea.
- Format JSON before saving if desired.
- Invalid JSON is blocked locally.
- Save draft with `PUT /api/v1/<resources>/:id/versions/:version` and `expected_revision`.

Release operations:

- Validate runs `RegistryValidationService`.
- Publish, gray, rollback, deprecate and disable require a confirmation modal and `release_note`.
- Gray supports deterministic tenant allowlist and optional user allowlist.
- Rollback selects an existing target version and writes a new release record; it does not edit historical spec content.
- Published/gray/deprecated/disabled versions are read-only; clone to modify.

Version comparison:

- Select two versions.
- The UI displays formatted JSON side by side.
- No heavyweight diff dependency is used in this phase.

## Resource-specific Views

Flow:

- Step count.
- Step type.
- Tool step references.
- Agent step references.
- Human task and condition steps.
- Dependency graph from validation result.
- L3 preview/confirmation path hint.

Route:

- Bound `flow_id` and version.
- Priority.
- Confidence and ambiguous thresholds.
- Keywords, examples, negative examples.
- Channels and role constraints.
- Gray tenant allowlist.

Tool:

- `tool_name`, version, `risk_level`, `side_effect`.
- Adapter type.
- Input/output schema.
- L3 requires Human Task confirmation path.
- L4 is denied by default.

Agent:

- `agent_id`.
- `prompt_ref`.
- `allowed_tools`.
- `max_steps`, `max_tokens`.
- Output schema and dependency validation.

Prompt:

- `prompt_id`, version, name.
- Content and variables.
- Validate warnings/errors for suspicious secrets.

## Operations Pages

Human Task:

- Query by status and task_run_id.
- View preview payload and decision history.
- Approve/reject through control-plane BFF.
- Does not copy runtime-api Human Task state machine.

TaskRun:

- Query by status, flow_id, workflow_id, task_run_id.
- View task details and errors.
- Link to Human Task, Audit and ToolCall pages.

Audit:

- Query by task_run_id, tool_name, event_type and time range.
- Display backend-masked payload only.

ToolCall:

- Query by task_run_id, tool_name and status.
- View preview_json, result_json and idempotency_key.
- Link back to TaskRun and Audit.

## Common Errors

- `401`: identity headers missing; set the development Identity Panel or provide production headers.
- `403`: role lacks permission; auditor is read-only.
- `409`: optimistic locking conflict, immutable published version, duplicate version or illegal lifecycle transition.
- `422`: validation failed or dependency cannot publish; inspect errors/warnings/dependency graph.
- `503`: database, runtime-api or tool-gateway is unavailable.

## Smoke

Run after Docker stack, migrations and seeds are ready:

```bash
corepack pnpm smoke:control-plane-ui-e2e
```

The UI smoke:

1. Opens control-plane.
2. Sets development identity as `capability_operator`.
3. Creates Prompt, Tool, Agent, Flow and Route drafts through control-plane API in a browser context.
4. Validates and publishes resources.
5. Opens Registry and Release pages to verify UI rendering.
6. Calls runtime-api router preview to prove new Route is effective.
7. Publishes v2 and rolls back to v1.
8. Starts a seeded L3 task.
9. Opens Human Task page and approves a pending task in the UI.
10. Waits for TaskRun completion.
11. Opens TaskRun, Audit and ToolCall pages.
12. Prints `ok: true`.

If the script fails because Chromium is not installed:

```bash
corepack pnpm --filter @dar/control-plane exec playwright install chromium
```
