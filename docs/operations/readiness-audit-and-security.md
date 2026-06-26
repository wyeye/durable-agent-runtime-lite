# Readiness Audit And Security

每个生产 app 暴露：

- `GET /healthz`
- `GET /readyz`
- `GET /version`

Production readiness 必须 fail closed：

- runtime-worker production 固定使用 `model_gateway`。
- runtime-api production 不回退 memory route/sample flow。
- tool-gateway production 不回退 memory registry/mock facts。
- mock-server 不在 production compose。

安全要求：

- 不提交真实 secret。
- 不在日志、audit、Temporal history、UI 或响应中暴露 API key/token。
- Model credentials 仅在 control-plane 写入时加密，runtime-worker 解密后只用于请求 provider。
- Tool secrets 只通过 `env:TOOL_SECRET_*` 引用读取。

国际化边界：

- API response 根据 `Accept-Language` 返回 `Content-Language` / `Vary`。
- Runtime logs 使用部署级 `LOG_LOCALE`。
- error code、event code、enum、JSON field、API path、id/hash/model/tool/provider id 不翻译。
