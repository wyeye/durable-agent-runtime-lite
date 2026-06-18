# control-plane 开发规范

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

服务端继续使用 Fastify。`createApp()` 和 `listen()` 分离；Registry API、Operations BFF、OpenAPI、静态文件托管都在同一个 `control-plane` app 内。

## 前端结构

```text
src/web/
  main.tsx
  App.tsx
  router.tsx
  api/
  auth/
  layout/
  pages/
  components/
  utils/
```

前端使用 React、Vite、Ant Design、React Router、React Query。所有请求必须走同源 `/api/v1/...`，不能硬编码 runtime-api 或 tool-gateway 地址。

## 身份与权限

Header 认证来源：

```text
x-user-id
x-tenant-id
x-roles
x-request-id
```

开发环境提供 Identity Panel，可写入 localStorage。production 不创建默认管理员；缺少身份时 API 返回 401，前端显示“缺少身份”。

角色规则：

- `platform_admin`：全部读写、发布治理、Human Task 决策。
- `capability_operator`：Registry 读写、校验、发布、灰度、回滚、Human Task 决策和运行记录读取。
- `auditor`：只读 Registry、Release、TaskRun、Human Task、Audit、ToolCall，不显示写操作。

## Registry UI 规则

- 五类资源使用统一 ResourcePage，但每类资源必须展示自己的关键字段。
- 创建和编辑使用 JSON textarea；JSON 解析失败不提交。
- `PUT` 必须使用当前版本 `revision` 作为 `expected_revision`。
- `draft` / `validated` 可编辑；`published` / `gray` / `deprecated` / `disabled` 不可编辑。
- 修改已发布资源必须 clone 新版本。
- `validated` 被编辑后由后端回到 `draft`，前端以 API 返回状态为准。
- `archived` 不作为新状态展示。
- validate 结果展示 `errors`、`warnings` 和 `dependency_graph`。
- publish、gray、rollback、deprecate、disable 必须输入 `release_note` 并二次确认。
- gray 支持 `tenant_allowlist` 和可选 `user_allowlist`，不使用随机分流。
- rollback 选择目标版本；rollback 不修改历史 spec 内容。
- 版本对比使用两侧格式化 JSON，暂不引入重型 diff 依赖。

## 运行查询 UI 规则

- Human Task 页面只调用 `/api/v1/operations/human-tasks...`，审批由 runtime-api 负责状态机。
- TaskRun 页面只调用 `/api/v1/operations/task-runs...`。
- Audit 和 ToolCall 页面只调用 `/api/v1/operations/audit-events`、`/api/v1/operations/tool-calls`。
- 前端不还原敏感字段；后端脱敏后原样展示。
- 下游不可用显示 503 友好错误。

## 常见错误展示

- `401`：缺少身份，提示设置 Identity Panel 或检查生产认证头。
- `403`：权限不足，提示当前角色不能执行该操作。
- `409`：revision 冲突、发布版本不可原地修改、重复版本或非法状态转换。
- `422`：Registry validate 未通过或依赖不可发布，展示校验详情。
- `503`：DB、runtime-api 或 tool-gateway 不可用。

## 测试与 smoke

常规验证：

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Docker/DB smoke：

```bash
corepack pnpm smoke:temporal-db-e2e
corepack pnpm smoke:control-plane-api-e2e
corepack pnpm smoke:control-plane-ui-e2e
```

UI smoke 需要 control-plane、runtime-api、runtime-worker、tool-gateway、PostgreSQL、Temporal 已运行。它会在浏览器中设置开发身份，验证页面渲染，创建并发布 Registry 资源，执行 router preview、rollback，并通过 Human Task 页面 approve 一个 L3 pending task。
