# Roadmap And Release

当前版本线保持 `0.8.0`，没有 tag、GitHub Release 或版本晋级。

R0 / Platform Core：

- 四应用架构。
- DB-backed registry。
- Tool Gateway 边界。
- Temporal replay/crash recovery。
- Docker build/runtime baseline。

AR-2 Intelligence RC 前置：

- 受保护 live model smoke。
- runtime-api -> Temporal -> runtime-worker -> Tool Gateway -> Pi 的 final/readonly/L3 真实模型路径。
- self-hosted Ollama runtime/evaluation gate。
- Mock 与 deterministic 行为不作为生产成功事实源。

V1 GA 前置：

- 所有 release criteria 明确通过。
- 无生产 fallback 到 sample、mock、memory、stale 或 unrelated data。
- 四生产 app Docker readiness 通过。
- 当前导出 Temporal histories replay 通过。
- 文档、命令和 CI 事实源收口。
