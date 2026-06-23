# Durable Agent Runtime Lite

当前平台版本：0.8.0。技术栈基线仍按 `docs/11_technology_stack_matrix.md` 的 v1.5 矩阵执行。

R0/AR-2A 状态：

- AR-1 Platform Core 已冻结为 `0.8.0`，见 `docs/PLATFORM_CORE_BASELINE.md`。
- AR-2A 当前为 `IMPLEMENTATION COMPLETE`：本地容器化 Ollama final/readonly/L3 gate 通过，mock-server 和 deterministic Pi 未参与，远端 `origin/main@27598fe` 的 CI 与 Integration 均通过。没有创建 tag、GitHub Release 或版本晋级，平台版本仍为 `0.8.0`。
- AR-2B 当前为 `AR-2B DEVELOPMENT COMPLETE`：Evaluation 数据模型、评分/回归比较、Temporal 评测 runner、Registry Publish Gate、backend Evaluation smoke/replay 脚本、React Evaluation UI、Integration 步骤和 self-hosted Ollama Evaluation Gate 均已接入；四镜像容器化 Ollama final/readonly/L3 runtime smoke、真实 Ollama Evaluation smoke、backend Evaluation 回归和 DB 证据已通过。没有创建 tag、GitHub Release 或版本晋级，平台版本仍为 `0.8.0`。

Durable Agent Runtime Lite 是一个四应用通用 Agent Runtime 骨架：

| App                   | 责任                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `apps/control-plane`  | 能力运营端，Registry 管理 API、运营查询 BFF、OpenAPI、Vite 静态资源托管                              |
| `apps/runtime-api`    | 统一运行入口，规则 Router、TaskRun、Workflow Starter                                                 |
| `apps/runtime-worker` | Temporal Worker 入口、ConfigDrivenWorkflow、GenericAgentWorkflow、Activity、Pi Agent Core 分段运行时 |
| `apps/tool-gateway`   | 工具唯一出口，Manifest、Schema 校验、幂等、审计、mock adapter 与通用只读 HTTP adapter                |

核心约束：生产 app 只能是以上 4 个；工具调用必须经 `tool-gateway`；`runtime-worker` 不直连业务系统；Temporal Workflow 只保留确定性编排。

## 本地启动

