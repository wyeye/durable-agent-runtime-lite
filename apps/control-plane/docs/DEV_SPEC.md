# control-plane 开发规范

## 模块划分

```text
modules/flow-registry
modules/route-registry
modules/tool-registry
modules/agent-registry
modules/prompt-registry
modules/release
modules/human-task
modules/dashboard
modules/audit-viewer
modules/registry
```

## API 约定

- 草稿类接口使用 `POST /api/v1/<resources>`。
- 更新草稿接口使用 `PUT /api/v1/<resources>/:id/versions/:version`，必须带 `expected_revision`。
- 发布类接口使用 `POST /api/v1/<resources>/:id/versions/:version/publish`。
- 灰度类接口使用 `POST /api/v1/<resources>/:id/versions/:version/gray`。
- 回滚类接口使用 `POST /api/v1/<resources>/:id/rollback`。
- 所有发布接口必须写 `capability_release` 和 `audit_event`。
- Flow + Route 联合发布使用 `POST /api/v1/releases/flow-route`。
- OpenAPI 输出 `GET /openapi.json`；Swagger UI 为 `GET /docs`。

## 服务端结构

```text
src/server/
  app.ts
  bootstrap.ts
  clients/
  plugins/
  routes/
  services/
  utils/
```

`createApp()` 和 `listen()` 分离，测试通过 `app.inject()` 覆盖管理 API、BFF、OpenAPI 和静态资源 fallback。

## 数据写入规则

- `published` 版本不可变，不允许原地修改。
- `gray`、`deprecated`、`disabled` 版本也不可通过 draft 更新接口修改。
- `draft` 和 `validated` 可以修改；修改 `validated` 会回到 `draft`。
- `updateDraft` 必须携带 `expected_revision`，冲突返回明确 optimistic lock 错误。
- 修改已发布流程必须生成新版本。
- 下线只改变状态，不物理删除。
- FlowSpec、RouteSpec、AgentSpec、PromptDefinition、ToolManifest 需要保存 `sha256`。
- `archived` 不再作为新状态；历史数据由 migration 转成 `deprecated`。
- `capability_release` 是 append-only，不允许用修改历史 release 记录伪造回滚。

## 状态机

允许：

```text
draft -> validated
validated -> draft
validated -> published
published -> gray
gray -> published
published -> deprecated
gray -> deprecated
draft/validated/published/gray -> disabled
```

禁止原地恢复：

```text
published -> draft
gray -> draft
deprecated -> published
disabled -> published
```

重新启用必须 clone 新版本。

## 发布与灰度

- 发布、灰度、回滚、废弃、禁用必须在事务中完成。
- Flow 和绑定 Route 支持联合事务发布。
- 灰度只支持 deterministic allowlist：`tenant_allowlist` 和可选 `user_allowlist`。
- 不允许随机流量分流。
- 运行路径只读取 `published` / `gray`。
- 已运行 Temporal Workflow 继续使用启动时锁定的 `db://flow/...` 版本。

## 认证与权限

Header 认证来源：

```text
x-user-id
x-tenant-id
x-roles
x-request-id
```

角色：

- `platform_admin`：全部读写、发布治理和 Human Task 决策。
- `capability_operator`：Registry 读写、校验、发布、灰度、回滚、Human Task 决策和运行记录读取。
- `auditor`：只读 Registry、release、TaskRun、Human Task、Audit、ToolCall。

`CONTROL_PLANE_AUTH_MODE=disabled` 仅允许 development/test；production 必须为 `header`。

## 错误映射

- `400`：请求格式或参数错误。
- `401`：缺少身份。
- `403`：权限不足。
- `404`：资源或版本不存在。
- `409`：revision 冲突、发布版本原地修改、重复版本或非法状态转换。
- `422`：Registry 校验失败或依赖不可发布。
- `503`：runtime-api / tool-gateway 下游不可用。
- `500`：未知服务端错误。

错误响应不得包含 SQL、连接串、stack trace 或敏感 payload。

## UI 规范

- 所有发布动作需要二次确认。
- 所有高风险工具要醒目标注。
- 流程引用不存在的 Tool / Agent / Prompt 时禁止发布。
- 页面要展示当前版本、灰度比例、最近发布时间、发布人。

## 测试要求

- contracts 管理 API Schema 测试。
- control-plane API 权限、错误映射、OpenAPI、静态资源和 BFF 测试。
- runtime-api Human Task / TaskRun 查询测试。
- tool-gateway Audit / ToolCall 查询和脱敏测试。
- Dockerfile 单容器约束测试。
- `smoke:control-plane-api-e2e` 验证管理 API 和 BFF 基础链路。
