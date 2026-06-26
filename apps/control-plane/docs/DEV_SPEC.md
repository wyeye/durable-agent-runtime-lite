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

## 国际化

- 第一版只开放 `zh-CN`，不显示语言切换器，也不创建空英文资源文件。
- 前端通过共享 `@dar/i18n` 资源和 Ant Design `zh_CN` locale 渲染中文 UI。
- API Client 固定发送 `Accept-Language: zh-CN`；control-plane BFF 会把请求 locale 继续透传到 runtime-api 和 tool-gateway。
- 页面可以保留稳定机器字段和技术名词，例如 `task_run_id`、`workflow_id`、`Dataset Hash`、`Gate Policy`、`Override`。
- 业务判断必须依赖 code、enum、id、hash 和 API data，不能依赖中文 display message。
- Audit 页面优先展示后端按当前 locale 渲染的 `display_message`，但原始 `event_type/action` 仍作为技术字段保留。

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
- 创建和编辑使用 `visual-config` 可视化表单；JSON 仅允许只读查看、复制和下载。
- 表单提交链路必须是 `formToSpec()` -> `@dar/contracts` Zod `safeParse()` -> 现有 API；不得用 Raw JSON 编辑、导入或“应用 JSON”绕过表单。
- 引用字段必须使用精确版本或结构化引用，不使用 `latest`，不自动选择第一项，不回退到默认资源。
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
- Flow 可视化 canvas 只表达现有 `steps` 数组顺序执行语义，不保存节点坐标，也不引入任意 DAG。
- ModelPolicy target 必须使用精确已发布 ModelDefinition 选择器生成 `model_ref`；不显示或提交旧 `gateway_profile` / `model_id` 手工输入。
- JSON 视图只读，不允许通过粘贴 JSON 绕过模型选择器。
- Tool 可视化编辑器支持 `mock` 与 `http_readonly` adapter；选择 `http_readonly` 时只展示 GET 所需字段，risk 限制为 `L0` / `L1`，`side_effect=false`，secret 只填写 `env:TOOL_SECRET_*` 引用并展示 Host Allowlist 提示，不收集真实 Key。

## Model Catalog UI 规则

- `/model-gateways` 和 `/models` 只调用 control-plane 同源 `/api/v1/model-gateways`、`/api/v1/models`。
- `platform_admin` 可创建、发布、禁用、测试连接和轮换凭据；`capability_operator`、`auditor` 不显示凭据写入或轮换操作。
- API Key 使用 Password 输入，保存后不回填、不提供查看按钮，也不把 ciphertext、IV、auth tag 放入只读 JSON。
- 模型必须绑定已发布 Gateway Profile；ModelPolicy 只能选择已发布模型版本。
- 列表和详情页只展示凭据配置状态、fingerprint 和 revision。

## 运行查询 UI 规则

- Human Task 页面只调用 `/api/v1/operations/human-tasks...`，审批由 runtime-api 负责状态机。
- TaskRun 页面只调用 `/api/v1/operations/task-runs...`。
- Audit 和 ToolCall 页面只调用 `/api/v1/operations/audit-events`、`/api/v1/operations/tool-calls`。
- 前端不还原敏感字段；后端脱敏后原样展示。
- 下游不可用显示 503 友好错误。

## Evaluation UI 规则

- Evaluation 页面只调用 control-plane 同源 `/api/v1/evaluation-*` 和 `/api/v1/evaluation-runs*`。
- Dataset / Case 页面不使用 sample/mock 生产数据；empty 仅表示后端成功返回空结果。
- Dataset / Case / Gate Policy 创建和编辑使用可视化表单；JSON 仅只读。Gate Policy Required Dataset 通过 exact Dataset version/hash 选择器生成，不能手工伪造 hash。
- Create Run 必须输入 exact Dataset version/hash、Subject Snapshot ref/hash、EvaluationExecutionPlan ref/hash，不允许 latest。
- Run Detail 只显示 safe evidence refs 和 summary，不显示完整 Tool Result、raw Provider Response 或 hidden reasoning。
- Gate Decision freshness/stale reasons 以后端返回为准，前端不重算 Gate Decision。
- Override 按钮仅 `platform_admin` 可见；后端仍负责 403、expiry、exact resource hash 和 allow_override 校验。
- Prompt、Agent、ModelPolicy Registry Gate Card 只传递 exact candidate bundle / decision / override metadata；publish allowed/blocked 以后端响应为准。

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
corepack pnpm dar smoke suite core
corepack pnpm dar smoke suite governance
corepack pnpm dar smoke suite ui
```

UI smoke 需要 control-plane、runtime-api、runtime-worker、tool-gateway、PostgreSQL、Temporal 已运行。它会在浏览器中设置开发身份，验证页面渲染，创建并发布 Registry 资源和 Model Catalog 资源，执行 router preview、rollback，并通过 Human Task 页面 approve 一个 L3 pending task。

Evaluation UI smoke 还需要 mock-server 和接入模型网关链路的 runtime-worker。它通过浏览器完成 Dataset/Case、Gate Policy、Run、Gate Decision、Registry Gate Card 和 Override/RBAC 操作；setup 只准备 UI 当前不负责创建的 immutable candidate snapshot / execution plan。当前可写配置 smoke 不应驱动 `json-editor-textarea`。
