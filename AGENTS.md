# AGENTS.md

## 1. 作用与使用方式

本文件定义 Durable Agent Runtime Lite 的长期工程规则、架构边界和协作约束。

本文件不是：

- 当前进度日报；
- 阶段验收记录；
- Smoke 命令清单；
- Migration 版本清单；
- Git 提交历史；
- 产品路线图全文。

这些信息分别维护在：

```text
docs/project/current-status.md
docs/project/roadmap-and-release.md
docs/operations/testing-replay-and-recovery.md
CHANGELOG.md
```

除非架构规则发生变化，不要因为单次功能开发频繁修改本文件。

任务提示词可以收窄本次工作范围，但不得默认突破本文件中的安全、确定性、租户隔离和四应用架构边界。

---

## 2. 项目定位

项目名称：

```text
Durable Agent Runtime Lite
```

项目目标：

构建一个通用、可持久执行、可治理、可评测的 Agent Runtime 平台，同时支持：

- 配置驱动的预置流程；
- Temporal 持久工作流；
- Pi 有界 Agent Loop；
- 规则与语义路由；
- 模型目录与模型策略；
- Tool Gateway 统一工具出口；
- L3 人工确认；
- Tenant Runtime Policy；
- Evaluation 与 Registry Publish Gate；
- 能力运营控制台；
- 审计、幂等、崩溃恢复和 Replay。

项目必须保持通用平台属性。

除非任务明确要求，不得把特定行业、客户或业务系统的概念写入通用 Runtime、Contract 或 Registry 核心。

---

## 3. 事实源优先级

发生文档、总结和代码不一致时，按以下顺序判断：

1. 当前 Git 工作区代码；
2. `packages/contracts`；
3. 数据库 Migration；
4. 自动化测试和真实 Smoke；
5. `docs/project/current-status.md`；
6. 活跃架构和指南文档；
7. 根 `README.md`；
8. `docs/archive/` 和历史分析。

历史总结、旧 Codex 回复和聊天内容不是代码事实源。

不要仅依据文件修改时间判断内容是否最新。

---

## 4. 开始任务前的工作协议

每个任务开始时至少执行：

```bash
git status --short --branch
git remote -v
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git log --oneline -10
git diff --stat
git diff --check
```

规则：

- 不自动 `reset`；
- 不自动 `merge`；
- 不自动 `rebase`；
- 不覆盖用户已有修改；
- 不回滚不属于本任务的变更；
- 本地与远端不一致时先报告；
- 除非用户明确要求，不执行 `commit`、`push`、`tag` 或 GitHub Release；
- 以当前仓库实际结构为准，不凭旧提示词猜测；
- 先审计已有实现，再写代码；
- 已完成能力不得推倒重写；
- 一次任务只解决一个可验收闭环；
- 不把下一阶段内容“顺便”加入当前任务。

---

## 5. 固定四应用架构

生产应用只能是：

```text
apps/control-plane
apps/runtime-api
apps/runtime-worker
apps/tool-gateway
```

未经明确批准，不得新增第五个生产应用或生产业务容器。

### 5.1 control-plane

职责：

- 能力运营控制台；
- Registry 管理；
- Flow、Route、Tool、Agent、Prompt 管理；
- Model Gateway、Model、ModelPolicy 管理；
- Tenant Policy 管理；
- Evaluation Dataset、Run、Gate 管理；
- 发布、灰度、回滚、禁用；
- Human Task、TaskRun、AgentRun、Audit、ToolCall 运营视图；
- BFF 和 OpenAPI；
- 前端静态资源托管。

禁止：

- 执行 Workflow；
- 运行 Pi；
- 直接执行 Tool；
- 直接访问业务系统；
- 在浏览器中处理或回显模型 API Key；
- 在前端复制后端 DTO；
- 在前端自行计算 Gate Decision、Policy Decision 或权限结果。

### 5.2 runtime-api

