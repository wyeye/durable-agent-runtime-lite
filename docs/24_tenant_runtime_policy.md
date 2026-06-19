# Tenant Runtime Policy

Tenant Runtime Policy is the tenant-scoped runtime contract used before a workflow or agent task starts.

## Source of Truth

- Table: `tenant_runtime_policy`.
- Repository: `TenantRuntimePolicyRepository`.
- Resolver: `TenantRuntimePolicyResolver`.
- Runtime snapshot table: `tenant_runtime_policy_snapshot`.
- Admission table: `tenant_agent_admission`.

Production must run with:

```text
TENANT_RUNTIME_POLICY_MODE=required
RUNTIME_API_ROUTE_SOURCE=db
RUNTIME_API_WORKFLOW_STARTER=temporal
TOOL_GATEWAY_REGISTRY_SOURCE=db
TOOL_GATEWAY_AUTH_MODE=service_token
```

Development and test may use `optional`, but production paths must fail closed when a published tenant policy or immutable snapshot is missing.

## Runtime Path

1. `runtime-api` resolves the exact Flow or Agent execution plan.
2. `runtime-api` resolves the latest published tenant policy for the request tenant.
3. The resolver intersects the policy with the execution plan and writes an immutable snapshot.
4. `runtime-api` stores `tenant_policy_snapshot_ref`, `tenant_policy_hash`, and admission identity on `task_run`.
5. `runtime-worker` loads the snapshot by ref/hash and uses it for fail-fast model, handoff, budget, and tool checks.
6. Tool calls include snapshot ref/hash plus execution plan ref/hash.
7. `tool-gateway` independently loads the snapshot and remains the final tool authorization boundary.

No production code may fall back to default tenant, latest unrelated policy, memory route, memory tool registry, sample plan, or mock policy success.

## Smoke Commands

```bash
corepack pnpm smoke:tenant-policy-e2e
corepack pnpm smoke:tenant-policy-snapshot-e2e
corepack pnpm smoke:tenant-concurrency-e2e
corepack pnpm smoke:tenant-flow-agent-e2e
```
