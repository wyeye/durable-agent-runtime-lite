# Model Gateway MVP

`MODEL-CATALOG-MVP-1` introduces OpenAI-compatible model gateways as registry data, not deployment-time runtime facts.

## Scope

The MVP supports:

- `openai_chat_completions` protocol.
- `none` and `bearer` authentication.
- Multiple gateway profiles in PostgreSQL.
- AES-256-GCM encrypted bearer credentials.
- Runtime Worker dynamic resolution from DB.
- Short-lived client cache keyed by profile config and credential revision.

The MVP does not support Vault, cloud secret managers, Azure-specific authentication, custom arbitrary headers, mTLS, automatic rotation, or non OpenAI-compatible protocols.

## Configuration

Runtime Worker and Control Plane must use the same credential master key:

```text
MODEL_GATEWAY_CONFIG_SOURCE=db
MODEL_CREDENTIAL_MASTER_KEY=<base64 32-byte key>
MODEL_GATEWAY_CLIENT_CACHE_TTL_MS=60000
```

`MODEL_CREDENTIAL_MASTER_KEY` is the only secret required for decrypting stored model gateway credentials. Production must provide a real base64-encoded 32-byte key. Development and test compose files use an explicit dev-only placeholder so local databases can be rebuilt.

`MODEL_GATEWAY_BASE_URL`, `MODEL_GATEWAY_API_KEY`, `MODEL_GATEWAY_MODEL`, and `MODEL_GATEWAY_PROFILE_ID` are no longer production model-call facts for Runtime Worker. Model calls resolve through `model_definition` and `model_gateway_profile`.

## Credential Storage

Bearer API keys are encrypted in `packages/security` by `ModelCredentialCipher`:

- Algorithm: AES-256-GCM.
- IV: random 12 bytes per encryption.
- AAD: `profile_id` plus `credential_revision`.
- Stored values: ciphertext, iv, auth tag, fingerprint, revision.
- Fingerprint: short SHA-256 digest for display and audit only.

API responses never include API key, ciphertext, IV, or auth tag. UI pages only show whether a credential is configured, its fingerprint, and revision.

## Runtime Path

Runtime Worker resolves a model call in this order:

```text
AgentExecutionPlan.resolved_model_policy.targets[].model_ref
  -> ModelDefinition exact model_id/version/hash
  -> ModelGatewayProfile exact profile_id/config_hash
  -> decrypt current credential by credential_revision
  -> ModelGatewayClient cache key profile_id/config_hash/credential_revision
  -> OpenAI-compatible /v1/chat/completions
```

The Runtime Worker records `gateway_profile_id`, `gateway_profile_config_hash`, `credential_fingerprint`, `credential_revision`, `model_id`, `model_version`, `model_hash`, `upstream_model_id`, and `provider` in the model call ledger. It never records the API key.

## Local Smoke

The model-catalog smoke entry is:

```bash
corepack pnpm smoke:model-catalog-multi-gateway-e2e
```

It expects Control Plane, Runtime API, Runtime Worker, Temporal, PostgreSQL, and the mock server to be running. The script creates two bearer gateways through Control Plane API, publishes two model definitions, publishes ModelPolicy versions, runs Agent tasks through Runtime API, and checks DB model-call evidence.

