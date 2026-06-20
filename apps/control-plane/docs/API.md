# control-plane API

control-plane 现在以单个 Fastify 进程提供 Registry 管理 API、运营查询 BFF、OpenAPI 和 Vite 静态资源托管。

## 公共约定

- Base path: `/api/v1`
- 认证头：`x-user-id`、`x-tenant-id`、`x-roles`，可选 `x-request-id`
- 响应统一使用 `StandardApiResponse`
- 错误统一使用 `StandardErrorResponse`
- OpenAPI: `GET /openapi.json`
- Swagger UI: `GET /docs`，可由 `CONTROL_PLANE_SWAGGER_ENABLED=false` 关闭 UI
- 静态控制台资源：`NODE_ENV=production` 自动托管；非生产 smoke 环境可显式设置 `CONTROL_PLANE_STATIC_ENABLED=true`

## Registry API

五类资源使用相同生命周期接口：

```text
/api/v1/flows
/api/v1/routes
/api/v1/tools
/api/v1/agents
/api/v1/prompts
```

每类资源支持：

```text
GET    /api/v1/<resources>
POST   /api/v1/<resources>
GET    /api/v1/<resources>/:id/versions
GET    /api/v1/<resources>/:id/versions/:version
PUT    /api/v1/<resources>/:id/versions/:version
POST   /api/v1/<resources>/:id/versions/:version/clone
POST   /api/v1/<resources>/:id/versions/:version/validate
POST   /api/v1/<resources>/:id/versions/:version/publish
POST   /api/v1/<resources>/:id/versions/:version/gray
POST   /api/v1/<resources>/:id/versions/:version/deprecate
POST   /api/v1/<resources>/:id/versions/:version/disable
POST   /api/v1/<resources>/:id/rollback
GET    /api/v1/<resources>/:id/releases
```

写入规则：

- `POST` 创建 `draft`。
- `PUT` 必须带 `expected_revision`。
- `validated` 被修改后回到 `draft`。
- `published`、`gray`、`deprecated`、`disabled` 不允许原地 `PUT`。
- 修改已发布版本必须 `clone` 新版本。
- 发布、灰度、回滚、废弃、禁用写 `capability_release` 和 `audit_event`。

联合发布：

```text
POST /api/v1/releases/flow-route
```

请求包含 `flow_id`、`flow_version`、`route_id`、`route_version`、`release_note`。Flow 和 Route 在同一个数据库事务内发布，任一校验失败全部回滚。

发布记录：

```text
GET /api/v1/releases
GET /api/v1/releases/:releaseId
```

支持按 `resource_type`、`resource_id`、`action`、`operator_id`、`start_time`、`end_time`、`page`、`page_size` 过滤。

## 运营查询 BFF

control-plane 不复制运行状态机，只代理 runtime-api 和 tool-gateway：

```text
GET  /api/v1/operations/dashboard
GET  /api/v1/operations/human-tasks
GET  /api/v1/operations/human-tasks/:humanTaskId
POST /api/v1/operations/human-tasks/:humanTaskId/approve
POST /api/v1/operations/human-tasks/:humanTaskId/reject
GET  /api/v1/operations/task-runs
GET  /api/v1/operations/task-runs/:taskRunId
GET  /api/v1/operations/audit-events
GET  /api/v1/operations/tool-calls
GET  /api/v1/operations/tool-calls/:toolCallId
GET  /api/v1/operations/agent-runs
GET  /api/v1/operations/agent-runs/:agentRunId
GET  /api/v1/operations/agent-runs/:agentRunId/steps
GET  /api/v1/tenant-runtime-policy-snapshots
GET  /api/v1/tenant-runtime-policy-snapshots/:snapshotId
GET  /api/v1/tenant-agent-admissions
GET  /api/v1/tenant-agent-admissions/:admissionId
```

BFF 会向下游透传 `x-user-id`、`x-tenant-id`、`x-roles`、`x-request-id`，下游不可用映射为 `503 DOWNSTREAM_UNAVAILABLE`。

## React 运营页面

Fastify 在 production 同进程托管 Vite build 产物。前端页面均通过本文件中的 `/api/v1` API 获取数据：

```text
/dashboard
/registry/flows
/registry/routes
/registry/tools
/registry/agents
/registry/prompts
/releases
/human-tasks
/task-runs
/audit-events
/tool-calls
/agent-runs
/policy-snapshots
/tenant-admissions
```

开发身份面板会为 API client 注入：

```text
x-user-id
x-tenant-id
x-roles
x-request-id
```

页面不硬编码 runtime-api / tool-gateway 地址，也不直接访问下游服务。Operations 页面必须通过 control-plane BFF。

Registry 页面使用 JSON 编辑器管理 draft：

- JSON parse 失败不提交。
- `PUT` 自动携带当前 `revision` 作为 `expected_revision`。
- `409` 显示 optimistic lock / immutable version 友好提示。
- `422` 展示 validate errors/warnings/dependency graph。
- 发布、灰度、回滚、废弃、禁用均要求二次确认和 `release_note`。
- gray 支持 tenant allowlist。

Human Task 页面：

- `auditor` 只读，不显示 approve/reject。
- `platform_admin` 和 `capability_operator` 可通过 BFF approve/reject。
- 审批理由会作为 `decision_reason` 下发给 runtime-api。

AgentRun 页面：

- 通过 BFF 查询 runtime-api，不直接访问数据库；
- 显示 AgentRun 累计状态、model turn、token usage、tool call count、handoff count；
- Drawer 中显示 AgentStep、tool result refs、human task ids、context snapshot refs 和 handoff refs。

Policy Snapshot 页面：

- 只读查询 control-plane API；
- 展示 root/parent lineage、derivation type、source policy version/hash、execution plan ref/hash；
- Drawer 展示 effective tools、models、handoffs 和 budget；
- 不提供 create/update/delete。

Tenant Admission 页面：

- 只读查询 control-plane API；
- 支持 status、task、agent、workflow 和 acquired time 过滤；
- 展示 reserved/active/released/rejected/reconciled、TaskRun、AgentRun、Workflow、Policy Snapshot 和 release reason；
- 不提供 create/update/delete。

## 错误码

常见映射：

- `400 BAD_REQUEST`
- `401 UNAUTHORIZED`
- `403 FORBIDDEN`
- `404 *_NOT_FOUND`
- `409 REGISTRY_OPTIMISTIC_LOCK_CONFLICT` / `REGISTRY_VERSION_IMMUTABLE`
- `422 REGISTRY_VALIDATION_FAILED`
- `503 DOWNSTREAM_UNAVAILABLE`
- `500 INTERNAL_SERVER_ERROR`

响应不会返回 SQL、连接串或 stack trace。
