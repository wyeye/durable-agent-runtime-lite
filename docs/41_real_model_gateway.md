# Real Model Gateway

The runtime integrates external model providers through `packages/model-client`.

Supported protocols:

- `openai_chat_completions`

`MODEL-CATALOG-MVP-1` changes the production source of truth from a single deployment-level gateway env set to the DB-backed model catalog:

```text
PI_AGENT_MODE=model_gateway
MODEL_GATEWAY_CONFIG_SOURCE=db
MODEL_CREDENTIAL_MASTER_KEY=<base64 32-byte key>
MODEL_GATEWAY_CLIENT_CACHE_TTL_MS=60000
```

`MODEL_GATEWAY_BASE_URL`, `MODEL_GATEWAY_API_KEY`, `MODEL_GATEWAY_MODEL`, and `MODEL_GATEWAY_PROFILE_ID` are no longer production model-call facts. Runtime Worker resolves `AgentExecutionPlan.resolved_model_policy.targets[].model_ref` through exact `model_definition` and `model_gateway_profile` rows, validates hashes, decrypts the current credential, and creates or reuses a short-lived client.

Production readiness validates the credential master key and DB-backed catalog access. It does not require every external gateway to be online.

`devtools/mock-server` is development/test only. It is exposed by `infra/docker-compose.pi-smoke.yml` and must not be used as a production dependency.

The OpenAI-compatible adapter supports system/user/assistant/tool messages, tool definitions, structured tool calls, tool choice, parallel tool call flag, response format, usage, response id, timeout, AbortSignal, response-size limit, and bounded retry for retryable transport errors.

Provider-facing tool names are request-local aliases. Canonical runtime names
such as `knowledge.search` are encoded to OpenAI-compatible names before the
request and decoded before the response enters Pi. Unknown aliases, duplicate
tool call ids, missing `tool_call_id`, duplicate tool results, and unmatched
tool results fail closed.

Tool calls returned by the model remain deferred proposals. Execution still follows:

```text
Pi -> Deferred Tool -> Temporal -> Activity -> Tool Gateway
```

L3 still follows:

```text
preview -> Human Task -> Signal -> commit
```

Model-call ledger records use a logical request key per agent run segment and model turn. The key does not include the selected target id, so retry/fallback attempts remain attached to one logical call. Attempts record `gateway_profile_id`, `gateway_profile_config_hash`, `credential_fingerprint`, `credential_revision`, `model_id`, `model_version`, `model_hash`, `upstream_model_id`, `global_attempt_index`, `target_attempt_index`, and `fallback_index`; replay only uses stored successful safe responses. API keys, ciphertext, IV, auth tags, Authorization headers, raw provider responses, and hidden reasoning are never written to the ledger. Oversized normalized model responses fail with `MODEL_RESPONSE_LEDGER_LIMIT_EXCEEDED` instead of being silently truncated.

Credential rotation is picked up without restarting the Runtime Worker because the client cache key includes `profile_id`, `config_hash`, and `credential_revision`.

Local Ollama validation:

```bash
corepack pnpm ollama:probe
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm runtime:assert-containerized
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm smoke:ollama-containerized-e2e
corepack pnpm smoke:ollama-runtime-final-e2e
corepack pnpm smoke:ollama-runtime-readonly-e2e
corepack pnpm smoke:ollama-runtime-l3-e2e
```

`ollama:probe` checks the exact local model `qwen2.5:7b-instruct-q4_K_M`.
The containerized smoke requires Dockerized `runtime-api`, `runtime-worker`,
`tool-gateway`, and `control-plane`; only Ollama runs on the host. It fails if
`mock-server` is running, deterministic Pi is enabled, or the DB evidence does
not show `provider=local-ollama` and model `qwen2.5:7b-instruct-q4_K_M`.

Multi-gateway catalog validation:

```bash
corepack pnpm smoke:model-catalog-multi-gateway-e2e
```

This smoke creates two OpenAI-compatible gateway profiles through control-plane API, encrypts two bearer credentials, publishes model definitions, switches ModelPolicy versions without restarting Runtime Worker, rotates a credential without restart, and proves cross-gateway fallback in `model_call_attempt`.
