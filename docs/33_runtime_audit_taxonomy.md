# Runtime Audit Taxonomy

Audit events are append-only and use stable `action` names. Logical retry-sensitive events should include `event_key`; the baseline schema adds a partial unique index on `audit_event.event_key`.

## Implemented Event Families

Policy:

- `policy.publish`
- `policy.rollback`
- `policy.deprecated`
- `policy.disabled`
- `policy.snapshot.created`
- `policy.snapshot.derived`
- `policy.snapshot.hash_mismatch`
- `policy.resolve.allowed`
- `policy.resolve.denied`

Admission:

- `agent.admission.reconciled`

Agent and human task:

- `agent.human_task.created`
- existing `human_task.approve`, `human_task.reject`, and `human_task.respond` events from the runtime-api decision path.

Tool:

- `tool.invoke`
- `tool.preview`
- `tool.commit`
- `tool.idempotency_replay`

## Safety Rules

Audit payloads should contain stable references such as `request_id`, `tenant_id`, `user_id`, `task_run_id`, `workflow_id`, `agent_run_id`, `execution_plan_ref`, `tenant_policy_snapshot_ref`, `tenant_admission_id`, and hashes.

Do not store hidden reasoning, full prompts, secrets, raw tokens, or complete sensitive tool results. ToolCall and Audit read APIs mask sensitive fields.

## Remaining Gap

The full aspirational `agent.run.*`, `agent.segment.*`, `agent.tool.*`, `agent.handoff.*`, and crash-recovery audit taxonomy is not completely implemented yet. AR-1.2C status remains PARTIAL until those events and no-duplicate crash/Continue-As-New assertions are covered end to end.
