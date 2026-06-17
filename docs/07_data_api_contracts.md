# 07 数据模型与接口契约

## 核心实体

- `FlowSpec`：编排定义，发布后不可变。
- `RouteSpec`：路由定义，包含关键词、样例、阈值、适用角色和渠道。
- `AgentSpec`：Agent 能力边界，包含 Prompt、模型策略、工具白名单、预算。
- `ToolManifest`：工具定义，包含风险、Schema、Adapter、权限策略。
- `TaskRun`：一次任务运行实例。
- `WorkflowRun`：Temporal 执行实例。
- `ToolCallLog`：工具调用日志。
- `HumanTask`：人工确认、审批、补充信息任务。

## 版本原则

- 所有 Spec 均使用 `id + version + sha256`。
- 发布版本不可变。
- 新版本发布只影响新请求，运行中的 Workflow 继续使用启动时版本。
- 回滚通过路由版本指针完成，不修改历史版本。

## 事件契约

推荐事件：

```text
FlowPublished
FlowDisabled
RouteIndexUpdated
ToolManifestPublished
AgentSpecPublished
HumanTaskCreated
HumanTaskResolved
ToolInvokeCompleted
TaskRunCompleted
TaskRunFailed
```

事件必须包含：`event_id`、`tenant_id`、`occurred_at`、`source_app`、`schema_version`、`payload`。
