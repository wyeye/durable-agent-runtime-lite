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



# runtime-api 开发规范

## 模块划分

```text
modules/request-normalizer
modules/session
modules/router
modules/route-index
modules/embedding
modules/llm-judge
modules/workflow-starter
modules/task-query
modules/streaming
```

## Router 规则

路由结果必须是以下之一：

```ts
type RouteDecision =
  | { decision: 'matched'; flowId: string; version: number; confidence: number; slots: Record<string, unknown> }
  | { decision: 'need_clarify'; question: string; candidates: CandidateFlow[] }
  | { decision: 'agent_fallback'; agentId: string; reason: string }
  | { decision: 'reject'; reason: string };
```

## 缓存规范

- Flow 路由缓存以 `flow_id + version` 为键。
- `FlowPublished` 事件触发热加载。
- 热加载失败不影响已有缓存，但要告警。
- `published` 与 `gray` 版本选择逻辑必须可审计。

## Temporal 启动规范

- `workflowId` 使用：`task-${tenant_id}-${task_run_id}`。
- 启动参数包含 `flow_id`、`flow_version`、`flow_snapshot_ref`、`flow_sha256`。
- Workflow 启动失败要标记 `task_run.status = failed_to_start`。

## 禁止事项

- 禁止在 runtime-api 直接执行工具调用。
- 禁止在 runtime-api 直接访问业务系统。
- 禁止把完整长文档塞入 Workflow input，只传对象引用。

## 测试要求

- 路由规则单测。
- 向量召回集成测试。
- LLM 判别契约测试。
- Workflow Starter 集成测试。