职责：

- 统一 Runtime 公共入口；
- 身份、租户、用户和请求上下文标准化；
- action、规则和 pgvector 语义路由；
- 澄清和拒绝；
- TaskRun 创建与查询；
- Temporal Workflow 启动和 Signal 入口；
- Evaluation Run 启动和查询。

允许的外部模型调用：

- 仅允许通过专用 Embedding Resolver 调 OpenAI-compatible Embeddings；
- 只用于路由语义向量；
- 必须使用精确 ModelDefinition；
- 必须从 Model Catalog 动态解析 Gateway；
- 不允许调用 Chat Completion；
- 不允许运行 Pi。

禁止：

- 直接调用 Tool；
- 直接访问业务系统；
- 直接执行 Agent Loop；
- 在澄清或拒绝时创建 Workflow；
- 使用 memory/default/sample 作为 production fallback。

### 5.3 runtime-worker

职责：

- Temporal Worker；
- Workflow 和 Activity；
- ConfigDrivenWorkflow；
- Pi Durable Agent Workflow；
- Human Task Signal；
- Handoff 和 Continue-As-New；
- Model Gateway 调用；
- Context Snapshot；
- Crash Recovery 和 Replay；
- Evaluation Worker。

禁止：

- Workflow 代码直接访问 DB；
- Workflow 代码直接访问 HTTP；
- Workflow 代码直接调用模型；
- Workflow 代码直接运行 Pi；
- Workflow 代码直接读取当前时间或随机数；
- runtime-worker 直接调用业务 HTTP API；
- Pi 直接访问 Tool Gateway、DB、Temporal Client、文件系统、Shell、MCP 或业务系统。

### 5.4 tool-gateway

职责：

- Tool 唯一执行出口；
- ToolManifest 解析；
- 参数和输出 Schema 校验；
- Tenant Policy 和 Tool Policy；
- 风险等级；
- 幂等；
- 审计；
- L3 preview / Human Task / commit；
- Adapter Dispatcher；
- 只读 HTTP Adapter；
- 后续批准的业务 Adapter。

禁止：

- 绕过 ToolManifest；
- 绕过 Tenant Policy；
- 信任调用方提交的 resolved policy；
- 接受用户动态覆盖 Host、Scheme 或固定 Path；
- 记录凭据、Authorization 或未脱敏结果；
- 让生产请求落到 mock adapter。

---

## 6. 运行路径不变量

正式运行路径：

```text
用户 / API / Webhook
  -> runtime-api
  -> action / rule / semantic router
  -> Temporal Workflow
  -> runtime-worker
  -> Pi Agent Loop（需要时）
  -> Activity
  -> tool-gateway
  -> 外部工具或业务 API
```

核心规则：

- `runtime-api` 是唯一 Runtime 公共入口；
- `tool-gateway` 是唯一工具和业务副作用出口；
- Pi 只能生成文本、规划、分类和 Tool Proposal；
- Pi Deferred Tool 只能终止当前 Segment 并返回 Proposal；
- 真正 Tool Call 必须由 Workflow -> Activity -> Tool Gateway 执行；
- 所有外部调用必须位于 Activity 或非 Workflow 服务层；
- 运行时不得读取 `latest` 资源；
- 运行时不得使用默认资源兜底；
- 运行时必须使用不可变 Execution Plan；
- 已运行 Workflow 不受新发布版本影响。

---

## 7. Registry 和版本锁定

以下 Registry 资源必须版本化：

- FlowDefinition；
- RouteConfig；
- ToolManifest；
- AgentSpec；
- PromptDefinition；
- ModelGatewayProfile；
- ModelDefinition；
- ModelPolicy；
- TenantRuntimePolicy；
- EvaluationDataset；
- EvaluationGatePolicy。

规则：

