# Model Catalog

The model catalog separates three responsibilities:

```text
ModelGatewayProfile
  Owns compatible endpoint metadata and encrypted credentials.

ModelDefinition
  Owns a platform model identity, upstream model id, provider, capabilities, costs, and profile hash.

ModelPolicy
  Owns target ordering and fallback by selecting exact published ModelDefinition refs.
```

## Gateway Profile

`model_gateway_profile` stores:

- `profile_id`
- display name
- protocol
- base URL
- auth type
- status
- public `config_hash`
- encrypted credential fields
- credential fingerprint and revision

Published public config is immutable. Rotating a bearer API key increments `credential_revision` without changing `config_hash`.

## Model Definition

`model_definition` stores a precise model version:

- `model_id`
- `version`
- `gateway_profile_id`
- `gateway_profile_config_hash`
- `upstream_model_id`
- `provider`
- capabilities
- context and output-token limits
- optional costs
- `model_hash`

A published model definition must reference a published gateway profile and must retain the profile config hash it was validated against.

## Model Policy

ModelPolicy targets now use exact model references:

```json
{
  "target_id": "primary",
  "model_ref": {
    "model_id": "local-qwen",
    "version": 1,
    "model_hash": "<sha256>"
  },
  "priority": 0,
  "enabled": true
}
```

Raw `gateway_profile`, raw `model_id`, default model, latest model, and environment-model fallback are not supported. If a model ref cannot be resolved exactly, plan generation fails.

## Control Plane

Control Plane exposes:

- `/api/v1/model-gateways`
- `/api/v1/models`
- visual pages `/model-gateways` and `/models`
- ModelPolicy visual editor with an exact published model selector

`platform_admin` can create, publish, disable, test, and rotate gateways. Operators and auditors can read metadata according to existing Control Plane permissions.

## Runtime Locking

When an Agent execution plan is created, it locks:

- ModelPolicy id/version/hash
- every target's ModelDefinition id/version/hash
- Gateway Profile id/config hash
- upstream model id and provider
- model capability and limit metadata

Credentials are intentionally not locked into execution plans. Credential rotation is runtime state and is picked up through `credential_revision` without rebuilding or restarting the Runtime Worker.

