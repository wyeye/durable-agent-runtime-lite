# tool-gateway API 说明

本文件用于沉淀 tool-gateway 对外 API、事件和契约。正式开发时应与 `packages/contracts` 保持同步。

## Source of Truth

`tool-gateway` 支持两种 ToolManifest 来源：

- `TOOL_GATEWAY_REGISTRY_SOURCE=memory`：默认开发/测试模式，使用内置 mock tool manifest。
- `TOOL_GATEWAY_REGISTRY_SOURCE=db`：从 PostgreSQL `tool_manifest` 表读取 `published` / `gray` ToolManifest。

`NODE_ENV=production` 或 `APP_ENV=production` 时必须配置 `TOOL_GATEWAY_REGISTRY_SOURCE=db`，避免生产路径使用内置 mock ToolManifest。

DB 模式不会回退到内置 `knowledge.search` 或 `record.write.mock`。未注册工具返回标准 `TOOL_NOT_FOUND`。

DB 模式下：

- audit 写入 `audit_event` 表；
- preview / commit 写入 `tool_call_log` 表；
- idempotency 写入 `idempotency_record` 表；
- 同一 idempotency key + 相同请求返回原始响应；
- 同一 idempotency key + 不同请求返回 `IDEMPOTENCY_CONFLICT`。

真实 Docker smoke 使用：

```text
TOOL_GATEWAY_REGISTRY_SOURCE=db
TOOL_GATEWAY_AUTH_MODE=service_token
DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
HOST=0.0.0.0
PORT=3200
```

生产或 Docker smoke 路径不能使用 memory registry。缺失 ToolManifest 必须返回 `TOOL_NOT_FOUND`，不能回退到内置 `knowledge.search` 或 `record.write.mock`。

## Service Identity

Production requires service-token authentication. Requests must include:

```text
x-service-id
authorization: Bearer <service-token>
x-request-id
x-tenant-id
x-user-id
```

Allowed service IDs:

- `runtime-worker`: ToolManifest read, invoke, preview, commit.
- `control-plane`: ToolManifest read, AuditEvent read, ToolCall read.

`runtime-api` is intentionally not an allowed Tool Gateway caller. Missing or invalid tokens return `401`; a valid service token without permission for the operation returns `403`. Tokens are read only from environment variables and must not be logged or baked into container images.

## Endpoints

### `GET /v1/tools`

返回已注册工具列表。

### `GET /v1/tools/:toolName`

返回指定 ToolManifest。不存在时返回 404：

```json
{
  "success": false,
  "data": null,
  "error": { "code": "TOOL_NOT_FOUND", "message": "工具未注册" }
}
```

### `POST /v1/tools/:toolName/invoke`

请求体使用 `toolInvokeRequestSchema`。`tool_name` 由 path 参数注入。

执行前会用 ToolManifest 的 `input_schema` 校验 arguments。当前 mock adapter 支持：

- `knowledge.search`
- `record.write.mock`

响应体使用 `toolInvokeResponseSchema`。

L0/L1 只读工具可以直接 invoke。L3 side-effect 工具不能直接 invoke 执行副作用；如果直接调用 `record.write.mock`，返回 `needs_confirmation` 和 `HUMAN_CONFIRMATION_REQUIRED`，并写 `audit_event`。L4 工具默认 deny。

### `POST /v1/tools/:toolName/preview`

请求体使用 `toolPreviewRequestSchema`。preview 会：

1. 从 ToolManifest source 读取工具定义；
2. 校验 `arguments`；
3. 评估 L0-L4 风险策略；
4. 生成 `tool_call_id` 和 preview plan；
5. 写 `tool_call_log`，L3 状态为 `pending_confirmation`；
6. 写 `audit_event=tool.preview`。

preview 不执行 adapter，因此不会产生副作用。

### `POST /v1/tools/:toolName/commit`

请求体使用 `toolCommitRequestSchema`，必须带 `tool_call_id` 和 commit `idempotency_key`。

L3 commit 会校验：

1. `tool_call_id` 存在且与 tenant/tool 匹配；
2. 对应 `human_task` 已 approved；
3. commit idempotency key 未 conflict。

成功后执行 mock adapter，写 `tool_call_log=committed`、`audit_event=tool.commit`、`idempotency_record=succeeded`。同一 idempotency key + 相同请求 replay 返回相同结果；同一 key + 不同参数返回 `IDEMPOTENCY_CONFLICT`。未 approved 时返回 `HUMAN_CONFIRMATION_REQUIRED`，不执行副作用。

### `GET /v1/tool-calls/:toolCallId`

返回 `toolCallLogSchema`。用于查看 preview/approval/reject/commit 状态。

### `GET /v1/audit-events`

返回 audit event 列表。DB 模式从 `audit_event` 表读取，memory 模式读取进程内 store。

### `GET /v1/idempotency-records/:idempotencyKey`

开发/调试接口。DB 模式从 `idempotency_record` 表读取。

## Risk Levels

- `L0`：无敏感副作用，本地计算类。
- `L1`：只读工具，例如 `knowledge.search`。
- `L2`：建议/草稿类工具，commit 是否需要确认由策略决定。
- `L3`：side-effect 工具，例如 `record.write.mock`，必须 preview 后人工确认再 commit。
- `L4`：高敏感工具，默认 deny，并写 audit。

## Environment

- `DATABASE_URL`：DB 模式使用的 PostgreSQL URL。
- `TOOL_GATEWAY_REGISTRY_SOURCE=memory|db`：ToolManifest source。
- `TOOL_GATEWAY_AUTH_MODE=disabled|service_token`：service identity mode；production requires `service_token`。
- `TOOL_GATEWAY_RUNTIME_WORKER_TOKEN`：token accepted for the `runtime-worker` service.
- `TOOL_GATEWAY_CONTROL_PLANE_TOKEN`：token accepted for the `control-plane` service.

## Local DB Registry Flow

```bash
corepack pnpm db:migrate
corepack pnpm seed:examples
TOOL_GATEWAY_REGISTRY_SOURCE=db corepack pnpm --filter @dar/tool-gateway dev
```

## Temporal DB smoke checks

`corepack pnpm smoke:temporal-db-e2e` 会在 workflow 完成后直接查询 DB，确认：

- `audit_event` 中存在 `knowledge.search` 的 `tool.invoke`、`record.write.mock` 的 `tool.preview` / `tool.commit`、以及 `human_task.approve`；
- `tool_call_log` 中 L3 `record.write.mock` 最终为 `committed`；
- `idempotency_record` 中存在 L1 invoke 和 L3 commit 幂等记录；
- repeated idempotency key 仍走 DB replay/conflict 逻辑，而不是进程内 Map。
