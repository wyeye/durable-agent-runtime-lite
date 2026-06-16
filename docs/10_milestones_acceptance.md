# 10 里程碑与验收清单

## MVP 验收链路

1. 在 control-plane 新建 ToolManifest。
2. 新建 AgentSpec 与 Prompt。
3. 新建 FlowSpec 与 RouteSpec。
4. 通过校验并发布。
5. runtime-api 热加载路由。
6. 用户请求命中预置流程。
7. runtime-worker 执行 ConfigDrivenWorkflow。
8. Pi 生成建议或下一步动作。
9. Tool Gateway 执行只读工具。
10. 高风险动作进入 Human Task。
11. 人工确认后 Tool Gateway 执行提交。
12. control-plane 可查看任务轨迹和审计。

## 项目级 Definition of Done

- 4 个生产 app 均有健康检查、配置校验、结构化日志。
- 关键接口均有 OpenAPI 或 Schema 文件。
- 关键事件均有版本化 Schema。
- 关键数据表均有迁移脚本。
- Router 支持规则命中和配置热加载。
- Temporal 可执行 ConfigDrivenWorkflow 和 GenericAgentWorkflow。
- Tool Gateway 具备 Schema 校验、Policy、Audit、幂等。
- 至少 2 条示例 Flow 端到端跑通。
- 文档和 README 能指导新成员本地启动。
