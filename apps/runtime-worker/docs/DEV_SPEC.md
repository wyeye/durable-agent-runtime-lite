# runtime-worker 开发规范

## 模块划分

```text
src/workflows/configDrivenWorkflow.ts
src/workflows/genericAgentWorkflow.ts
src/workflows/humanTaskWorkflow.ts
src/activities/loadFlowSpec.ts
src/activities/index.ts
src/activities/invokeTool.ts
src/activities/createHumanTask.ts
src/activities/writeAudit.ts
src/interpreter/flowInterpreter.ts
src/interpreter/conditionEvaluator.ts
src/agent/pi-agent-adapter.ts
src/agent/deferred-pi-tool.ts
src/agent/model-gateway-pi-stream.ts
```

## Temporal 确定性规范

Workflow 代码中禁止：

- 直接调用 HTTP、数据库、文件系统。
- 直接调用 LLM 或 Pi。
- 使用非确定性的随机数、当前时间、无序遍历。

上述能力必须放入 Activity。Workflow 只保留确定性编排、状态判断、Signal 等待和 Child Workflow 启动。

## Activity 规范

- 所有 Activity 必须设置 `startToCloseTimeout`。
- 外部调用必须设置重试策略与最大重试次数。
- 有副作用 Activity 必须携带 `idempotency_key`。
- Activity 返回结果不得包含超大对象，长文本和附件存对象存储并返回引用。

## Pi 输出规范

Pi Agent Core 输出会在 runtime-worker 内转换为受控 Segment 结果。对外状态只允许：

```text
final, need_tool, need_user, handoff_to_workflow, failed
```

`need_tool` 只能提出工具调用建议，不能直接执行工具。

Deferred Pi tools 只能产生 proposal，不得持有 Tool Gateway、DB、Temporal Client、文件系统、shell 或 MCP 能力。真实工具调用必须走 Temporal Workflow -> Activity -> Tool Gateway。

## AR-1.1 运行时要求

- 每个 AgentRun 必须使用不可变 `agent_execution_plan_ref` 和 plan hash。
- Segment 之间必须累计 `AgentBudgetLedger`。
- Agent tool idempotency key 使用 `agent:{agent_run_id}:segment:{segment_index}:call:{call_id}:{operation}`。
- Context Snapshot 使用执行计划的 `max_context_bytes`。
- Continue-As-New 只允许在工具/人审/用户输入/handoff 边界完全处理并持久化 snapshot 后执行。
- `handoff_to_workflow` 只能启动 allowed handoff 中的精确 `ConfigDrivenWorkflow` child。
- production 只允许 `PI_AGENT_MODE=model_gateway`；deterministic stream 仅限 development/test。

## 测试要求

- Workflow 单元测试使用 Temporal testing environment。
- FlowSpec 解释器单测覆盖条件、跳转、失败、补偿。
- Pi Adapter 使用 deterministic stream 和 local Model Gateway mock 做契约测试。
- Tool Gateway 调用使用 Mock Server 做集成测试。
