# Model And Routing

Model Gateway 事实源是 DB-backed catalog：

- `model_gateway_profile` 存网关配置和加密凭据。
- `model_definition` 存 exact model id/version/hash、provider、upstream model id 和 capability。
- `model_policy` target 选择已发布 `model_ref`。
- `runtime-worker` 在 AgentRun 时解析当前 profile、model 和凭据。

生产模型调用不得回退到部署级 `MODEL_GATEWAY_BASE_URL`、`MODEL_GATEWAY_API_KEY`、`MODEL_GATEWAY_MODEL` 或默认/latest 模型。

Routing 使用 rule match、vector recall、Top-K LLM/Pi classification 和 policy fallback 的混合方向。低置信路由不得静默执行高风险 flow，必须 clarification、fallback 或 escalation。

Semantic routing 的 mock embedding 只由 `devtools/mock-server` 提供。Integration 通过 `pnpm dar smoke suite core` 覆盖 `semantic-router` 场景。
