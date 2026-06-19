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

## Pi Agent Runtime

`runtime-worker` owns the real Pi Agent Core integration. `piDurableAgentWorkflow`
supervises segment boundaries and `runPiSegmentActivity` creates/restores the Pi
`Agent`.

Runtime modes:

- `PI_AGENT_MODE=disabled`：不执行 agent。
- `PI_AGENT_MODE=deterministic`：development/test only，仍走真实 Pi Core，只替换模型流。
- `PI_AGENT_MODE=model_gateway`：生产模式，通过 `packages/model-client` 调本地/外部 Model Gateway。

Production rejects deterministic mode.

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
3. Workflow 使用 Temporal Signal 等待 runtime-api 传入 human decision，不轮询 DB；
4. runtime-api approve/reject 先幂等写入 DB，再向对应 workflow 发送 Signal；
5. approved 后，`commitToolActivity` 调 `tool-gateway /commit`；
6. rejected/cancelled/expired 后不 commit，workflow 返回 failed；
7. commit failed/denied 时 workflow 返回 failed。

Workflow 本体只调用 Activity proxy 并等待 deterministic Signal 条件，不直接访问 DB、HTTP、Pi、LLM、`Date.now` 或 `Math.random`。HTTP 调用 tool-gateway、DB 写 human task、DB 决策写入都在 Workflow 外部执行。

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

## AgentRun / AgentStep APIs

runtime-worker persists:

- `agent_run.workflow_run_id` for the current Temporal run;
- cumulative model turns, tool calls, handoffs and token usage;
- `agent_step.authoritative_tool_result_refs_json`;
- `agent_step.human_task_ids_json`;
- `agent_step.context_snapshot_before_ref`;
- `agent_step.context_snapshot_after_ref`;
- `agent_step.handoff_refs_json`.

`AgentStepRepository.updateBoundaryResult` updates the same stable row after
tool, human input or handoff boundaries are resolved.

## Budget, Continue-As-New and Handoff

`piDurableAgentWorkflow` carries `AgentBudgetLedger` and passes only remaining
budget into each Pi segment. Tool proposals, including denied proposals, consume
tool-call budget. Handoff consumes handoff budget.

`PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW` is loaded through an Activity and
applied after a persisted boundary snapshot. Continue-As-New carries
`agent_run_id`, execution plan ref, context snapshot ref, budget ledger,
segment index and safe request context.

`handoff_to_workflow` starts a child `ConfigDrivenWorkflow` only when the exact
target `FlowExecutionPlan` ref is listed in `allowed_handoffs`. Parent/child refs
are stored on the corresponding AgentStep.

## Environment

- `DATABASE_URL`：DB FlowSpec Activity 使用的 PostgreSQL URL。
- `RUNTIME_WORKER_MODE=mock|temporal`：worker mode。
- `TOOL_GATEWAY_URL` / `TOOL_GATEWAY_BASE_URL`：tool Activity 调用 tool-gateway。
- `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`：Temporal worker 连接参数。
- `PI_AGENT_MODE=disabled|deterministic|model_gateway`：Pi runtime mode。
- `PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW`：safe-boundary Continue-As-New threshold。
- `MODEL_GATEWAY_BASE_URL` / `MODEL_GATEWAY_API_KEY` / `MODEL_GATEWAY_MODEL`：model_gateway mode。
