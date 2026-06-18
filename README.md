# Durable Agent Runtime Lite v1.5

Durable Agent Runtime Lite 是一个四应用通用 Agent Runtime 骨架：

| App | 责任 |
|---|---|
| `apps/control-plane` | 能力运营端，Flow / Tool / Agent / TaskRun / Audit 最小页面 |
| `apps/runtime-api` | 统一运行入口，规则 Router、TaskRun、Workflow Starter |
| `apps/runtime-worker` | Temporal Worker 入口、ConfigDrivenWorkflow、GenericAgentWorkflow、Activity、Pi mock |
| `apps/tool-gateway` | 工具唯一出口，Manifest、Schema 校验、幂等、审计、mock adapter |

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

`pnpm dev` 会通过 Turborepo 并行启动各 workspace 的 dev 脚本。当前 MVP 开发默认使用 memory RouteSpec、mock workflow starter、mock Pi Runner 和 mock tool adapter；未提供 `.env` 时会加载本地安全默认值。

可选配置：

```bash
cp .env.example .env
# 真实 Temporal 启动时再改为 temporal
RUNTIME_API_WORKFLOW_STARTER=mock
RUNTIME_WORKER_MODE=mock
RUNTIME_API_ROUTE_SOURCE=memory
TOOL_GATEWAY_REGISTRY_SOURCE=memory
```

`RUNTIME_API_WORKFLOW_STARTER=temporal` 会通过 Temporal Client 启动 workflow；`RUNTIME_WORKER_MODE=temporal` 会启动真实 Temporal Worker。默认 mock 模式不要求本地 Temporal 可用。

DB-backed registry 模式：

```bash
DATABASE_URL=postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime
RUNTIME_API_ROUTE_SOURCE=db
TOOL_GATEWAY_REGISTRY_SOURCE=db
RUNTIME_API_WORKFLOW_STARTER=mock
RUNTIME_WORKER_MODE=mock
```

DB 模式下不会回退到内置 sample RouteSpec 或 ToolManifest。缺失 RouteSpec 会返回明确未命中，缺失 ToolManifest 会返回 `TOOL_NOT_FOUND`。生产或 Docker smoke 路径必须使用 DB source；不能用 `defaultRouteSpecs`、`sample_flow@1` 或 memory tool registry 伪造成功。

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

| Service | URL |
|---|---|
| control-plane | http://localhost:3100 |
| runtime-api | http://localhost:3000 |
| tool-gateway | http://localhost:3200 |
| runtime-worker | http://localhost:3300 |
| Temporal UI | http://localhost:8233 |
| PostgreSQL | localhost:15432 |
| Valkey | localhost:16380 |

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

tool-gateway:
  TOOL_GATEWAY_REGISTRY_SOURCE=db
  DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
```

## MVP smoke path

默认 memory smoke path：

1. `POST /v1/tasks` 到 `runtime-api`，文本包含 `mvp` 或 `知识搜索`。
2. `runtime-api` 命中 memory `sample_flow`，创建 TaskRun，并使用 mock Workflow Starter 返回 workflow id。
3. `runtime-worker` 可通过 FlowSpec snapshot/ref 跑通 `input.normalize -> knowledge.search -> agent.plan -> record.write.mock`。
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
docker compose -f infra/docker-compose.yml up -d tool-gateway runtime-worker runtime-api
corepack pnpm smoke:temporal-db-e2e
```

`smoke:temporal-db-e2e` 会检查：

1. `runtime-api`、`tool-gateway`、`runtime-worker` 的 `/healthz`；
2. `POST /v1/router/preview` 命中 DB seed 的 `sample_route`，请求文本使用 `db-smoke`，不会被内置 `defaultRouteSpecs` 命中；
3. `POST /v1/tasks` 返回真实 Temporal `workflow_id` 和 `task_run_id`；
4. `GET /v1/tasks/:taskRunId` 轮询到 `completed`；
5. 遇到 L3 `record.write.mock` 时查询 pending `human_task`，调用 runtime-api approve；
6. DB `task_run` 状态为 `completed`；
7. DB `audit_event` 有 `tool.preview`、`human_task.approve`、`tool.commit`；
8. DB `tool_call_log` 中 L3 工具从 `pending_confirmation` 进入 `committed`；
9. DB `idempotency_record` 有对应工具调用幂等记录。

成功时会输出 JSON，包含 `ok: true`、`task_run_id`、`workflow_id`、最终状态、human tasks、tool call logs、工具 audit events 和 idempotency records。失败时会输出 `workflow_id`、`task_run_id`、DB task_run、最近 audit event、human task、tool call log 和错误摘要；优先检查 task queue、`TOOL_GATEWAY_URL`、DB seed 是否存在、ToolManifest schema 是否与 FlowSpec step input 匹配。

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
```

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
