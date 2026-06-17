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
- idempotency 写入 `idempotency_record` 表；
- 同一 idempotency key + 相同请求返回原始响应；
- 同一 idempotency key + 不同请求返回 `IDEMPOTENCY_CONFLICT`。

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

### `GET /v1/audit-events`

返回 audit event 列表。DB 模式从 `audit_event` 表读取，memory 模式读取进程内 store。

## Environment

- `DATABASE_URL`：DB 模式使用的 PostgreSQL URL。
- `TOOL_GATEWAY_REGISTRY_SOURCE=memory|db`：ToolManifest source。

## Local DB Registry Flow

```bash
corepack pnpm db:migrate
corepack pnpm seed:examples
TOOL_GATEWAY_REGISTRY_SOURCE=db corepack pnpm --filter @dar/tool-gateway dev
```