```bash
corepack enable
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

`pnpm dev` 会通过 Turborepo 并行启动各 workspace 的 dev 脚本。当前 MVP 开发默认使用 memory RouteSpec、mock workflow starter、禁用的 Pi Agent 模式和 mock tool adapter；未提供 `.env` 时会加载本地安全默认值。真实 Pi Core 运行在 `runtime-worker` 内，`PI_AGENT_MODE=deterministic` 仅用于 development/test，production 只允许 `PI_AGENT_MODE=model_gateway`。

可选配置：

```bash
cp .env.example .env
# 真实 Temporal 启动时再改为 temporal
RUNTIME_API_WORKFLOW_STARTER=mock
RUNTIME_WORKER_MODE=mock
RUNTIME_API_ROUTE_SOURCE=memory
TOOL_GATEWAY_REGISTRY_SOURCE=memory
DEFAULT_LOCALE=zh-CN
LOG_LOCALE=zh-CN
```

`RUNTIME_API_WORKFLOW_STARTER=temporal` 会通过 Temporal Client 启动 workflow；`RUNTIME_WORKER_MODE=temporal` 会启动真实 Temporal Worker。默认 mock 模式不要求本地 Temporal 可用。

国际化第一版只开放 `zh-CN`。API 使用请求 `Accept-Language` 并在不支持语言时回退到 `zh-CN`；运行日志使用部署级 `LOG_LOCALE`；Audit 以 `message_key` 和 `message_params` 作为事实源。详见 `docs/55_fullstack_i18n.md`。

Control-plane 可写配置使用可视化表单作为唯一编辑入口，JSON 仅保留只读查看、复制和下载。Registry、Evaluation Dataset、Case 和 Gate Policy 表单最终仍生成现有 Contract 对象并通过服务端校验；精确版本引用不使用 `latest` 或默认资源兜底。详见 `docs/56_visual_configuration.md`。

Model Catalog MVP 将 OpenAI-compatible 模型网关从单一部署级环境变量迁移为 DB-backed Registry 数据：`control-plane` 管理 `ModelGatewayProfile` 和 `ModelDefinition`，API Key 使用 `MODEL_CREDENTIAL_MASTER_KEY` 做 AES-256-GCM 加密后存 PostgreSQL；`ModelPolicy` 只能选择已发布模型的精确 `model_ref`；`runtime-worker` 在 AgentRun 时从 DB 动态解析网关、模型和当前凭据。新增网关、切换模型、跨网关 fallback 和凭据轮换均不需要重启 worker。详见 `docs/58_model_gateway_mvp.md` 和 `docs/59_model_catalog.md`。

Tool Gateway 支持 `http_readonly` 通用只读 HTTP Tool Adapter。该 adapter 只允许 GET、L0/L1、`side_effect=false`，固定 `base_url` / `path` 来自 ToolManifest，调用参数只能映射为 query；生产默认只允许 HTTPS 和 `TOOL_HTTP_ALLOWED_HOSTS` 中的显式 Host。凭据只通过 `env:TOOL_SECRET_*` 引用读取，不写入 ToolManifest、DB、日志或响应。详见 `docs/61_http_readonly_tool_adapter.md`。

DB-backed registry 模式：

```bash
DATABASE_URL=postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime
RUNTIME_API_ROUTE_SOURCE=db
TOOL_GATEWAY_REGISTRY_SOURCE=db
RUNTIME_API_WORKFLOW_STARTER=mock
RUNTIME_WORKER_MODE=mock
```

DB 模式下不会回退到内置 sample RouteSpec 或 ToolManifest。缺失 RouteSpec 会返回明确未命中，缺失 ToolManifest 会返回 `TOOL_NOT_FOUND`。生产或 Docker smoke 路径必须使用 DB source；不能用 `defaultRouteSpecs`、`sample_flow@1` 或 memory tool registry 伪造成功。

发布 Flow 时会生成不可变 `FlowExecutionPlan`。runtime-api 启动 `ConfigDrivenWorkflow` 时只传 `execution_plan_ref`，runtime-worker 按该 ref 加载计划，不在运行时选择 `latest` Flow/Agent/Prompt/Tool 版本。

## 本地基础设施

```bash
pnpm dev:infra
pnpm db:migrate
pnpm seed:examples
```

或使用脚本：

```bash
./scripts/dev-up.sh
./scripts/db-migrate.sh
./scripts/dev-down.sh
```

## Docker Compose

Docker 使用多个 app-specific Dockerfile，不使用根目录 Dockerfile；build context 必须是仓库根目录。

```bash
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml build runtime-api runtime-worker tool-gateway control-plane
docker compose -f infra/docker-compose.yml up -d postgres valkey temporal temporal-ui
corepack pnpm db:migrate
corepack pnpm seed:examples
docker compose -f infra/docker-compose.yml up -d tool-gateway runtime-worker runtime-api control-plane
```

也可以使用宿主机脚本执行 DB 初始化：

```bash
./scripts/docker-db-migrate.sh
./scripts/docker-seed-examples.sh
```

这些命令在宿主机运行 `corepack pnpm db:migrate` / `corepack pnpm seed:examples`，默认连接 Docker Compose 暴露的 PostgreSQL：`postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime`。

默认端口：

为避免和本机常见 PostgreSQL / Redis 冲突，Docker Compose 默认将 PostgreSQL 映射到 `15432`、Valkey 映射到 `16380`；可通过 `.env` 中的 `POSTGRES_HOST_PORT`、`VALKEY_HOST_PORT` 等变量调整。

| Service        | URL                   |
| -------------- | --------------------- |
| control-plane  | http://localhost:3100 |
| runtime-api    | http://localhost:3000 |
| tool-gateway   | http://localhost:3200 |
| runtime-worker | http://localhost:3300 |
| Temporal UI    | http://localhost:8233 |
| PostgreSQL     | localhost:15432       |
| Valkey         | localhost:16380       |

Docker Compose 中真实 smoke 相关环境变量：

```text
runtime-api:
  RUNTIME_API_ROUTE_SOURCE=db
  RUNTIME_API_WORKFLOW_STARTER=temporal
  DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
  TEMPORAL_ADDRESS=temporal:7233

