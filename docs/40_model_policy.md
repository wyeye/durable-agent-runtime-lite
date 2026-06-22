# ModelPolicy

ModelPolicy is the source of truth for model execution.

## Lifecycle

Supported statuses:

```text
draft -> validated -> published -> gray -> deprecated -> disabled
```

Draft and validated versions may be edited with optimistic revision checks. Published, gray, deprecated, and disabled versions are immutable in place.

## Target Shape

Each target has:

- `target_id`
- `model_ref`
- `priority`
- `enabled`
- optional timeout/retry overrides

`model_ref` is an exact published `ModelDefinitionRef`:

```json
{
  "model_id": "local-qwen",
  "version": 1,
  "model_hash": "..."
}
```

ModelPolicy no longer stores raw `gateway_profile`, raw `model_id`, `provider_hint`, capabilities, costs, default model, latest model, API keys, Authorization headers, cookies, service tokens, arbitrary gateway URLs, or deployment-env model fallback. Gateway endpoint metadata and credentials come from `model_gateway_profile`; model capability/cost/provider/upstream id come from `model_definition`.

## Exact Lock

AgentSpec now references an exact `model_policy_ref`:

```json
{
  "model_policy_id": "example_policy",
  "model_policy_version": 1,
  "model_policy_hash": "..."
}
```

AgentExecutionPlan stores:

- `model_policy_id`
- `model_policy_version`
- `model_policy_hash`
- `resolved_model_policy`

The resolved policy locks every target's `model_id`, `version`, `model_hash`, `gateway_profile_id`, `gateway_profile_config_hash`, `upstream_model_id`, provider, capabilities, limits, costs, priority, and timeout/retry override. It does not lock API keys or encrypted credential material.

Runtime AgentRuns read the frozen execution plan, not latest ModelPolicy. Missing or hash-mismatched ModelDefinition data fails plan generation; there is no legacy target fallback and no latest/default model selection.
