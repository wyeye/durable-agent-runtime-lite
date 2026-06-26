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

本地控制台登录：

```text
URL: http://127.0.0.1:3100/login
默认密码: dar-local-login
推荐账号: dev_admin
默认租户: development
```

`devtools/repo-cli` 是统一开发命令入口，不是生产 app：

```bash
corepack pnpm dar --help
corepack pnpm dar check docs
corepack pnpm dar check mocks
corepack pnpm dar smoke list
```

`devtools/mock-server` 是外部系统 mock 的唯一服务，覆盖 Model Gateway、Embedding Gateway 和外部业务 HTTP API 模拟。它只用于 development/test compose，不进入 production compose。
