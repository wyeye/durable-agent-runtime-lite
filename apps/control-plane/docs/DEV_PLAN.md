# control-plane 开发计划

## 定位

`control-plane` 是控制面和能力运营端，负责配置、发布、治理和运营观测。它不是线上执行核心路径，但它决定 Runtime 能加载什么能力、使用什么版本、哪些租户可见、哪些工具可调用。

## 阶段计划

| 阶段 | 目标 | 主要任务 | 验收 |
|---|---|---|---|
| CP-M1 | 基础框架 | 登录占位、菜单、权限上下文、Registry 数据模型 | 页面可访问，API 健康检查通过 |
| CP-M2 | Flow 管理 | FlowSpec 草稿、编辑、校验、版本列表、详情 | 可创建并保存 FlowSpec |
| CP-M3 | Route 管理 | RouteSpec、关键词、样例、负样例、阈值配置 | 发布后可生成 RouteIndex |
| CP-M4 | Tool/Agent/Prompt 管理 | ToolManifest、AgentSpec、Prompt 版本 | Flow 可引用 Tool/Agent/Prompt |
| CP-M5 | 发布灰度 | 校验、dry-run、发布、灰度、回滚 | 发布事件可被 runtime-api 热加载 |
| CP-M6 | Human Task 与看板 | 待确认任务、审批、任务轨迹、调用统计 | 可完成人工确认闭环 |

## 当前后端治理批次状态

已完成 CP-R1 + CP-R2 后端基础：

1. `packages/contracts` 定义统一 lifecycle：`draft`、`validated`、`published`、`gray`、`deprecated`、`disabled`。
2. `db/migrations/004_control_plane_registry.sql` 补齐治理字段、`capability_release` 和 `archived -> deprecated` 兼容迁移。
3. `packages/db` 提供 Flow、Route、Tool、Agent、Prompt 的版本化 Registry Repository。
4. Repository 支持 draft、revision optimistic locking、clone、publish、gray、rollback、deprecate、disable、release history。
5. `RegistryValidationService` 和 `RegistryReleaseService` 已放在 `src/modules/registry/`。
6. runtime-api 和 tool-gateway 已保持只读取 `published` / `gray`，并加入 deterministic gray allowlist 选择逻辑。

已完成 CP-R3 + CP-R4 API 与运行形态：

1. control-plane `/api/v1` Registry 管理 API。
2. 标准错误映射和 OpenAPI。
3. Header 认证与最小 RBAC：`platform_admin`、`capability_operator`、`auditor`。
4. Human Task、TaskRun、Audit、ToolCall 运营查询 BFF。
5. runtime-api Human Task / TaskRun 查询最小扩展。
6. tool-gateway Audit / ToolCall 查询最小扩展和敏感字段脱敏。
7. control-plane Fastify API + Vite 静态资源单容器 Node runtime。
8. `smoke:control-plane-api-e2e` 管理 API smoke。

尚未完成：

1. 完整 React 运营页面。
2. 低代码流程画布。
3. 企业 SSO。
4. 真实 Pi / 真实模型 / 真实业务系统适配。

## 重点功能

1. Flow 编排管理：草稿、校验、版本、发布、下线。
2. Route 配置：触发样例、负样例、关键词、适用渠道、适用角色、阈值。
3. Agent 管理：Prompt、模型策略、工具白名单、输出 Schema、预算。
4. Tool 管理：Manifest、风险等级、权限策略、Adapter 配置、测试调用。
5. 发布治理：校验、测试集、灰度、回滚、审计。
6. Human Task：当前通过 BFF 查询与 approve/reject；完整运营页面后续实现。
7. 运营看板：当前提供 Dashboard Summary API；完整图表页面后续实现。
