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

## 重点功能

1. Flow 编排管理：草稿、校验、版本、发布、下线。
2. Route 配置：触发样例、负样例、关键词、适用渠道、适用角色、阈值。
3. Agent 管理：Prompt、模型策略、工具白名单、输出 Schema、预算。
4. Tool 管理：Manifest、风险等级、权限策略、Adapter 配置、测试调用。
5. 发布治理：校验、测试集、灰度、回滚、审计。
6. Human Task：待确认、已确认、拒绝、补充信息、人工接管。
7. 运营看板：流程命中率、工具成功率、确认率、失败率、成本。



# control-plane 开发规范

## 模块划分

```text
modules/flow-registry
modules/route-registry
modules/tool-registry
modules/agent-registry
modules/prompt-registry
modules/release
modules/human-task
modules/dashboard
modules/audit-viewer
```

## API 约定

- 草稿类接口使用 `POST /api/flows/drafts`、`PUT /api/flows/drafts/:id`。
- 发布类接口使用 `POST /api/flows/:flow_id/versions/:version/publish`。
- 回滚类接口使用 `POST /api/flows/:flow_id/rollback`。
- 所有发布接口必须写 `publish_event`。

## 数据写入规则

- `published` 版本不可变，不允许原地修改。
- 修改已发布流程必须生成新版本。
- 下线只改变状态，不物理删除。
- FlowSpec、RouteSpec、AgentSpec、ToolManifest 需要保存 `sha256`。

## UI 规范

- 所有发布动作需要二次确认。
- 所有高风险工具要醒目标注。
- 流程引用不存在的 Tool / Agent / Prompt 时禁止发布。
- 页面要展示当前版本、灰度比例、最近发布时间、发布人。

## 测试要求

- FlowSpec JSON Schema 校验单测。
- 发布流程集成测试。
- 回滚逻辑集成测试。
- Human Task 状态机测试。