runtime-worker:
  RUNTIME_WORKER_MODE=temporal
  DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
  TEMPORAL_ADDRESS=temporal:7233
  TOOL_GATEWAY_URL=http://tool-gateway:3200
  PI_AGENT_MODE=disabled

tool-gateway:
  TOOL_GATEWAY_REGISTRY_SOURCE=db
  DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
  TOOL_HTTP_ALLOWED_HOSTS=
  TOOL_HTTP_ALLOW_INSECURE_LOCALHOST=false

control-plane:
  CONTROL_PLANE_AUTH_MODE=header
  RUNTIME_API_URL=http://runtime-api:3000
  TOOL_GATEWAY_URL=http://tool-gateway:3200
  DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
```

Pi runtime smoke 使用 dev/test override 启动本地 mock gateway：

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml up -d mock-server tool-gateway runtime-worker runtime-api control-plane
corepack pnpm smoke:pi-readonly-e2e
corepack pnpm smoke:pi-l3-e2e
corepack pnpm smoke:pi-user-input-e2e
corepack pnpm smoke:pi-handoff-e2e
corepack pnpm smoke:pi-restart-resume-e2e
corepack pnpm smoke:pi-worker-crash-resume-e2e
corepack pnpm smoke:pi-model-gateway-e2e
corepack pnpm smoke:model-catalog-multi-gateway-e2e
corepack pnpm smoke:http-readonly-tool-e2e
```

Pi smoke 使用真实 Pi Agent Core。deterministic 模式只替换模型流，不替换 Pi 内循环；model-gateway smoke 使用 `devtools/mock-server` 的 OpenAI-compatible `/v1/chat/completions` 返回结构化 tool call。
`smoke:http-readonly-tool-e2e` 不走 `/v1/agent-tasks`，而是通过 control-plane API 创建并发布 Prompt、ModelPolicy、Agent、Tool、Flow、Route 和 Tenant Runtime Policy，再验证 `/v1/router/preview` 的 semantic match 与 `/v1/tasks -> ConfigDrivenWorkflow -> Agent Child Workflow -> Pi -> Tool Gateway -> http_readonly` 主链路。该 smoke 仍使用 `devtools/mock-server` 作为外部 HTTP API 模拟器，并检查 ToolCall、Audit、Idempotency、Tenant Policy Snapshot 和外部 request count。

受保护 live Model Gateway probe：

```bash
LIVE_MODEL_GATEWAY_ENABLED=true \
LIVE_MODEL_GATEWAY_BASE_URL=https://example-model-gateway \
LIVE_MODEL_GATEWAY_API_KEY=... \
LIVE_MODEL_GATEWAY_MODEL=... \
corepack pnpm smoke:model-gateway-live-final-e2e
```

`smoke:model-gateway-live-readonly-e2e` 和 `smoke:model-gateway-live-l3-e2e` 会要求真实 OpenAI-compatible provider 返回结构化 tool call。未设置 `LIVE_MODEL_GATEWAY_ENABLED=true` 时这些命令输出 `skipped: true`，不会伪装成 live pass。

本地 Ollama 真实模型验证分两层：

```bash
ollama list
ollama show qwen2.5:7b-instruct-q4_K_M
corepack pnpm ollama:probe
docker compose -f infra/docker-compose.yml -f infra/docker-compose.ollama.yml config
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm runtime:assert-containerized
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm smoke:ollama-containerized-e2e
corepack pnpm smoke:evaluation-ollama-e2e
corepack pnpm smoke:ollama-runtime-final-e2e
corepack pnpm smoke:ollama-runtime-readonly-e2e
corepack pnpm smoke:ollama-runtime-l3-e2e
```

`ollama:probe` 只验证宿主机 Ollama OpenAI-compatible API、精确模型 `qwen2.5:7b-instruct-q4_K_M`、final 文本、结构化 tool call、tool result 后续轮次、JSON object 和 abort。三个 `smoke:ollama-runtime-*` 命令走 `/v1/agent-tasks` 的真实 runtime 路径，要求 DB、Temporal、runtime-worker、runtime-api 和 tool-gateway 使用等效的 Ollama Model Gateway 配置运行；它们不是裸模型 probe。

