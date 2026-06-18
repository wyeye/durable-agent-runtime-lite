# runtime-worker API 说明

本文件用于沉淀 runtime-worker 对外 API、事件和契约。正式开发时应与 `packages/contracts` 保持同步。

## Runtime Mode

`runtime-worker` exposes health endpoints for local operation and owns Temporal workflow/activity execution.

- `RUNTIME_WORKER_MODE=mock`：只启动 health server 和 mock worker handle，不连接 Temporal。
- `RUNTIME_WORKER_MODE=temporal`：连接 Temporal 并注册 workflow/activity worker。

真实 Docker smoke 使用：

```text
RUNTIME_WORKER_MODE=temporal
DATABASE_URL=postgres://dar:dar_local_password@postgres:5432/durable_agent_runtime
TEMPORAL_ADDRESS=temporal:7233
TEMPORAL_NAMESPACE=default
TOOL_GATEWAY_URL=http://tool-gateway:3200
```

worker 与 runtime-api 共享 task queue：`runtime-worker-main`。

## Endpoints

### `GET /healthz`

返回 app 健康状态。

### `GET /readyz`

返回基础 readiness：

```json
{
  "status": "ready",
  "app": "runtime-worker",
  "checks": {
    "config": "ok",
    "temporal_worker": "mock"
  }
}
```

`RUNTIME_WORKER_MODE=temporal` 时 `temporal_worker` 返回 `temporal`。

## FlowSpec Snapshot Ref

`ConfigDrivenWorkflow` 不直接访问 DB。它通过 `loadFlowSpecByRefActivity` Activity 加载 FlowSpec。

支持的 DB ref：

```text
db://flow/{flow_id}/versions/{version}
```

Activity 从 `flow_definition` 表读取指定 `flow_id + version`，仅允许 `published` / `gray` 版本。找不到时抛出明确错误，不回退到 sample flow。

`sample_flow@1` 仅保留为非 production 的开发/测试兼容 ref；`NODE_ENV=production` 或 `APP_ENV=production` 时不会加载该内置 FlowSpec。

## Tool Step Input Mapping

Flow step 的 `input` 字段可作为最小 input mapping：

```json
{
  "id": "knowledge_search",
  "type": "tool",
  "tool": "knowledge.search",
  "input": {
    "query": "${input.query}",
    "previous": "${state.steps.retrieve_context.result}",
    "literal": "fixed"
  }
}
```

支持：

- `${input.query}`
- `${state.steps.retrieve_context.result}`
- `${state}`
- literal string/object/array values

未配置 `input` 时保持向后兼容，tool step 接收当前 state。

Seed 的 sample FlowSpec 显式映射：

```json
{
  "knowledge_search": { "query": "${input.text}" },
  "record_write": { "record": "${state.steps.knowledge_search.result}" }
}
```

这样真实 ToolManifest schema 校验会使用实际 workflow input 和上一步工具结果，不依赖默认参数或 mock fallback。

## L3 Tool Governance

普通 L0/L1 tool step 通过 `invokeToolActivity` 调用 `tool-gateway /invoke`。

当 FlowSpec tool step 标记 `risk_level: "L3"` 时，`ConfigDrivenWorkflow` 的解释器改走治理流程：

1. `previewToolActivity` 调 `tool-gateway /preview`，生成 `tool_call_id`，不执行副作用；
2. `createHumanTaskActivity` 通过 `HumanTaskRepository` 写入 pending `human_task`，同时把 `task_run` 标为 `waiting_human`；
3. `waitForHumanTaskDecisionActivity` 轮询 DB 中的 human decision；
4. approved 后，`commitToolActivity` 调 `tool-gateway /commit`；
5. rejected/cancelled/expired 后不 commit，workflow 返回 failed；
6. commit failed/denied 时 workflow 返回 failed。

Workflow 本体只调用 Activity proxy，不直接访问 DB、HTTP、Pi、LLM、`Date.now` 或 `Math.random`。HTTP 调用 tool-gateway、DB 写 human task、DB 查询 decision 都在 Activity 中执行。

Seed 的 `sample_flow` 中 `record.write.mock` 是 L3：

```json
{
  "id": "record_write",
  "type": "tool",
  "name": "record.write.mock preview -> human_confirm -> commit",
  "tool": "record.write.mock",
  "mode": "preview_commit",
  "risk_level": "L3"
}
```

## TaskRun status writeback

`ConfigDrivenWorkflow` 和 `GenericAgentWorkflow` 通过 `updateTaskRunStatusActivity` 回写 DB：

- workflow 开始执行后：`running`
- workflow 等待人工时：`waiting_human`
- 人工决策已返回、继续执行时：`running`
- workflow 成功完成后：`completed`
- workflow 失败后：`failed`，并记录 `error_code` / `error_message`

状态回写在 Activity 中通过 `TaskRunRepository` 完成，Workflow 本体不直接访问 DB、HTTP、LLM、Pi、`Date.now` 或 `Math.random`。

## Environment

- `DATABASE_URL`：DB FlowSpec Activity 使用的 PostgreSQL URL。
- `RUNTIME_WORKER_MODE=mock|temporal`：worker mode。
- `TOOL_GATEWAY_URL` / `TOOL_GATEWAY_BASE_URL`：tool Activity 调用 tool-gateway。
- `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`：Temporal worker 连接参数。
