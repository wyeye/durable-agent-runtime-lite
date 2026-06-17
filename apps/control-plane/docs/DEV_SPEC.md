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