`smoke:ollama-containerized-e2e` 是 AR-2A-RC 的本地人工 release gate。它要求四个生产 app 都来自 Docker 镜像，只有 Ollama 在宿主机运行；它会断言 `/version` 的 build SHA、`runtime-worker` 的 `model_gateway` / `local-ollama` 环境、`mock-server` 未运行，并检查 DB 中 final/readonly/L3 的 ModelCall、ToolCall、HumanTask、Audit 和 Idempotency 证据。未提交工作树本地验证时使用 `BUILD_SHA="$(git rev-parse HEAD)-dirty"`。

`smoke:evaluation-ollama-e2e` 是 AR-2B-FINAL-GATE 的真实 Ollama Evaluation gate。它只运行三个 Evaluation Run：final、readonly 和 L3 sandbox。路径固定为 control-plane API -> Temporal `EvaluationRunWorkflow` / `EvaluationCaseWorkflow` -> Pi Agent Core -> 宿主机 Ollama OpenAI-compatible API -> Tool Gateway -> Evidence Collector -> Scoring -> Gate Decision -> PostgreSQL。它断言 `provider=local-ollama`、exact model `qwen2.5:7b-instruct-q4_K_M`、Evaluation Worker running、无 mock/deterministic 证据、readonly/L3 两轮 ModelCall、readonly Tool 一次、L3 HumanTask 一个且 approved、L3 commit 一次、Evidence complete 和 Gate Decision exact candidate bundle hash。详见 `docs/57_ollama_evaluation_gate.md`。

Ollama 不会被普通 GitHub Hosted CI 下载或运行。可选 workflow `.github/workflows/ollama-runtime.yml` 仅支持 `workflow_dispatch`，并要求 `runs-on: [self-hosted, ollama]` 的 runner 已安装 Ollama 且已拉取 `qwen2.5:7b-instruct-q4_K_M`。该 workflow 保留 runtime final/readonly/L3，并在其后执行真实 Ollama Evaluation gate；失败即 job 失败，不打 tag，不创建 release，不修改版本。

`smoke:pi-worker-crash-resume-e2e` 会真实 `SIGKILL` compose 里的
`runtime-worker`，在 worker 停止期间通过 runtime-api 写入 waiting-user /
L3 approval Human Task 信号，随后重启 worker 并断言同一个 Temporal
workflow 恢复完成，且没有重复 Human Task、AgentStep、审计事件或 commit
幂等记录。

Temporal replay 门禁使用真实导出的 history：

```bash
PI_CRASH_RESULT_FILE=artifacts/pi-worker-crash-resume/result.json \
  corepack pnpm smoke:pi-worker-crash-resume-e2e
TEMPORAL_REPLAY_SMOKE_RESULT_FILE=artifacts/pi-worker-crash-resume/result.json \
  corepack pnpm temporal:export-replay-fixtures
corepack pnpm test:temporal-replay
```

Evaluation backend gate smoke 使用同一 Docker/Temporal/PostgreSQL 栈，并要求 `runtime-worker` 处于 `PI_AGENT_MODE=model_gateway` 的 mock OpenAI-compatible 模式：

```bash
corepack pnpm smoke:evaluation-framework-e2e
corepack pnpm smoke:evaluation-regression-gate-e2e
corepack pnpm smoke:evaluation-publish-gate-e2e
corepack pnpm temporal:export-evaluation-replay-fixtures
corepack pnpm test:temporal-replay
```

三个 smoke 共用 `scripts/smoke-evaluation-backend-e2e.ts`，覆盖 control-plane API、runtime-api、Temporal EvaluationRun/Case workflow、Pi Durable Agent Runtime、Tool Gateway、Evidence Collector、Scoring 和 PostgreSQL。React Evaluation UI smoke 使用同一栈和 mock OpenAI-compatible model gateway：

```bash
corepack pnpm smoke:evaluation-ui-e2e
```

