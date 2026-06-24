# Governance Architecture

治理能力覆盖 Tenant Runtime Policy、Admission Control、Snapshot Lineage、Policy Enforcement、Evaluation Publish Gate 与 Audit。

关键事实：

- Tenant Runtime Policy 限制工具、模型、handoff、预算和并发。
- TaskRun、AgentRun、ToolCall 和 HumanTask 持有 policy snapshot ref/hash。
- Snapshot 是不可变运行事实，后续 policy 发布不改变已运行 workflow。
- Tenant Agent Admission 控制并发，异常恢复通过 reconcile 命令处理。
- Evaluation Gate 基于 candidate bundle hash、dataset hash、gate policy hash 和 evidence 状态决策发布。

审计要求：

- route decision、publish、rollback、tool invocation、human approval、policy denial、workflow failure 和 evaluation gate 都写 audit。
- Audit source of truth 是 `event_type` / `message_key` / `message_params`；`display_message` 是渲染结果。
