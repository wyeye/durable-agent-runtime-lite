# Architecture Overview

Durable Agent Runtime Lite 是一个通用 Agent Runtime 平台，不绑定业务领域。生产架构固定为四个 app：

1. `control-plane`
2. `runtime-api`
3. `runtime-worker`
4. `tool-gateway`

运行路径：

```text
User / Frontend / API / Webhook
  -> runtime-api
  -> Intent Router / Flow Router
  -> Temporal Workflow
  -> runtime-worker
  -> Pi Agent Loop, when needed
  -> tool-gateway
  -> External tools / APIs / MCP servers / Mock systems
```

核心边界：

- `runtime-api` 是唯一公共运行入口。
- `runtime-worker` 拥有 Temporal Workflow、Activity 和 Pi Runner 包装。
- Pi 是有界 Agent Loop，不是系统控制器。
- Pi 不直接访问 DB、Temporal Client、Tool Gateway、文件系统、shell、MCP 或业务 API。
- 所有工具调用都通过 `tool-gateway`。
- `tool-gateway` 是唯一外部工具和副作用边界。
- Temporal Workflow 代码保持确定性，外部调用放入 Activity。

Monorepo 使用 `apps/`、`packages/`、`devtools/`、`db/`、`infra/`、`tests/` 和 `docs/`，工作区由 `pnpm` workspace 管理。共享 DTO、schema、错误码和 API contract 归 `packages/contracts`；配置归 `packages/config`；DB 访问和 migration helper 归 `packages/db`。
