# Non Goals

以下内容除非明确批准，否则不进入当前 V1 范围：

- 第五个生产 app。
- 仓库内生产 Model Gateway app。
- 通用 OpenAI-compatible / DAR gateway protocol 之外的 provider-specific SDK 集成。
- Pi Agent Core 之外的第二套 Agent Loop。
- Pi 直接访问 DB、Temporal Client、Tool Gateway、shell、filesystem、MCP 或业务 API。
- 任意 DAG 复杂可视化 workflow designer。
- AR-2C semantic routing expansion。
- 写侧业务 adapter 或领域业务 adapter。
- HTTP write tools、MCP tools、OAuth tools、browser automation tools、SQL tools、动态 arbitrary-header HTTP tools。
- `devtools/mock-server` 的生产使用。
- 生产 fallback 到 memory registry、sample flow、default tool、deterministic Pi、mock Model Gateway、latest model policy 或无关数据。