- draft 和 validated 可以修改；
- published、gray、deprecated、disabled 不可原地修改；
- 修改已发布资源必须 clone 新版本；
- 发布前必须验证所有精确依赖；
- 发布必须记录版本、Hash、操作者和 Audit；
- rollback 切换可选版本，不修改历史内容；
- 所有引用必须包含精确版本；
- 需要防漂移的引用必须包含 Hash；
- 不允许 `latest`；
- 不允许缺少依赖时选择默认资源。

不可变运行计划包括：

- FlowExecutionPlan；
- AgentExecutionPlan；
- EvaluationExecutionPlan；
- Tenant Policy Snapshot；
- Evaluation Subject Snapshot。

---

## 8. Temporal 确定性规则

Workflow 中禁止：

- DB 调用；
- HTTP 调用；
- 模型调用；
- Pi 调用；
- Tool 调用；
- 文件系统访问；
- Shell；
- 非 Temporal 随机数；
- 直接墙钟时间；
- 未受控全局状态。

Workflow 中允许：

- Temporal Timer；
- Signal；
- Child Workflow；
- Activity；
- Continue-As-New；
- 确定性计算；
- 不可变输入。

其他规则：

- 外部 I/O 必须放在 Activity；
- 大 Prompt、Context、Tool Result 和附件不得直接放入 History；
- History 中保存引用；
- Side Effect Activity 必须有稳定幂等键；
- Workflow 修改必须通过 Replay；
- 不删除历史 Replay Fixture 来掩盖不兼容；
- 必要时使用 Temporal Patch API；
- Worker Crash 后必须使用同一 Plan、Policy Snapshot 和幂等身份恢复。

---

## 9. Pi Agent Loop 规则

Pi 是受 Temporal 管理的有界内循环，不是系统总控制器。

必须：

- 使用真实 Pi Agent Core；
- 使用 Segment 边界；
- 使用最大步骤、Token、ToolCall、Handoff、时长和 Context 预算；
- 使用 Context Snapshot 恢复；
- Tool Proposal 经 Temporal 边界；
- Tool Result 必须来自 Tool Gateway 权威结果；
- Human Task、Handoff、Continue-As-New 由 Temporal 管理。

禁止：

- Pi 直接调用 Tool Gateway；
- Pi 直接访问业务 API；
- Pi 直接读取数据库；
- Pi 直接使用 Secret；
- Pi 直接访问 MCP；
- Pi 直接执行 Shell；
- Pi 直接访问文件系统；
- 保存 hidden chain-of-thought。

---

## 10. 路由规则

路由顺序固定为：

```text
1. tenant / channel / role 过滤
2. action_id 精确匹配
3. keyword / example 规则匹配
4. pgvector Top-K 语义召回
5. matched / need_clarify / reject
```

规则：

- action 和规则命中优先于语义召回；
- negative example 是硬排除；
- channel 和 role 在向量召回前过滤；
- 只有 published / gray 可执行版本进入候选；
- 语义 Embedding 是基础模型能力，不是 Tool；
- Embedding 调用由 runtime-api 的专用 Resolver 执行；
- 澄清和拒绝不得创建 TaskRun 或 Workflow；
- 低置信度不得静默执行高风险 Flow；
- production 不允许 MockVectorRecall；
- LLM/Pi 候选重排只有在明确任务批准后才能加入。

---

## 11. 模型目录和凭据规则

关系：

```text
ModelGatewayProfile
  -> ModelDefinition
  -> ModelPolicy
  -> AgentSpec
  -> AgentExecutionPlan
```

规则：

