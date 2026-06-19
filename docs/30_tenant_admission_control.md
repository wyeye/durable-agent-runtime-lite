# Tenant Admission Control

Tenant Agent Admission bounds concurrent agent execution per tenant.

## Lifecycle

```text
reserved -> active -> released
reserved -> rejected
active   -> reconciled
```

The admission row records tenant, task run, agent run, workflow id/run id, policy snapshot ref, status, acquired time, release time, release reason, and revision.

## Runtime Rules

- `runtime-api` reserves admission before starting a DB-backed workflow that includes an agent.
- PostgreSQL advisory transaction locks serialize reservation per tenant.
- If the tenant limit is reached, the request fails with `TENANT_AGENT_CONCURRENCY_EXCEEDED` and HTTP 429.
- `runtime-worker` releases admission when the workflow reaches a terminal task status.
- Reconcile is an operations tool for stale admissions only; it must not release open workflows.

## Reconcile CLI

```bash
corepack pnpm admission:reconcile -- --tenant-id <tenant> --batch-size 100 --stale-after-ms 1800000
corepack pnpm admission:reconcile -- --apply --tenant-id <tenant> --batch-size 100 --stale-after-ms 1800000
```

Default mode is dry-run. Temporal connection failure exits nonzero and does not modify admissions. The script writes safe JSON and appends one idempotent `agent.admission.reconciled` audit event per reconciled admission.

## Reconcile Smoke

```bash
corepack pnpm smoke:tenant-admission-reconcile-e2e
```
