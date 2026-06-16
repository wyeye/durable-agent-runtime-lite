# 09 安全与可观测规范

## 安全规范

1. 统一身份上下文：每次请求必须携带租户、用户、角色、组织、会话、渠道。
2. 最小权限：Router 下发给 Agent 的工具必须是本次任务允许的最小集合。
3. 工具级权限：Tool Gateway 对每次调用重新鉴权，不信任上游服务透传结论。
4. 数据脱敏：敏感字段在工具输出侧脱敏，日志只记录摘要或哈希。
5. 人工确认：L2 及以上动作按策略进入确认；L3 必须 preview -> confirm -> commit。
6. 审计不可缺失：工具调用、发布、回滚、人工确认必须记录审计。

## 可观测规范

统一使用 OpenTelemetry 语义：

```text
trace: request -> route -> workflow -> activity -> agent -> tool -> adapter
metric: qps, latency, error rate, queue lag, token cost
log: structured json with trace_id and request_id
```

## Trace 传播

`runtime-api` 创建 `trace_id` 后，传递给 Temporal Workflow input、Activity headers、Tool Gateway headers、审计日志。

## 告警建议

- Tool Gateway L3 工具拒绝率异常。
- Workflow 失败率超过阈值。
- Router 低置信度率突增。
- Human Task 积压超过阈值。
- Agent 单任务 Token 成本超预算。
