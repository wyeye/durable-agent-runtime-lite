# mock-server

本地开发模拟业务系统与 Model Gateway。不得进入生产部署清单。

## Endpoints

```text
GET /healthz
GET /readyz
POST /v1/generate
```

`POST /v1/generate` 返回 `docs/21_model_gateway_contract.md` 中定义的结构化响应，支持 deterministic scenarios：

- `readonly_tool`
- `l3_tool`
- `user_input`
- `handoff`
- `final_only`
- `malformed_tool_call`
- `rate_limit_then_success`
- `upstream_500_then_success`
- `timeout`
- `excessive_tokens`

该服务只通过 `infra/docker-compose.pi-smoke.yml` 用于 development/test，不是生产 app。
