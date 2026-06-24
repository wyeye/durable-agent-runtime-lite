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

## Locale and Audit Display

Tool Gateway API 响应使用请求 `Accept-Language`，第一版只支持并回退到 `zh-CN`，并设置 `Content-Language` / `Vary`。Locale 只影响响应消息和 Audit 展示文案，不参与授权、幂等键、tool hash 或 risk 判断。

Audit 记录以 `event_type`、`message_key` 和 `message_params` 为事实源；`display_message` 是按当前 locale 渲染的展示字段，历史 Audit 不依赖某一种自然语言。

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

执行前会用 ToolManifest 的 `input_schema` 校验 arguments。当前支持的 adapter：

- `mock`：开发/测试和现有 `knowledge.search`、`record.write.mock`。
- `http_readonly`：通用只读 HTTP GET，必须 `side_effect=false` 且 risk 为 `L0` / `L1`。

响应体使用 `toolInvokeResponseSchema`。

L0/L1 只读工具可以直接 invoke。L3 side-effect 工具不能直接 invoke 执行副作用；如果直接调用 `record.write.mock`，返回 `needs_confirmation` 和 `HUMAN_CONFIRMATION_REQUIRED`，并写 `audit_event`。L4 工具默认 deny。`http_readonly` 不支持 commit；错误路径返回稳定 Tool Error Code 并写安全审计。

### `http_readonly` Adapter

ToolManifest `adapter.type=http_readonly` 固定使用 GET：

```json
{
  "type": "http_readonly",
  "base_url": "https://policy.example.internal",
  "path": "/business-api/v1/policies",
  "query_mapping": { "keyword": "query" },
  "static_query": { "locale": "zh-CN" },
  "auth": { "type": "bearer_env", "secret_ref": "env:TOOL_SECRET_POLICY_API" },
  "timeout_ms": 5000,
  "max_response_bytes": 65536,
  "retry": { "max_attempts": 2, "retryable_status_codes": [408, 429, 500, 502, 503, 504], "backoff_ms": 100 },
  "response_body_path": "data",
  "response_headers_allowlist": []
}
```

安全规则：

- `base_url` 和 `path` 来自 ToolManifest，用户参数不能覆盖 Host、scheme 或 path。
- `TOOL_HTTP_ALLOWED_HOSTS` 必须显式允许 Host；不支持 `*`。
- production 默认只允许 `https:`；development/test 可用 `TOOL_HTTP_ALLOW_INSECURE_LOCALHOST=true` 显式允许 `localhost` / `mock-server`。
- 禁止 username/password、fragment、redirect、非 HTTP(S) 协议和解析到未授权/SSRF 网段的地址。
- `auth` 只支持 `none`、`bearer_env`、`api_key_env`；secret ref 必须匹配 `env:TOOL_SECRET_[A-Z0-9_]+`。
- API key header 只允许安全 token header 名；不会转发用户 `Authorization`。
- 响应必须是 JSON，读取受 `max_response_bytes` 限制，可用简单 dot path 选择 body 子对象，最后必须通过 Tool `output_schema`。
- 不持久化 raw headers、完整上游错误 body 或 secret。

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

成功后执行支持 commit 的 adapter，写 `tool_call_log=committed`、`audit_event=tool.commit`、`idempotency_record=succeeded`。同一 idempotency key + 相同请求 replay 返回相同结果；同一 key + 不同参数返回 `IDEMPOTENCY_CONFLICT`。未 approved 时返回 `HUMAN_CONFIRMATION_REQUIRED`，不执行副作用。`http_readonly` commit fail closed，返回 `TOOL_ADAPTER_NOT_SUPPORTED`。

### `GET /v1/tool-calls/:toolCallId`

返回 `toolCallLogSchema`。用于查看 preview/approval/reject/commit 状态。

### `GET /v1/audit-events`

返回 audit event 列表。DB 模式从 `audit_event` 表读取，memory 模式读取进程内 store。

### `GET /v1/idempotency-records/:idempotencyKey`

开发/调试接口。DB 模式从 `idempotency_record` 表读取。

默认关闭：

```text
TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED=false
```

开启后要求独立权限 `idempotency:debug`，不再复用 `tool_call:read`。返回数据会脱敏。

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
- `TOOL_HTTP_ALLOWED_HOSTS`：comma-separated Host allowlist for `http_readonly`; exact or controlled subdomain entries, never `*`.
- `TOOL_HTTP_ALLOW_INSECURE_LOCALHOST=false`：development/test switch for HTTP `localhost` / `mock-server`.
- `TOOL_HTTP_MAX_TIMEOUT_MS=15000`：platform timeout ceiling for HTTP tools.
- `TOOL_HTTP_MAX_RESPONSE_BYTES=1048576`：platform response-size ceiling for HTTP tools.
- `TOOL_SECRET_*`：runtime-only HTTP adapter secrets referenced by ToolManifest; update requires restarting tool-gateway in this MVP.
- production 会拒绝缺失、相同、过短或已知 placeholder service token。

## Readiness

`GET /healthz` 只表示进程存活。

`GET /readyz` 使用真实依赖探测：

- config；
- PostgreSQL 轻量只读查询；
- Tool Registry 读取；
- Tenant Policy Snapshot store 读取；
- service-token 配置。

production 下 readiness 要求 `TOOL_GATEWAY_REGISTRY_SOURCE=db`、`TOOL_GATEWAY_AUTH_MODE=service_token`、`TENANT_RUNTIME_POLICY_MODE=required`。

## Local DB Registry Flow

```bash
corepack pnpm dar db migrate
corepack pnpm dar db seed
TOOL_GATEWAY_REGISTRY_SOURCE=db corepack pnpm --filter @dar/tool-gateway dev
```

## Temporal DB smoke checks

`corepack pnpm dar smoke run temporal-db` 会在 workflow 完成后直接查询 DB，确认：

- `audit_event` 中存在 `knowledge.search` 的 `tool.invoke`、`record.write.mock` 的 `tool.preview` / `tool.commit`、以及 `human_task.approve`；
- `tool_call_log` 中 L3 `record.write.mock` 最终为 `committed`；
- `idempotency_record` 中存在 L1 invoke 和 L3 commit 幂等记录；
- repeated idempotency key 仍走 DB replay/conflict 逻辑，而不是进程内 Map。
