# Policy Snapshot Lineage

Tenant policy snapshots are immutable runtime records. They lock source policy version/hash and execution plan ref/hash for a running workflow or child workflow.

## Derivation Types

- `root`: created by `runtime-api` before starting the root flow or root agent task.
- `flow_agent_child`: derived when `ConfigDrivenWorkflow` starts an agent child workflow.
- `workflow_handoff`: derived when an agent hands off from a root agent snapshot to a target `ConfigDrivenWorkflow`.
- `nested_handoff`: derived when handoff occurs from an already derived policy snapshot.

## Invariants

- Root snapshots have no parent and point `root_snapshot_ref` to themselves.
- Child snapshots retain the root snapshot ref and source policy version/hash.
- Child snapshots must have parent refs and increasing lineage depth.
- Running workflows must continue using the original source policy version even after publish/rollback/deprecate/disable operations.
- Hash mismatch or execution plan mismatch fails closed.

## Operations UI

Control-plane exposes read-only snapshot views:

```text
GET /api/v1/tenant-runtime-policy-snapshots
GET /api/v1/tenant-runtime-policy-snapshots/:snapshotId
/policy-snapshots
```

The UI shows root/parent refs, derivation type, policy version/hash, execution plan identity, effective tools/models/handoffs, and budget.
