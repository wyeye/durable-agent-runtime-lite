# Control Plane Architecture

`control-plane` 是能力运营控制台和管理 API，负责：

- FlowSpec、RouteSpec、ToolManifest、AgentSpec、Prompt 和 Model Policy。
- Model Gateway Profile 与 Model Definition。
- Publish、gray release、rollback、disable。
- Human Task、Audit、Runtime dashboard、Evaluation 和 visual configuration。

规则：

- 不实现 runtime execution logic。
- 前端不直接调用工具。
- 不暴露、回显、记录或渲染模型 API key 与加密凭据字段。
- Writable Registry 与 Evaluation 配置使用可视化表单；JSON 仅只读。
- ModelPolicy 选择已发布 ModelDefinition 的精确 `model_ref`，不再手工输入 raw gateway/model target。
- Flow 编辑维持当前 ordered `steps` 语义，不引入任意 DAG。

Tenant Policy Snapshot 和 Tenant Agent Admission 是 runtime operations resource，控制台可读但不创建、更新或删除。