- Gateway Profile 保存公共网关配置；
- API Key 使用 AES-256-GCM 加密后存 PostgreSQL；
- 主密钥只来自 `MODEL_CREDENTIAL_MASTER_KEY`；
- API Key 是 write-only；
- API、日志、Audit、Trace、UI 不得返回 Key、密文、IV 或 Auth Tag；
- ModelDefinition 引用精确 Gateway Profile；
- ModelPolicy 只能选择 published ModelDefinition 精确版本；
- ModelPolicy 页面不得重新允许手填 `gateway_profile` 和 `model_id`；
- AgentExecutionPlan 锁定 ModelDefinition 和 Gateway public config Hash；
- Credential rotation 不能改变 ExecutionPlan；
- 动态 Client Cache Key 必须包含 Credential Revision；
- 新增网关、模型、策略切换和凭据轮换不应要求重启 Worker；
- runtime-api 只能使用 Embedding Model；
- runtime-worker 使用 Chat / Tool-capable Model；
- tool-gateway 不读取模型凭据。

本地 Ollama 手动/self-hosted 门禁：

- Ollama 只运行在宿主机；
- 精确模型固定为 `qwen2.5:7b-instruct-q4_K_M`；
- Gateway Profile 固定为 `local-ollama`；
- runtime-worker 容器通过 `host.docker.internal:11434/v1` 访问；
- 四个生产 app 必须来自 Docker 镜像；
- GitHub hosted CI 不下载或运行本地 7B 模型；
- 不能用 deterministic Pi 或 mock-server 代替 Ollama 真实门禁。

---

## 12. Tool 和 Adapter 规则

每个 Tool Call 必须包含：

- tenant_id；
- user_id；
- request_id；
- task_run_id；
- workflow_id；
- tool_name；
- tool_version；
- arguments；
- idempotency_key；
- risk_level；
- Execution Plan identity；
- Tenant Policy Snapshot identity。

生命周期：

```text
validate
-> load manifest
-> verify exact identity
-> policy
-> idempotency
-> adapter
-> output validation
-> audit
-> normalized result
```

### 12.1 http_readonly

必须：

- method 固定 GET；
- L0/L1；
- `side_effect=false`；
- Host allowlist；
- SSRF 防护；
- 固定 Base URL 和 Path；
- Tool 参数只能映射 Query；
- Secret 只通过 `env:TOOL_SECRET_*`；
- timeout；
- bounded retry；
- response size limit；
- JSON-only；
- output schema；
- redaction。

禁止：

- 用户输入动态 URL；
- redirect；
- 任意 Header；
- OAuth；
- Request Body；
- commit；
- 明文凭据。

### 12.2 L3

Side Effect Tool 必须：

```text
preview
-> Human Task
-> Signal
-> commit
```

必须具备：

- idempotency；
- ToolCall log；
- HumanTask；
- Audit；
- 拒绝路径；
- retry 不重复 commit。

---

## 13. Control-plane 前端规则

技术基线：

- React；
- Vite；
- Ant Design；
- React Query；
- shared contracts；
- `@dar/i18n`。

语言：

- 第一版只支持 `zh-CN`；
- 不增加空的 `en-US`；
- 不显示语言切换器；
- 用户可见文案必须使用 i18n key；
- 机器字段、枚举、Code、ID 和 Hash 不翻译。

配置体验：

- 可写配置必须使用可视化表单；
- JSON 只能只读、复制和下载；
- 不提供高级 JSON 编辑；
- 不提供 JSON 导入绕过表单；
- 表单最终必须生成 shared contract；
- 提交前必须通过 Zod；
- 引用必须使用精确版本选择器；
- Flow Canvas 只表达现有顺序 steps 语义；
- 不引入任意 DAG；
- published 版本只读；
- 修改已发布资源必须 clone。

安全：

- API Key 输入不回显；
- 不显示 encrypted credential；
- 前端不自行判断权限、Policy 或 Gate；
- 前端不直连 runtime-api、tool-gateway 或数据库；
- 所有请求走 control-plane 同源 BFF。

---

## 14. API、错误和国际化

机器字段保持稳定：

- error code；
- event code；
- event type；
- status；
- resource type；
- API path；
- JSON 字段；
- ID；
- Hash。

本地化内容：

