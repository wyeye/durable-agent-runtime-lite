# runtime-api 开发计划

## 定位

`runtime-api` 是线上统一运行入口，负责接收用户请求、构造上下文、完成意图识别和流程路由，并启动 Temporal Workflow。它要足够薄，不承载长任务执行和业务系统访问。

## 阶段计划

| 阶段 | 目标 | 主要任务 | 验收 |
|---|---|---|---|
| RA-M1 | API 框架 | 请求标准化、鉴权占位、Session、统一响应 | `/health` 和 `/v1/tasks` 可用 |
| RA-M2 | Router 基础 | 规则路由、Flow 元数据缓存、RouteSpec 加载 | 按 action_id/关键词命中流程 |
| RA-M3 | 语义召回 | Embedding Client、pgvector 查询、Top-K 候选过滤 | 可从样例召回候选 Flow |
| RA-M4 | LLM 判别 | 调用 Worker/Pi 或模型网关完成候选判别 | 输出 flow_id、confidence、slots |
| RA-M5 | Workflow Starter | Temporal Client、启动 ConfigDrivenWorkflow / GenericAgentWorkflow | 请求可创建 task_run 与 workflow |
| RA-M6 | 流式与查询 | SSE/WebSocket、任务状态查询、结果查询 | 前端可实时看到任务进度 |

## 关键链路

1. 接收 `RunTaskRequest`。
2. 标准化用户、租户、渠道、会话上下文。
3. 执行规则匹配。
4. 执行向量召回与候选过滤。
5. 必要时调用 Pi/LLM Top-K 判别。
6. 低置信度则澄清或进入 GenericAgentWorkflow。
7. 高置信度则启动对应 FlowSpec 版本的 ConfigDrivenWorkflow。
