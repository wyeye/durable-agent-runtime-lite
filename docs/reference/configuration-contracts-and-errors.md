# Configuration Contracts And Errors

配置由 `packages/config` 统一加载和校验。除 app bootstrap 和 config package 外，不应散落读取 raw `process.env`。

常见变量：

```text
NODE_ENV
APP_ENV
HOST
PORT
DATABASE_URL
VALKEY_URL
TEMPORAL_ADDRESS
TEMPORAL_NAMESPACE
TOOL_GATEWAY_URL
RUNTIME_API_URL
MODEL_CREDENTIAL_MASTER_KEY
LOG_LEVEL
OTEL_EXPORTER_OTLP_ENDPOINT
```

Contracts 位于 `packages/contracts`，使用 Zod 作为外部输入 schema 和 TypeScript 类型来源。公共 API 错误必须使用标准 error response，包含稳定 error code 和安全 message，不暴露 stack trace、secret 或 raw provider payload。

当前 migration head：`001_baseline.sql`。
