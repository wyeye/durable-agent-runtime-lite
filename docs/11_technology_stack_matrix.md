# 11 技术栈定版与依赖版本矩阵 v1.5

## 1. 定版结论

v1.5 将 v1.4 中的“技术栈建议”升级为“默认落地基线”。服务边界不扩张，仍保持 4 个生产自研 app：`control-plane`、`runtime-api`、`runtime-worker`、`tool-gateway`；`devtools/mock-server` 仅用于本地开发。

| 层级 | 定版技术 | 版本/范围 | 说明 |
|---|---|---|---|
| 语言与运行时 | TypeScript + Node.js | TypeScript 5.x，Node.js 24 LTS | 后端、Worker、工具网关统一 TS；Node 22 LTS 可作为企业过渡版本 |
| 包管理 | pnpm workspace + Turborepo | pnpm 10.x，Turbo 2.x | 统一 apps/packages 构建、测试、发布 |
| 后端框架 | Fastify | 5.x | 四个 app 的 API 层统一使用 |
| 前端 | React + Vite + Ant Design | React 19.x，Vite 8.x，Ant Design 6.x | 仅 control-plane 使用 |
| Schema 与契约 | Zod + OpenAPI | Zod 4.x，OpenAPI 3.1 | API、事件、FlowSpec、AgentSpec、ToolManifest 统一契约 |
| 数据库 | PostgreSQL + pgvector | PostgreSQL 17 | Registry、运行态、审计热数据、路由语义召回 |
| 数据访问 | Kysely | 0.28.x+ | 不引入重 ORM，保留 SQL 可控性 |
| 缓存与轻事件 | Valkey | 8.x | Router 缓存、限流、发布事件、短会话状态 |
| 工作流 | Temporal TypeScript SDK | 1.x | runtime-worker 执行 Workflow 与 Activity |
| Agent Loop | Pi | 按仓库版本锁定 | 只由 runtime-worker 封装调用，不直接碰业务系统 |
| 工具治理 | 自研 tool-gateway | 当前项目内实现 | 工具唯一出口，统一权限、Schema、限流、审计、幂等 |
| 可观测 | OpenTelemetry + Pino | OTel JS，Pino 9.x | trace_id/request_id 贯穿四个 app |
| 测试 | Vitest + Playwright + Temporal Testing + Testcontainers | 按 lockfile 锁定 | 单测、契约、集成、E2E 分层执行 |

## 2. 每个 app 技术栈

### control-plane

- 前端：React 19.x、Vite 8.x、Ant Design 6.x、React Router 7.x、TanStack Query 5.x、Zustand 5.x。
- 可视化：React Flow / XYFlow 12.x；YAML/JSON 编辑使用 Monaco Editor。
- BFF/API：Fastify 5.x、Zod 4.x、OpenAPI 3.1。
- 数据访问：Kysely + PostgreSQL 17。
- 鉴权：企业 SSO/OIDC 网关注入 JWT，服务内使用 `jose` 校验与解析。
- 测试：Vitest、React Testing Library、Playwright。

### runtime-api

- HTTP 框架：Fastify 5.x。
- API 契约：Zod 4.x + OpenAPI 3.1。
- 路由召回：PostgreSQL 17 + pgvector + Kysely。
- 缓存与热加载事件：Valkey 8.x。
- Workflow 启动：Temporal Client。
- 流式输出：SSE 优先，WebSocket 二期再引入。
- 日志与可观测：Pino JSON + OpenTelemetry。

### runtime-worker

- Workflow：Temporal TypeScript SDK。
- Agent Loop：Pi，由 Worker 内部封装为 `runAgent` Activity。
- 模型调用：企业模型网关 Adapter；无企业网关时可用 LiteLLM HTTP Adapter。
- 工具调用：统一通过 Tool Gateway Client。
- 数据访问：Kysely，仅访问运行状态、Agent session、审计引用等表。
- 镜像：`node:24-bookworm-slim`，禁止 Alpine。
- 测试：Temporal testing env、Workflow replay、mocked tool-gateway。

### tool-gateway

- HTTP：Fastify 5.x。
- Schema：Zod 4.x + ToolManifest JSON Schema。
- 权限策略：一期自研策略 DSL；二期可接 OPA。
- 限流/熔断：Valkey 8.x + Fastify rate limit。
- 幂等：PostgreSQL idempotency table + Valkey 短缓存。
- 工具适配：HTTP Adapter、DB Adapter、MCP Adapter、Mock Adapter。
- 审计：PostgreSQL 热数据；ClickHouse 二期。

## 3. 版本锁定策略

- Node.js 使用 `.nvmrc`、`.node-version`、`engines` 与 Docker base image 锁定到 24 LTS。
- npm 依赖在 `package.json` 中锁主版本或安全小版本范围。
- `pnpm-lock.yaml` 是真实交付版本锁，进入测试环境后不允许绕过 lockfile 安装。
- 中间件镜像生产环境使用固定 digest；文档中镜像 tag 只用于开发基线。
- 小版本升级走依赖升级 PR，必须通过 lint、typecheck、unit、contract、e2e、Temporal replay check。

## 4. 本地环境

本地 Docker Compose 包含 PostgreSQL/pgvector、Valkey、Temporal、Temporal UI、mock-server。推荐命令：

```bash
corepack enable
pnpm install
pnpm dev:infra
pnpm db:migrate
pnpm dev
```
