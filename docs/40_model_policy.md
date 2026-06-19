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
- `gateway_profile`
- optional `provider_hint`
- `model_id`
- `priority`
- `enabled`
- `capabilities`
- optional timeout/retry/cost fields

ModelPolicy never stores API keys, Authorization headers, cookies, service tokens, or arbitrary gateway URLs. Gateway URLs and credentials come from trusted runtime configuration.

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

Runtime AgentRuns read the frozen execution plan, not latest ModelPolicy.