Evaluation UI 路径包括 `/evaluation/datasets`、`/evaluation/runs`、`/evaluation/gates` 和 Registry Prompt/Agent/ModelPolicy Gate Card。页面只调用同源 `/api/v1/*`，不直接访问 runtime-api、tool-gateway 或数据库；smoke 的 setup 仅准备 UI 无法创建的 immutable candidate snapshot / execution plan。真实 Ollama Evaluation 由 `smoke:evaluation-ollama-e2e` 和 self-hosted workflow 覆盖。

Tenant Policy production-closure smoke:

```bash
corepack pnpm smoke:tenant-policy-e2e
corepack pnpm smoke:tenant-policy-snapshot-e2e
corepack pnpm smoke:tenant-concurrency-e2e
corepack pnpm smoke:tenant-flow-agent-e2e
corepack pnpm smoke:tenant-handoff-lineage-e2e
corepack pnpm smoke:tenant-policy-crash-snapshot-e2e
corepack pnpm smoke:tenant-admission-reconcile-e2e
```

这些 smoke 使用真实 PostgreSQL、Temporal、runtime-worker、runtime-api 和 Tool Gateway。失败时脚本只输出安全摘要；成功时输出 `ok: true` 和稳定标识。

## MVP smoke path

默认 memory smoke path：

1. `POST /v1/tasks` 到 `runtime-api`，文本包含 `mvp` 或 `知识搜索`。
2. `runtime-api` 命中 memory `sample_flow`，创建 TaskRun，并使用 mock Workflow Starter 返回 workflow id。
3. `runtime-worker` 通过 `execution_plan_ref` 加载不可变 FlowExecutionPlan，跑通 `input.normalize -> knowledge.search -> agent.plan -> record.write.mock`。
4. `record.write.mock` 是 L3 side-effect 工具，真实路径会走 `preview -> human confirm -> commit`；不能通过直接 `invoke` 执行副作用。

DB Registry -> mock execution 窄闭环：

```bash
corepack pnpm dev:infra
corepack pnpm db:migrate
corepack pnpm seed:examples
DATABASE_URL=postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime \
  corepack pnpm smoke:db-registry
```

该 smoke 脚本会 seed examples，调用 `runtime-api /v1/router/preview` 和 `/v1/tasks`，并断言 TaskRun 已写入 DB。

真实 Docker / PostgreSQL / Temporal 端到端 smoke：

```bash
docker compose -f infra/docker-compose.yml up -d postgres valkey temporal temporal-ui
corepack pnpm db:migrate
corepack pnpm seed:examples
docker compose -f infra/docker-compose.yml up -d tool-gateway runtime-worker runtime-api control-plane
corepack pnpm smoke:temporal-db-e2e
corepack pnpm smoke:control-plane-api-e2e
```

`smoke:temporal-db-e2e` 会检查：

1. `runtime-api`、`tool-gateway`、`runtime-worker` 的 `/healthz`；
2. `POST /v1/router/preview` 命中 DB seed 的 `sample_route`，请求文本使用 `db-smoke`，不会被内置 `defaultRouteSpecs` 命中；
3. `POST /v1/tasks` 返回真实 Temporal `workflow_id` 和 `task_run_id`；
4. `GET /v1/tasks/:taskRunId` 轮询到 `completed`；
5. 遇到 L3 `record.write.mock` 时查询 pending `human_task`，调用 runtime-api approve；runtime-api 先写 DB 决策，再向对应 Temporal workflow 发送 Human Task Signal；
6. DB `task_run` 状态为 `completed`；
7. DB `audit_event` 有 `tool.preview`、`human_task.approve`、`tool.commit`；
8. DB `tool_call_log` 中 L3 工具从 `pending_confirmation` 进入 `committed`；
9. DB `idempotency_record` 有对应工具调用幂等记录。

成功时会输出 JSON，包含 `ok: true`、`task_run_id`、`workflow_id`、最终状态、human tasks、tool call logs、工具 audit events 和 idempotency records。失败时会输出 `workflow_id`、`task_run_id`、DB task_run、最近 audit event、human task、tool call log 和错误摘要；优先检查 task queue、`TOOL_GATEWAY_URL`、DB seed 是否存在、ToolManifest schema 是否与 FlowSpec step input 匹配。

