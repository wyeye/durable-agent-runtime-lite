# runtime-worker API 说明

本文件用于沉淀 runtime-worker 对外 API、事件和契约。正式开发时应与 `packages/contracts` 保持同步。

## Runtime Mode

`runtime-worker` exposes health endpoints for local operation and owns Temporal workflow/activity execution.

- `RUNTIME_WORKER_MODE=mock`：只启动 health server 和 mock worker handle，不连接 Temporal。
- `RUNTIME_WORKER_MODE=temporal`：连接 Temporal 并注册 workflow/activity worker。

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

## Environment

- `DATABASE_URL`：DB FlowSpec Activity 使用的 PostgreSQL URL。
- `RUNTIME_WORKER_MODE=mock|temporal`：worker mode。
- `TOOL_GATEWAY_URL` / `TOOL_GATEWAY_BASE_URL`：tool Activity 调用 tool-gateway。