- `message_key`；
- `message`；
- UI 标签；
- 安全错误说明；
- 日志消息；
- Audit display message；
- OpenAPI 描述；
- Validation message。

标准错误至少包含：

```json
{
  "code": "STABLE_ERROR_CODE",
  "message_key": "errors.someKey",
  "message": "中文安全提示",
  "locale": "zh-CN",
  "request_id": "req_xxx"
}
```

规则：

- API 使用 `Accept-Language`；
- 第一版不支持的语言回退 `zh-CN`；
- 设置 `Content-Language`；
- 设置 `Vary: Accept-Language`；
- 业务逻辑不得依赖本地化文本；
- 服务间判断依赖 Code，不依赖 Message；
- Zod Issue 必须安全本地化；
- 不返回 Stack、SQL、连接串和 raw adapter response。

---

## 15. 日志和 Audit

日志必须是结构化 JSON。

稳定字段：

- event_code；
- message_key；
- message；
- locale；
- request_id；
- tenant_id；
- user_id；
- task_run_id；
- workflow_id；
- workflow_run_id；
- agent_run_id；
- tool_call_id；
- model_call_id。

日志语言使用：

```text
LOG_LOCALE
```

不得随每个请求切换日志语言。

Audit 事实源：

```text
event_type
message_key
message_params
metadata
```

`display_message` 只是渲染结果。

禁止记录：

- API Key；
- Authorization；
- Cookie；
- Password；
- Secret；
- 完整 Prompt；
- 完整 Context Snapshot；
- raw Model Response；
- 未脱敏 Tool Result；
- hidden chain-of-thought。

---

## 16. Mock、Fake 和 Sandbox 边界

### 16.1 外部依赖 Mock

以下外部模拟只能位于：

```text
devtools/mock-server
```

包括：

- Model Gateway；
- Tool Call 模型响应；
- Embedding Gateway；
- 外部业务 HTTP API；
- 429 / 5xx / timeout；
- invalid JSON；
- oversized response；
- 外部 request count。

生产 app 源码不得实现外部系统的 Mock Response Generator。

### 16.2 单元测试 Fake/Stub

只允许位于：

```text
**/*.test.ts
**/tests/**
devtools/repo-cli/**
```

production entrypoint 不得 import。

### 16.3 基础设施开发模式

memory repository、mock Workflow Starter 等不是外部 Mock Server。

它们只允许 development/test：

- production 必须 fail closed；
- production Compose 不启用；
- 不得作为真实验收证据；
- 不得恢复为 default fallback。

### 16.4 Sandbox 例外

显式 sandbox adapter 可以临时存在，但必须：

- 位于清晰 sandbox/testing 目录；
- 仅 development/test；
- production 配置拒绝；
- 有明确 allowlist；
- 不允许继续新增未批准的 app 内 Mock Adapter。

### 16.5 生产 Compose

生产 Compose 不得包含：

```text
devtools/mock-server
```

---

## 17. 数据库和 Migration

规则：

- Schema 变更必须通过 Migration；
- 不允许运行时 ad hoc DDL；
- Migration 必须确定性和可审查；
- Seed 与 Migration 分离；
- published spec 使用版本和 Hash；
- Audit append-only；
- 幂等记录不可任意覆盖。

项目仍处于 pre-v1：

- 默认不做旧数据双读；
- 默认不做 legacy loader；
- 默认不做历史数据回填；
- 默认不做 latest/default fallback；
- 需要兼容旧数据时必须由任务明确批准。

development/test 可以清库重建，但必须：

- 明确环境保护；
- 不作用于 production；
- 不全局 prune Docker Volume；
- 不删除 Ollama 模型；
- 重建后运行 Migration、Seed 和相关 Smoke。

除非任务明确批准整体 baseline squash，否则新增 forward Migration。

---

## 18. 依赖和代码规范

技术基线：

