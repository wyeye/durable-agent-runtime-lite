# control-plane 开发计划

## 定位

`control-plane` 是能力运营端和控制面。它负责 Registry 管理、发布治理、灰度、回滚、Human Task 审批和运行观测；它不执行工具、不复制 Temporal/Human Task 状态机，也不直连真实业务系统。

生产 app 仍只有：

```text
control-plane
runtime-api
runtime-worker
tool-gateway
```

## 已完成阶段

| 阶段 | 状态 | 内容 |
|---|---|---|
| CP-R1 + CP-R2 | 完成 | Registry 生命周期、DB migration、Repository、Validation/Release Service、发布/灰度/回滚/禁用 |
| CP-R3 + CP-R4 | 完成 | Fastify 管理 API、标准错误、OpenAPI、Header Auth/RBAC、BFF、单容器 API+静态托管、API smoke |
| CP-R5 + CP-R6 | 完成 | React 能力运营页面、Registry 管理页、发布操作页、Human Task 审批、运行查询、Dashboard、UI smoke |

## 当前页面清单

| 路由 | 能力 |
|---|---|
| `/dashboard` | Registry published 数量、Human Task/TaskRun 统计、最近 release、failed task、Audit、ToolCall |
| `/registry/flows` | FlowSpec 列表、版本、JSON draft 编辑、validate、publish、gray、rollback、deprecate、disable、版本对比 |
| `/registry/routes` | RouteSpec 阈值、关键词、样例、绑定 Flow、gray allowlist、版本治理 |
| `/registry/tools` | ToolManifest 风险等级、side_effect、adapter、L3/L4 提示、版本治理 |
| `/registry/agents` | AgentSpec prompt_ref、allowed_tools、预算、依赖 validate |
| `/registry/prompts` | PromptDefinition 内容、变量、密钥风险 validate |
| `/releases` | 发布历史查询、详情、metadata/validation_result、rollback 入口 |
| `/human-tasks` | pending/approved/rejected 查询、详情、preview payload、approve/reject |
| `/task-runs` | TaskRun 列表、状态/flow/workflow/task_run 查询、详情跳转 |
| `/audit-events` | Audit 查询和 metadata 查看 |
| `/tool-calls` | ToolCall 查询、preview/result/idempotency 查看 |

## 当前验收

- 前端不再使用硬编码 sample 数据作为默认渲染源。
- 所有页面请求走 control-plane 同源 `/api/v1/...`。
- 前端不直接请求 runtime-api 或 tool-gateway；BFF 页面只使用 `/api/v1/operations/...`。
- 开发环境可用 Identity Panel 设置 `user_id`、`tenant_id`、`roles`。
- production 不默默伪造管理员；缺少身份由 API 返回 401，页面显示友好错误。
- auditor 只显示只读视图；写操作由 RBAC guard 隐藏或由 API 返回 403。
- 发布、灰度、回滚、废弃、禁用、Human Task approve/reject 都有二次确认。
- `pnpm dar smoke run control-plane-ui` 提供浏览器级 UI smoke。

## 后续不在本阶段

1. 低代码流程画布和拖拽编排器。
2. 企业 SSO。
3. 真实 Pi / 真实模型调用。
4. 真实业务系统 adapter 和凭据管理。
5. 随机灰度或复杂流量分配。