control-plane API smoke 会额外验证 header auth、RBAC、Registry draft/validate/publish/rollback、Flow + Route 联合发布、release history、runtime-api router preview 命中新发布 Route，以及 BFF Human Task / Audit / ToolCall 查询。

control-plane UI smoke 会在浏览器中打开 `http://localhost:3100`，设置开发身份，验证 Dashboard、Registry、Release、Human Task、TaskRun、Audit、ToolCall 页面，并通过 UI approve 一个 L3 pending Human Task：

```bash
corepack pnpm smoke:control-plane-ui-e2e
corepack pnpm smoke:evaluation-ui-e2e
```

如果本机没有 Playwright Chromium：

```bash
corepack pnpm --filter @dar/control-plane exec playwright install chromium
```

## Control-plane API

control-plane 生产容器是单个 Node/Fastify 进程，监听 `PORT=3100`，同时提供 API 和前端静态资源：

```text
GET /healthz
GET /readyz
GET /openapi.json
GET /docs
/api/v1/*
```

React 运营页面：

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
/policy-snapshots
/tenant-admissions
```

页面只请求同源 `/api/v1/...`。Registry 页面支持 JSON draft 编辑、validate、publish、gray、rollback、deprecate、disable、release history 和版本对比；Operations 页面通过 control-plane BFF 查询 runtime-api/tool-gateway。Evaluation 页面支持 Dataset/Case、Run/Result/Comparison、Gate Policy/Decision/Override，并在 Prompt/Agent/ModelPolicy 详情区显示 Gate Card；Gate 是否允许发布始终以后端 exact hash 检查为准。

Snapshot 和 Admission 是只读运行时运营资源，不是可编辑 Registry Resource：

```text
GET /api/v1/tenant-runtime-policy-snapshots
GET /api/v1/tenant-runtime-policy-snapshots/:snapshotId
GET /api/v1/tenant-agent-admissions
GET /api/v1/tenant-agent-admissions/:admissionId
```

身份来自 `x-user-id`、`x-tenant-id`、`x-roles` 和可选 `x-request-id`。生产环境必须使用 `CONTROL_PLANE_AUTH_MODE=header`，不会默认启用管理员身份。

主要管理 API：

```text
/api/v1/flows
/api/v1/routes
/api/v1/tools
/api/v1/agents
/api/v1/prompts
/api/v1/releases
/api/v1/releases/flow-route
/api/v1/operations/*
```

完整说明见：

- `docs/16_control_plane_api.md`
- `docs/17_control_plane_security.md`

## L3 高风险工具治理

风险等级：

- `L0`：本地纯计算或无敏感读取。
- `L1`：只读查询，例如 `knowledge.search`。
- `L2`：生成建议或草稿，是否需要确认由 ToolManifest 策略决定。
- `L3`：有副作用工具，例如 `record.write.mock`，必须 `preview -> human confirm/reject -> commit`。
- `L4`：高敏感工具，默认 deny，并写 audit。

调用模式：

- `invoke`：只适合 L0/L1，L3 直接 invoke 返回 `needs_confirmation`，不会执行副作用。
- `preview`：校验 ToolManifest 和参数，生成待执行计划，写 `tool_call_log=pending_confirmation` 和 `audit_event=tool.preview`，不执行副作用。
- `commit`：必须带 `tool_call_id` 和 commit `idempotency_key`；L3 只有在对应 `human_task` 已 approved 后才执行 adapter。成功后写 `tool_call_log=committed`、`audit_event=tool.commit`、`idempotency_record=succeeded`；同 key 同参数 replay，同 key 不同参数 conflict。

人工确认 API：

```bash
curl "http://localhost:3000/v1/human-tasks?tenant_id=default&user_id=smoke_user&task_run_id=<task_run_id>&status=pending"
curl -X POST "http://localhost:3000/v1/human-tasks/<human_task_id>/approve" \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"default","user_id":"smoke_user","decision_reason":"local approval"}'
curl -X POST "http://localhost:3000/v1/human-tasks/<human_task_id>/reject" \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"default","user_id":"smoke_user","decision_reason":"not safe"}'
```

`runtime-api` 只写 human task 决策和审计，不调用 `tool-gateway`。`runtime-worker` 的 Activity 会观察 DB 中的 human decision，approved 后再通过 `tool-gateway` commit；rejected 时 workflow 不 commit，并把 `task_run` 标为 failed。

## 关键命令

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm dev
pnpm db:migrate
pnpm seed:examples
pnpm smoke:db-registry
pnpm smoke:temporal-db-e2e
pnpm smoke:control-plane-api-e2e
pnpm smoke:control-plane-ui-e2e
pnpm smoke:evaluation-ui-e2e
pnpm smoke:pi-readonly-e2e
pnpm smoke:pi-l3-e2e
pnpm smoke:pi-user-input-e2e
pnpm smoke:pi-handoff-e2e
pnpm smoke:pi-restart-resume-e2e
pnpm smoke:pi-worker-crash-resume-e2e
pnpm smoke:pi-model-gateway-e2e
pnpm smoke:tenant-policy-e2e
pnpm smoke:tenant-policy-snapshot-e2e
pnpm smoke:tenant-concurrency-e2e
pnpm smoke:tenant-flow-agent-e2e
pnpm smoke:tenant-handoff-lineage-e2e
pnpm smoke:tenant-policy-crash-snapshot-e2e
pnpm smoke:tenant-admission-reconcile-e2e
```

Runtime readiness:

- `runtime-api /readyz` probes config, DB, Route Registry, Temporal, Tenant Policy repository, and production auth mode.
- `tool-gateway /readyz` probes config, DB, Tool Registry, Tenant Policy Snapshot store, and service-token configuration.
- `/healthz` remains process liveness only.

Tool Gateway debug endpoint:

- `GET /v1/idempotency-records/:key` is disabled by default with `TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED=false`.
- When enabled it requires `idempotency:debug`, not `tool_call:read`.
- Returned records are masked.

## DB-backed Source of Truth

已落地的 repository：

- `FlowDefinitionRepository`：读写 `flow_definition`，读取 `published` / `gray` FlowSpec。
- `RouteConfigRepository`：读写 `flow_route_config`，runtime-api DB 模式读取 published RouteSpec。
- `ToolManifestRepository`：读写 `tool_manifest`，tool-gateway DB 模式读取 published ToolManifest。
- `TaskRunRepository`：`create/get/updateStatus/updateWorkflowStart`，runtime-api DB 模式写入和查询 TaskRun，runtime-worker Activity 回写 `running` / `completed` / `failed`。
- `AuditEventRepository`：`append/list`，tool-gateway DB 模式写 audit。
- `IdempotencyRecordRepository`：`get/insert/replayOrConflict`，tool-gateway DB 模式做 replay/conflict。
- `HumanTaskRepository`：`create/get/list/approve/reject/cancel/expire`，记录 `decided_by`、`decided_at`、`decision_reason`。
- `ToolCallLogRepository`：记录 L3 preview/approval/reject/commit 状态和 preview/result JSON。
- `TenantRuntimePolicyRepository`：租户运行时策略生命周期。
- `TenantRuntimePolicySnapshotRepository`：不可变 root/child snapshot 和 lineage 查询。
- `TenantAgentAdmissionRepository`：租户 agent 并发 admission、release、reconcile。

FlowSpec snapshot ref 格式：

```text
db://flow/{flow_id}/versions/{version}
```

该 ref 锁定 workflow 启动时的 FlowSpec 版本，运行中 workflow 不受新版本发布影响。

## 文档

优先阅读：

1. `AGENTS.md`
2. `docs/00_overall_plan.md`
3. `docs/01_engineering_standards.md`
4. `docs/10_milestones_acceptance.md`
5. `docs/13_docker_deployment.md`
6. `docs/15_registry_lifecycle.md`
7. `docs/16_control_plane_api.md`
8. `docs/17_control_plane_security.md`
9. `docs/19_pi_segmented_agent_runtime.md`
10. `docs/20_pi_runtime_hardening.md`
11. `docs/21_model_gateway_contract.md`
12. `docs/24_tenant_runtime_policy.md`
13. `docs/30_tenant_admission_control.md`
14. `docs/31_policy_snapshot_lineage.md`
15. `docs/32_policy_enforcement.md`
16. `docs/33_runtime_audit_taxonomy.md`
17. `docs/34_runtime_readiness.md`