- Node.js 24；
- TypeScript strict；
- pnpm workspace；
- Turborepo；
- Fastify；
- React；
- Vite；
- Ant Design；
- Zod；
- PostgreSQL；
- pgvector；
- Kysely；
- Temporal；
- Pi Agent Core；
- Pino；
- Vitest；
- Playwright。

规则：

- 不切换包管理器；
- 不引入第二个 ORM；
- 不引入第二个前端框架；
- 不引入新的测试框架；
- 不引入大型依赖解决小问题；
- 新依赖必须说明必要性；
- 外部输入必须 Zod 校验；
- 公共类型显式；
- 不使用大范围 `any`；
- 不吞异常；
- 不把业务逻辑写在路由文件；
- App 可以依赖 Package；
- Package 不得依赖 App；
- 避免循环依赖；
- 文件使用 kebab-case，框架约定除外。

---

## 19. 仓库脚本和 Smoke 规范

目标统一开发入口：

```bash
pnpm dar ...
```

Canonical 命令：

```bash
pnpm dar check all
pnpm dar check docs
pnpm dar check mocks
pnpm dar check version
pnpm dar check i18n
pnpm dar check visual-config

pnpm dar db migrate
pnpm dar db seed

pnpm dar replay export
pnpm dar replay test

pnpm dar smoke list
pnpm dar smoke run <scenario>
pnpm dar smoke suite <suite>
```

Smoke Suite 固定为：

```text
core
agent
governance
ui
real
```

规则：

- 不再新增根级单场景 `smoke:*` alias；
- 不再在 `scripts/` 根目录新增 `smoke-*.ts`；
- 新 Scenario 必须登记统一 Catalog；
- 共用 API、DB、Polling、Compose、Artifact 和 Secret Scan；
- CI/Integration 使用 Suite；
- Real Suite 仅 manual/self-hosted；
- 每个 Scenario 输出统一 JSON；
- 跳过不能伪装成通过；
- Smoke 失败必须可定位；
- 不使用 `|| true`；
- 不降低已有覆盖。

`scripts/` 根目录只允许薄 Wrapper，不保存业务或测试逻辑。

---

## 20. 文档规则

活跃文档结构：

```text
docs/
  README.md
  architecture/
  guides/
  operations/
  reference/
  project/
  archive/
```

唯一事实源：

- 当前状态：`docs/project/current-status.md`
- 路线和发布：`docs/project/roadmap-and-release.md`
- 非目标：`docs/project/non-goals.md`
- 测试、Replay 和恢复：`docs/operations/testing-replay-and-recovery.md`

规则：

- 活跃主题文档不使用连续编号；
- 每个主题只有一个 active 文档；
- 不为每个开发阶段新增一份永久文档；
- 历史记录依赖 Git History；
- archive 只保留少量确有价值的历史材料；
- README 只保留简介、快速启动、常用命令和文档入口；
- 行为变化优先更新已有文档，不新建重复文档；
- 文档必须使用当前命令；
- 文档不得引用已删除脚本；
- 文档中的版本和 Migration Head 必须与仓库一致；
- `.docx` 不作为活跃工程文档。

---

## 21. 测试标准

测试层级：

1. Unit；
2. Contract；
3. DB Integration；
4. API Integration；
5. Temporal Workflow；
6. Tool Gateway；
7. Service E2E Smoke；
8. UI Playwright；
9. Real/manual Gate；
10. Replay。

新功能最低覆盖：

- happy path；
- validation failure；
- permission/policy deny；
- idempotency；
- audit；
- tenant isolation；
- Secret redaction；
- typecheck；
- regression。

规则：

- 不能用 Unit Test 替代承诺的服务级 E2E；
- 不能用 direct DB insert 伪造 Registry 发布成功；
- 不能用 mock Pi Runner 证明 Pi 链路；
- 不能用 mock-server 证明 real Gate；
- real Gate 必须明确证明 mock-server 未运行；
- 不运行的验证必须标记 skipped / not run，不能写 passed；
- 任务没有对应测试时不得声明完成。

