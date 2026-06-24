# Durable Agent Runtime Lite

当前平台版本：0.8.0。

Durable Agent Runtime Lite 是一个通用、生产取向的四应用 Agent Runtime 骨架。它把运行入口、持久化执行、工具副作用边界和运营控制台拆开，避免把业务系统、模型调用和工具调用混进同一个进程。

## 四应用

| App | 责任 |
| --- | --- |
| `apps/control-plane` | 能力运营控制台，管理 Registry、发布、评测、人审任务和审计查询。 |
| `apps/runtime-api` | 统一运行入口，处理请求上下文、路由、任务创建和 Temporal workflow 启动。 |
| `apps/runtime-worker` | Temporal Worker、Workflow/Activity、Pi Agent Loop 包装和模型网关调用。 |
| `apps/tool-gateway` | 唯一工具调用出口，负责 Manifest 校验、策略、幂等、确认和审计。 |

生产 app 只能是这四个。`devtools/mock-server` 与 `devtools/repo-cli` 都是开发/测试工具，不是生产服务。

## 核心能力

- DB-backed Registry 与不可变发布版本。
- Flow、Route、Tool、Agent、Prompt、Model Policy、Tenant Policy 和 Evaluation 管理。
- Temporal 持久化执行与 replay/crash recovery 验证。
- Pi Agent Core 分段运行，生产模型调用通过 DB-backed Model Gateway catalog。
- Tool Gateway 统一副作用边界，支持 mock sandbox adapter 和 `http_readonly` adapter。
- Tenant Runtime Policy、Snapshot Lineage、Admission Control、Audit 和 Evaluation Gate。
- `zh-CN` 单语首版国际化，机器字段保持稳定不翻译。

## 五分钟启动

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dar check all
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

本地基础设施：

```bash
corepack pnpm dar dev up
corepack pnpm dar db migrate
corepack pnpm dar db seed
corepack pnpm dar dev down
```

Docker 本地栈：

```bash
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml up --build
```

## 常用命令

```bash
corepack pnpm dar check all
corepack pnpm dar check docs
corepack pnpm dar check mocks
corepack pnpm dar smoke list
corepack pnpm dar smoke suite core
corepack pnpm dar smoke suite agent
corepack pnpm dar smoke suite governance
corepack pnpm dar smoke suite ui
corepack pnpm dar replay test
```

Real/manual smoke 仅用于本地或 self-hosted runner：

```bash
corepack pnpm dar smoke suite real
```

## 文档入口

所有活跃文档从 [docs/README.md](docs/README.md) 进入。重点入口：

- [架构概览](docs/architecture/overview.md)
- [本地开发](docs/guides/local-development.md)
- [Docker 部署](docs/guides/docker-deployment.md)
- [测试、Replay 与恢复](docs/operations/testing-replay-and-recovery.md)
- [当前状态](docs/project/current-status.md)
- [路线图与发布](docs/project/roadmap-and-release.md)

## 当前状态

当前版本仍为 `0.8.0`，migration head 为 `001_baseline.sql`。本仓库保持四应用架构，未创建 tag 或 GitHub Release。本轮命令、Mock 边界与文档事实源由 `devtools/repo-cli`、`devtools/mock-server` 和 `docs/README.md` 收口。
