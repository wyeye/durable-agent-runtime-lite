# runtime-worker 开发计划

## 定位

`runtime-worker` 是执行面，负责 Temporal Workflow 和 Activity 的实际执行。它封装 Pi Runner、FlowSpec 解释器、模型适配、Human Task 等执行动作，但不直接访问业务系统，所有工具通过 Tool Gateway。

## 阶段计划

| 阶段 | 目标 | 主要任务 | 验收 |
|---|---|---|---|
| RW-M1 | Temporal 基线 | Worker 启动、Task Queue、健康检查、示例 Workflow | 本地可执行 Hello Workflow |
| RW-M2 | ConfigDrivenWorkflow | FlowSpec 加载、step 解释器、条件判断、状态记录 | 可解释执行 YAML FlowSpec |
| RW-M3 | Activity 层 | runAgent、invokeTool、createHumanTask、audit、loadSpec | Activity 可重试、可超时、可观测 |
| RW-M4 | Pi Runner | Pi 初始化、AgentSpec 加载、结构化输出、预算控制 | Pi 可返回 final/need_tool/handoff |
| RW-M5 | GenericAgentWorkflow | Agent Loop 兜底、工具中介执行、超步数转人工 | 未命中流程时可兜底回答 |
| RW-M6 | 异常与补偿 | Retry、compensation、cancel、timeout、人工接管 | 失败场景可恢复或转人工 |

## 重点 Workflow

1. `ConfigDrivenWorkflow`：解释执行 FlowSpec。
2. `GenericAgentWorkflow`：承载 Agent Loop 兜底。
3. `HumanTaskWorkflow` 或内嵌 Human Task 等待：通过 Signal/Update 完成人工确认。



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
