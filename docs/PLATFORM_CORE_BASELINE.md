# Platform Core Baseline

This file freezes the AR-1 platform core as the R0 baseline for Durable Agent Runtime Lite.

## Baseline

- Baseline git SHA observed at the start of this work: `b4ead47817c1c32f71045139cbdee434a8709afe`.
- User-provided expected baseline: `ab7cec9` (`完成租户策略生产闭环与全量回归门禁`).
- Baseline date: 2026-06-19.
- Version assigned to the frozen platform core: `0.8.0`.
- Current migration head after AR-2A partial work: `011_model_policy_and_calls.sql`.

## Frozen Capabilities

The AR-1 core is treated as complete and should not be redesigned during AR-2 work:

- Four production apps only: `control-plane`, `runtime-api`, `runtime-worker`, `tool-gateway`.
- DB-backed Registry for Flow, Route, Tool, Agent, Prompt, and TenantRuntimePolicy.
- Immutable `FlowExecutionPlan` and `AgentExecutionPlan` runtime references.
- Temporal `ConfigDrivenWorkflow`, `GenericAgentWorkflow`, and Pi durable supervisor.
- Pi Agent Core segmented loop with context snapshots and Continue-As-New.
- Tool Gateway as the only tool invocation and side-effect boundary.
- L3 `preview -> Human Task -> Signal -> commit`.
- Tenant Policy Snapshot lineage and Tenant Agent Admission.
- Worker crash recovery smoke and Temporal replay fixtures.
- Runtime API header auth and Tool Gateway service-token auth.

## Workflow Types

- `ConfigDrivenWorkflow`
- `GenericAgentWorkflow`
- `piDurableAgentWorkflow`

## Replay Fixtures

Replay fixtures live under `tests/temporal-replay/histories/` and are verified by:

```bash
corepack pnpm test:temporal-replay
```

Existing fixtures must not be deleted or rewritten to hide determinism regressions.

## Existing Smoke List

```bash
corepack pnpm smoke:temporal-db-e2e
corepack pnpm smoke:control-plane-api-e2e
corepack pnpm smoke:control-plane-ui-e2e
corepack pnpm smoke:pi-readonly-e2e
corepack pnpm smoke:pi-l3-e2e
corepack pnpm smoke:pi-user-input-e2e
corepack pnpm smoke:pi-handoff-e2e
corepack pnpm smoke:pi-restart-resume-e2e
corepack pnpm smoke:pi-model-gateway-e2e
corepack pnpm smoke:pi-worker-crash-resume-e2e
corepack pnpm smoke:tenant-policy-e2e
corepack pnpm smoke:tenant-policy-snapshot-e2e
corepack pnpm smoke:tenant-concurrency-e2e
corepack pnpm smoke:tenant-flow-agent-e2e
corepack pnpm smoke:tenant-handoff-lineage-e2e
corepack pnpm smoke:tenant-policy-crash-snapshot-e2e
corepack pnpm smoke:tenant-admission-reconcile-e2e
```

## Compatibility Boundaries

New production AgentSpec publishing requires exact `model_policy_ref`. Per the current user instruction, no old-data compatibility or fallback is required for new runtime paths. Old Temporal replay fixtures remain protected at the workflow determinism layer, but new DB rows and new AgentExecutionPlans must use the strict ModelPolicy lock.

## Known Non-Blocking Risks

- Protected live model smoke is not complete without real external credentials.
- Full Docker image build and all long-running smoke commands were not rerun in this local pass after AR-2A partial edits.
- Model usage aggregation exists through gateway usage fields; cost remains `null` unless explicit cost rates are supplied and propagated.
