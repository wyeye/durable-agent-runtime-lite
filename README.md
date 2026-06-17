# Durable Agent Runtime Lite v1.5

Durable Agent Runtime Lite 是一个四应用通用 Agent Runtime 骨架：

| App | 责任 |
|---|---|
| `apps/control-plane` | 能力运营端，Flow / Tool / Agent / TaskRun / Audit 最小页面 |
| `apps/runtime-api` | 统一运行入口，规则 Router、TaskRun、Workflow Starter mock |
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

`pnpm dev` 会通过 Turborepo 并行启动各 workspace 的 dev 脚本。当前 MVP 默认使用 mock workflow starter、mock Pi Runner 和 mock tool adapter；未提供 `.env` 时会加载本地安全默认值。

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

DB 模式下不会回退到内置 sample RouteSpec 或 ToolManifest。缺失 RouteSpec 会返回明确未命中，缺失 ToolManifest 会返回 `TOOL_NOT_FOUND`。

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
scripts/docker-build-all.sh
docker compose -f infra/docker-compose.yml up --build
# 或
scripts/docker-run-local.sh
```

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

## MVP smoke path

默认 memory smoke path：

1. `POST /v1/tasks` 到 `runtime-api`，文本包含 `mvp` 或 `知识搜索`。
2. `runtime-api` 命中 memory `sample_flow`，创建 TaskRun，并使用 mock Workflow Starter 返回 workflow id。
3. `runtime-worker` 可通过 FlowSpec snapshot/ref 跑通 `input.normalize -> knowledge.search -> agent.plan -> record.write.mock`。
4. `tool-gateway` 通过 `POST /v1/tools/:toolName/invoke` 执行 `knowledge.search` 或 `record.write.mock`，并记录 audit event。

DB Registry -> mock execution 窄闭环：

```bash
corepack pnpm dev:infra
corepack pnpm db:migrate
corepack pnpm seed:examples
DATABASE_URL=postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime \
  corepack pnpm smoke:db-registry
```

该 smoke 脚本会 seed examples，调用 `runtime-api /v1/router/preview` 和 `/v1/tasks`，并断言 TaskRun 已写入 DB。

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
```

## DB-backed Source of Truth

已落地的 repository：

- `FlowDefinitionRepository`：读写 `flow_definition`，读取 `published` / `gray` FlowSpec。
- `RouteConfigRepository`：读写 `flow_route_config`，runtime-api DB 模式读取 published RouteSpec。
- `ToolManifestRepository`：读写 `tool_manifest`，tool-gateway DB 模式读取 published ToolManifest。
- `TaskRunRepository`：`create/get/updateStatus`，runtime-api DB 模式写入和查询 TaskRun。
- `AuditEventRepository`：`append/list`，tool-gateway DB 模式写 audit。
- `IdempotencyRecordRepository`：`get/insert/replayOrConflict`，tool-gateway DB 模式做 replay/conflict。

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
