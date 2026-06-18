# runtime-api API 说明

本文件用于沉淀 runtime-api 对外 API、事件和契约。正式开发时应与 `packages/contracts` 保持同步。

## Source of Truth

`runtime-api` 支持两种 RouteSpec 来源：

- `RUNTIME_API_ROUTE_SOURCE=memory`：默认开发/测试模式，使用内置 `defaultRouteSpecs`。
- `RUNTIME_API_ROUTE_SOURCE=db`：从 PostgreSQL `flow_route_config` 表读取 `published` / `gray` RouteSpec。

`NODE_ENV=production` 或 `APP_ENV=production` 时必须配置 `RUNTIME_API_ROUTE_SOURCE=db`，避免生产路径使用内置 sample route。

DB 模式不会回退到 `defaultRouteSpecs`。如果 DB 中没有可命中的 RouteSpec，Router 返回 `agent_fallback`，原因可能为 `no_published_route_match` 或 `low_confidence_rule_match`。

TaskRun 在 DB 模式下写入 `task_run` 表，`GET /v1/tasks/:taskRunId` 也从 `task_run` 表读取。

真实 Docker smoke 使用：

```text
RUNTIME_API_ROUTE_SOURCE=db
RUNTIME_API_WORKFLOW_STARTER=temporal
DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
TEMPORAL_ADDRESS=temporal:7233
TEMPORAL_NAMESPACE=default
```

`runtime-api` 不直接调用 `tool-gateway`，也不执行工具。它只做路由、创建 `task_run`、启动 Temporal workflow。真实工具调用由 `runtime-worker` Activity 通过 `tool-gateway` 完成。

`GET /readyz` 会返回当前 `route_source` 和 `workflow_starter`，Docker smoke 中应分别为 `db` 和 `temporal`。

## Endpoints

### `POST /v1/router/preview`

请求体使用 `routerPreviewRequestSchema`。响应体为标准响应：

```json
{
  "success": true,
  "data": {
    "route_decision": {
      "decision": "matched",
      "flow_id": "sample_flow",
      "flow_version": 1,
      "confidence": 0.9,
      "slots": {}
    },
    "candidates": []
  },
  "error": null
}
```

DB 模式下只读取 DB 中已发布 RouteSpec，不使用 sample route fallback。

### `POST /v1/tasks`

请求体使用 `runTaskRequestSchema`。响应体使用 `runTaskResponseSchema`。

命中 Flow 时，workflow start request 会锁定：

- `flow_id`
- `flow_version`
- `flow_snapshot_ref`。DB 模式格式为 `db://flow/{flow_id}/versions/{version}`；memory 模式仅用于开发/测试兼容，格式为 `{flow_id}@{version}`。

未命中 Flow 时启动 `GenericAgentWorkflow` mock/Temporal starter。

DB source 下的创建顺序：

1. 使用 DB RouteSpec 路由；
2. 创建 `task_run`，初始状态为 `queued`；
3. 使用 `RUNTIME_API_WORKFLOW_STARTER=temporal` 时通过 Temporal Client 启动 workflow；
4. 将 workflow start 信息写回 DB；
5. 如果 workflow 启动失败，将 `task_run` 更新为 `failed_to_start`，并记录 `error_code=WORKFLOW_START_FAILED` 与安全错误消息。

### `GET /v1/tasks/:taskRunId`

返回 `taskRunSchema`。DB 模式从 `task_run` 表读取；memory 模式只读取进程内测试/开发 store。

## Environment

- `DATABASE_URL`：DB 模式使用的 PostgreSQL URL。
- `RUNTIME_API_ROUTE_SOURCE=memory|db`：RouteSpec source。
- `RUNTIME_API_WORKFLOW_STARTER=mock|temporal`：workflow starter。
- `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`：Temporal starter 使用。

## Local DB Registry Flow

```bash
corepack pnpm db:migrate
corepack pnpm seed:examples
RUNTIME_API_ROUTE_SOURCE=db RUNTIME_API_WORKFLOW_STARTER=mock corepack pnpm --filter @dar/runtime-api dev
```

## Temporal DB smoke

```bash
corepack pnpm db:migrate
corepack pnpm seed:examples
corepack pnpm smoke:temporal-db-e2e
```

smoke 会调用 `/v1/router/preview` 和 `/v1/tasks`。请求文本包含 `db-smoke`，该关键词只存在于 seed 的 DB RouteSpec 中，用于证明没有命中内置 `defaultRouteSpecs`。
