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
- runtime-worker 只把 `Accept-Language` 传播给 Tool Gateway 用于响应和审计展示，不把 locale 用于 Workflow 分支、幂等键、hash 或策略判断。

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

## Tenant Policy Runtime

- `ConfigDrivenWorkflow` 只在 Activity 中加载 root policy snapshot，不在 Workflow 中直接访问 DB。
- Flow 中的 Agent step 会派生 `flow_agent_child` snapshot，并把 child snapshot ref/hash 传给 `piDurableAgentWorkflow`。
- Agent handoff 会派生 `workflow_handoff` 或 `nested_handoff` snapshot，再启动目标 `ConfigDrivenWorkflow` child。
- Tool 执行仍必须通过 Activity -> Tool Gateway；worker 的 policy check 是 fail-fast，不是最终授权边界。
- Admission id 随 TaskRun/Workflow/AgentRun 传递，workflow terminal 状态通过 Activity 释放 admission。

## Evaluation Runtime

- `EvaluationRunWorkflow` 只做确定性编排，加载 run plan、候选 fidelity、case batch、aggregate、comparison 和 gate decision 都必须通过 Activity。
- `EvaluationCaseWorkflow` 启动 `piDurableAgentWorkflow` 时必须传递 `execution_context_type=evaluation`、`evaluation_run_id`、`evaluation_case_id`、`evaluation_execution_plan_ref` 和 `evaluation_execution_plan_hash`。
- Pi 子 workflow 只能把上述 evaluation context 转交给 Activity -> Tool Gateway；不得直接绕过 Tool Gateway 或 Tenant Policy。
- Tool Gateway 是 Evaluation Tool Policy 的最终边界，`maximum_calls_per_case`、tenant allowlist、preview-only/sandbox-commit 和 redaction 必须在服务级 smoke 中验证。
- Temporal replay fixture 由真实 Evaluation smoke history 导出，不手工伪造。
