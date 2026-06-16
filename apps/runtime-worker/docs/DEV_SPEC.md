# runtime-worker 开发规范

## 模块划分

```text
src/workflows/configDrivenWorkflow.ts
src/workflows/genericAgentWorkflow.ts
src/workflows/humanTaskWorkflow.ts
src/activities/loadFlowSpec.ts
src/activities/runAgent.ts
src/activities/invokeTool.ts
src/activities/createHumanTask.ts
src/activities/writeAudit.ts
src/interpreter/flowInterpreter.ts
src/interpreter/conditionEvaluator.ts
src/pi/piRunner.ts
src/model/modelAdapter.ts
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

Pi 输出必须是结构化 JSON，状态只允许：

```text
final, need_tool, need_user, handoff_to_workflow, failed
```

`need_tool` 只能提出工具调用建议，不能直接执行工具。

## 测试要求

- Workflow 单元测试使用 Temporal testing environment。
- FlowSpec 解释器单测覆盖条件、跳转、失败、补偿。
- Pi Runner 使用 Mock LLM 做契约测试。
- Tool Gateway 调用使用 Mock Server 做集成测试。
