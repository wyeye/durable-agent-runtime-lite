# Tool Integration

Tool Gateway 是唯一工具出口。每个 tool invocation 都必须包含 tenant、user、task、workflow、tool name/version、arguments、idempotency key、risk 和 request id。

生命周期：

```text
validate request
  -> load ToolManifest
  -> validate arguments schema
  -> check policy
  -> check idempotency
  -> invoke adapter
  -> validate output schema
  -> write audit
  -> return normalized response
```

Adapters：

- `mock`：development/test sandbox adapter，当前 `record.write.mock` 是唯一明确保留的 L3 sandbox 例外。
- `http_readonly`：GET-only、L0/L1-only、`side_effect=false`，host/scheme/path 来自 ToolManifest 和平台 allowlist。

外部业务 HTTP API mock、429/503/timeout/invalid-json/oversize、request count 和鉴权场景统一在 `devtools/mock-server`。
