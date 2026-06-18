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

L3 工具的人审决策也由 `runtime-api` 提供最小 API 写 DB。`runtime-api` 只更新 `human_task` / `audit_event` / `tool_call_log`，不会调用 `tool-gateway` commit；commit 仍由 `runtime-worker` Activity 在观察到 approved 后执行。

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
- `execution_plan_ref`
- `flow_sha256`

DB source 未命中 Flow 时不会启动默认 Agent workflow；memory/mock 开发模式仍可使用本地 fallback。

DB source 下的创建顺序：

1. 使用 DB RouteSpec 路由；
2. 解析已发布 Flow 对应的不可变 `FlowExecutionPlan`；
3. 创建 `task_run`，记录 `execution_plan_ref`，初始状态为 `queued`；
4. 使用 `RUNTIME_API_WORKFLOW_STARTER=temporal` 时通过 Temporal Client 启动 workflow；
5. 将 workflow start 信息写回 DB；
6. 如果 workflow 启动失败，将 `task_run` 更新为 `failed_to_start`，并记录 `error_code=WORKFLOW_START_FAILED` 与安全错误消息。

### `GET /v1/tasks/:taskRunId`

返回 `taskRunSchema`。DB 模式从 `task_run` 表读取；memory 模式只读取进程内测试/开发 store。

### `GET /v1/human-tasks`

查询人工任务。query 使用 `humanTaskListRequestSchema`：

```text
tenant_id=default
user_id=smoke_user
task_run_id=<optional>
status=pending|approved|rejected|...
```

响应体使用 `humanTaskListResponseSchema`。

### `GET /v1/human-tasks/:humanTaskId`

query 使用 `humanTaskGetRequestSchema`，必须带 `tenant_id` 和 `user_id`。tenant 不匹配时返回 `HUMAN_TASK_NOT_FOUND`。

### `POST /v1/human-tasks/:humanTaskId/approve`

请求体使用 `humanTaskDecisionRequestSchema`：

```json
{
  "tenant_id": "default",
  "user_id": "approver_1",
  "decision_reason": "local approval",
  "payload": {}
}
```

成功后：

- `human_task.status=approved`；
- 写入 `decided_by`、`decided_at`、`decision_reason`；
- 写 `audit_event=human_task.approve`；
- 如果 payload 中有关联 `tool_call_id`，将 `tool_call_log.status=approved`。

### `POST /v1/human-tasks/:humanTaskId/reject`

请求体同 approve。成功后：

- `human_task.status=rejected`；
- 写 `audit_event=human_task.reject`；
- 如果有关联 `tool_call_id`，将 `tool_call_log.status=rejected`；
- worker 观察到 rejected 后不会调用 `tool-gateway` commit，workflow 返回 failed。

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

L3 本地测试时，smoke 会在 task_run 进入 `waiting_human` 后调用 `/v1/human-tasks` 找到 pending 任务，并调用 approve API；随后 worker 继续 commit。
