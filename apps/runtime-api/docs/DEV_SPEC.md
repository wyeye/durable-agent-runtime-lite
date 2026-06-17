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
