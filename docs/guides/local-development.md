# Local Development

安装与基础检查：

```bash
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
corepack pnpm dar iam seed-local
corepack pnpm dar dev down
```

本地聊天走 Pi（Ollama）：

```bash
corepack pnpm ollama:probe
corepack pnpm dar dev up --ollama
corepack pnpm dar db migrate
corepack pnpm dar db seed
corepack pnpm dar iam seed-local
DATABASE_URL='postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime' \
LOCAL_REAL_TENANT_ID='development' \
LOCAL_REAL_OPERATOR_ID='dev_operator' \
corepack pnpm exec tsx devtools/repo-cli/src/scripts/seed-local-real-runtime.ts
```

说明：

- `pnpm dar dev up --ollama` 会在 `infra/docker-compose.yml` 基础上叠加 `infra/docker-compose.ollama.yml`。
- `seed-local-real-runtime.ts` 会为 `development` 租户写入本地真实 Pi 资源，包括 `local_real_pi_route` 和 `local_real_pi_flow`。
- 当前本地真实 Pi 路由已覆盖 `chat` channel，控制台聊天和 `/api/v1/conversations` 可以命中这条链路。
- 关闭本地 Ollama 开发栈使用 `corepack pnpm dar dev down --ollama`。

本地控制台登录：

```text
URL: http://127.0.0.1:3100/login
默认密码: dar-local-login
推荐账号: dev_admin
默认租户: development
```

聊天验证建议：

```text
进入控制台后，可直接在聊天界面发送“真实pi”“ollama”或“local-real”等测试文案，确认消息会创建 TaskRun 并进入 Pi 工作流。
```

`devtools/repo-cli` 是统一开发命令入口，不是生产 app：

```bash
corepack pnpm dar --help
corepack pnpm dar check docs
corepack pnpm dar check mocks
corepack pnpm dar smoke list
```

`devtools/mock-server` 是外部系统 mock 的唯一服务，覆盖 Model Gateway、Embedding Gateway 和外部业务 HTTP API 模拟。它只用于 development/test compose，不进入 production compose。