---

## 22. Docker 规则

每个生产 app 保留独立 Dockerfile。

规则：

- Build Context 是仓库根目录；
- 使用 multi-stage；
- 使用 corepack 和 pnpm；
- frozen lockfile；
- 不复制本地 node_modules；
- 不复制 `.env`；
- 不复制 `.git`；
- 不把 Secret 打进镜像；
- 非 root；
- healthcheck；
- backend 绑定 `0.0.0.0`；
- graceful shutdown；
- `/version` 暴露 build metadata；
- 不使用未固定的 production `latest` tag；
- `devtools/mock-server` 只能在 dev/test override。

如果任务改变启动、依赖、构建产物或环境变量，至少验证：

1. affected image build；
2. container start；
3. healthz；
4. readyz；
5. structured logs；
6. no secret in image。

---

## 23. 一次任务的推荐执行方式

### 23.1 审计

- 读取相关 Contract、Repository、Service、Route 和测试；
- 搜索现有能力；
- 明确事实路径；
- 识别真实缺口；
- 不重复建设。

### 23.2 收窄

一个任务最多：

- 一个主要目标；
- 三到八个核心交付；
- 一条主 Smoke；
- 明确不做项。

不要把后端、UI、真实模型、可观测性和文档大重构默认塞入同一任务。

### 23.3 实现

- 先核心 Contract 和边界；
- 再 Repository/Service；
- 再 API/UI；
- 再测试；
- 再 Smoke；
- 最后文档。

### 23.4 验证

优先运行目标包测试，再运行：

```bash
pnpm dar check all
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

按影响范围运行相关 Suite。

### 23.5 汇报

必须说明：

1. 开始 HEAD 和 origin/main；
2. 基线状态；
3. 完成内容；
4. 修改文件；
5. 真实数据路径；
6. 测试和 Smoke；
7. 未运行项；
8. 未完成项；
9. 风险；
10. Git 状态。

---

## 24. Definition of Done

任务只有在以下条件满足时才能声明完成：

- 目标闭环真实实现；
- 代码通过 lint；
- 代码通过 typecheck；
- 相关测试通过；
- build 通过；
- Contract 更新；
- API Schema 更新；
- i18n 更新；
- Audit 和日志更新；
- Secret 未泄露；
- Tenant Isolation 保持；
- Mock Boundary 未破坏；
- Temporal Determinism 保持；
- Replay 按需要通过；
- Docker 按需要通过；
- 相关 Smoke 通过；
- 文档事实源更新；
- 没有未说明的 fallback；
- 没有将 skipped 写成 passed；
- 没有新增未批准生产服务；
- 没有擅自修改版本、Tag 或 Release。

---

## 25. 严格禁止清单

禁止：

- 新增第五个生产 app；
- 绕过 tool-gateway；
- Pi 直连外部系统；
- runtime-worker 直连业务 API；
- runtime-api 调 Chat Model；
- 在 Workflow 中执行 I/O；
- production 使用 memory/mock/default/sample fallback；
- production app import `devtools`；
- app 源码实现外部系统 Mock；
- 在前端提供可编辑 JSON 绕过可视化表单；
- 在 ModelPolicy 手填 raw gateway/model；
- API 返回模型 API Key；
- 日志或 Audit 记录 Secret；
- 保存 hidden chain-of-thought；
- 使用本地化文本参与授权、Hash、幂等或 Workflow 分支；
- 复制 DTO 到 App；
- 直接修改已发布资源；
- 使用 `latest`；
- 删除测试或 Replay Fixture 来掩盖问题；
- 使用 `|| true` 掩盖失败；
- 在没有真实证据时宣称 Real Gate 通过；
- 未经请求执行 commit、push、tag、release 或版本晋级；
- 在任务之外做大范围重构。
