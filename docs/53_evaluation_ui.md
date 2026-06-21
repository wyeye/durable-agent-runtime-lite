# Evaluation UI

AR-2B UI closure adds React control-plane pages for Evaluation operations. Platform version remains `0.8.0`; no tag or release is created by this work. Ollama Evaluation remains out of scope and unfinished.

## Routes

- `/evaluation/datasets`
- `/evaluation/datasets/:datasetId/versions/:version`
- `/evaluation/runs`
- `/evaluation/runs/:runId`
- `/evaluation/gates`
- `/evaluation/gates/:gatePolicyId/versions/:version`
- `/evaluation/gate-decisions/:decisionId`

Prompt, Agent, and ModelPolicy Registry detail panels also show an Evaluation Gate Card.

## Roles

- `auditor`: read-only Dataset, Run, Gate, Decision, and Registry Gate Card views.
- `capability_operator`: create/edit Dataset drafts, Cases, Evaluation Runs, validate/publish eligible Dataset/Gate drafts according to existing permissions, but no Override UI.
- `platform_admin`: Gate management and Override UI. Backend still enforces exact hash, expiry, `allow_override`, and 403 rules.

## Dataset

Dataset pages support list filters, draft create, metadata edit, Case create/update/delete, validate, publish, clone, rollback, version viewing, exact dataset hash display, and copy hash. Published datasets are read-only in the UI and the backend remains the source of truth.

Case editing uses JSON and rejects parse errors before submit. It supports expected status, expected/forbidden tools, final/policy assertions, weight, tags, enabled flag, and performance budgets. It does not implement arbitrary code assertions.

## Runs

Run pages list status, dataset exact version/hash, subject snapshot, trigger, progress, aggregate, system errors, timestamps, and cancel for active runs. Create Run requires exact Dataset version/hash, Subject Snapshot ref/hash, and EvaluationExecutionPlan ref/hash; it does not accept `latest` or fabricate hashes.

Run detail polls active runs, displays Case Results, safe evidence refs, aggregate/progress, model/tool usage counts, Comparison creation, and Gate Decision links.

## Gates

Gate Policy pages support draft create/edit, required exact Dataset refs, thresholds, regression rules, required tags, `allow_override`, validate, publish, clone, and version viewing.

Gate Decision detail displays decision, freshness, stale reasons, resource hash, candidate bundle hash, Dataset/Gate Policy hashes where returned, run IDs, reasons, and safe JSON.

## Override

Only `platform_admin` sees Override controls. Reason and `expires_at` are required. The backend verifies the override is for the exact resource hash, the policy allows override, the decision is fresh, and the override has not expired. `capability_operator` and `auditor` do not see the button and still receive backend 403 if they call the API directly.

## Registry Gate Card

Prompt, Agent, and ModelPolicy detail views display latest Evaluation Gate state for the selected exact version:

- latest Gate Decision;
- freshness and stale reasons;
- decision resource hash and current resource hash;
- candidate bundle hash;
- run and decision links;
- exact publish metadata fields for candidate bundle, decision, and optional override.

The frontend does not decide publish eligibility. Publish allowed/blocked remains a backend exact-hash decision.

## Smoke

```bash
corepack pnpm smoke:evaluation-ui-e2e
```

The smoke uses Playwright against the running control-plane. Core Dataset, Case, Gate, Run, Gate Decision, Registry Gate Card, and Override/RBAC steps are driven through the browser. Setup may use DB/API only for immutable candidate snapshot and execution plan records that the UI currently does not create. Failure screenshots and traces are written under `artifacts/evaluation-ui-e2e/`.

AR-2B status after this UI implementation remains evidence-bound: mark `AR-2B UI COMPLETE` only after backend Evaluation smokes, old control-plane UI smoke, Evaluation UI smoke, lint/typecheck/test/build, and Integration update are verified in the target environment.
