# mock-server

本地开发模拟业务系统与 Model Gateway。不得进入生产部署清单。

## Endpoints

```text
GET /healthz
GET /readyz
POST /__test/reset
POST /__test/scenario
GET /__test/stats
POST /v1/generate
POST /v1/chat/completions
POST /gateway-a/v1/chat/completions
POST /gateway-a/v1/embeddings
POST /gateway-b/v1/chat/completions
POST /gateway-b/v1/embeddings
GET /business-api/v1/policies
```

`POST /v1/generate` 返回 DAR model gateway 结构化响应，`/v1/chat/completions` 返回 OpenAI-compatible 响应。支持场景：

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

`/__test/*` 控制端点仅在 development/test 开启；production 环境返回 404。外部系统 mock 状态、请求计数、鉴权场景和 429/5xx/timeout/invalid-json/oversize 行为集中在该服务中。
