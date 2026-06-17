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
