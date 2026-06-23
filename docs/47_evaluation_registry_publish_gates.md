# Evaluation And Registry Publish Gates

Current status: `AR-2B PARTIAL`.

The platform remains at version `0.8.0`. No git tag, GitHub release, package version promotion, commit, or push is part of AR-2B development.

## Implemented Development Slice

This slice adds the first durable evaluation data model and fail-closed registry publish gate primitives:

- Versioned `evaluation_dataset` and `evaluation_case`.
- Immutable `evaluation_subject_snapshot` keyed by exact candidate bundle hash.
- Immutable `evaluation_execution_plan`.
- `evaluation_run` and `evaluation_case_result`.
- Versioned `evaluation_gate_policy`.
- Immutable `evaluation_gate_decision` keyed by exact resource id, version, resource hash, candidate bundle hash, gate policy id, version, and hash.
- `evaluation_gate_override` for audited platform-admin override records.
- `capability_release.evaluation_gate_decision_id` and `capability_release.evaluation_gate_override_id`.

The Registry publish request supports:

```json
{
  "release_note": "publish after evaluation",
  "evaluation_candidate_bundle_hash": "<sha256>",
  "evaluation_gate_decision_id": "eval_gate_decision_...",
  "evaluation_gate_override_id": "eval_gate_override_...",
  "metadata_json": {}
}
```

For `prompt`, `agent`, and `model_policy` publish actions, `EVALUATION_GATE_MODE=required` fails closed unless the exact candidate hash has a passed gate decision or an active override for the same resource hash.

## Required Exact Path

The intended publish gate path is:

```text
resource id/version/hash
  -> candidate bundle hash with exact AgentExecutionPlan ref/hash
  -> published EvaluationGatePolicy id/version/hash
  -> exact EvaluationGateDecision
  -> optional active EvaluationGateOverride
  -> Registry publish
  -> CapabilityRelease with gate ids
```

Candidate bundles must bind the primary subject hash to the actual immutable `AgentExecutionPlan` used by runtime execution. Prompt candidates replace `ResolvedAgentPlan.system_prompt`, agent candidates use the candidate agent's own prompt/model/tool/budget refs, and model-policy candidates replace `resolved_model_policy`. Any mismatch between subject snapshot, candidate bundle, execution plan hash, prompt hash, agent hash, or model-policy hash must fail closed with `EVALUATION_CANDIDATE_FIDELITY_MISMATCH`.

Gate policy `thresholds` and `regression_rules` are typed contracts, not free-form JSON. Case pass semantics distinguish hard gate failures, required assertion failures, explicit `minimum_case_score`, `system_error`, and ordinary continuous quality scores.

No default dataset, latest candidate, missing decision fallback, deterministic/mock model fallback, or memory fallback is allowed in required mode.

## Runtime Closure Slice

The current runtime closure slice adds, through the single baseline schema:

- workflow ids, cancellation request time, evidence collection state, case evidence snapshots, persisted comparisons, and evaluation context columns on `tool_call_log`.
- explicit run states `queued`, `running`, `cancelling`, `completed`, `failed`, and `cancelled`, plus case state `cancelled`.
- Deterministic bounded case execution in `evaluationRunWorkflow` using `EVALUATION_MAX_CONCURRENT_CASES`.
- Per-case `system_error` and `cancelled` result recording when a candidate/Pi child workflow fails or is cancelled.
- Run finalization order of aggregate, comparison, gate decision, then completed status.
- Cancelled case aggregation as skipped, excluded from weighted-score denominator.

## Configuration

Development defaults:

```text
EVALUATION_GATE_MODE=advisory
EVALUATION_WORKER_ENABLED=false
```

Production control-plane startup requires:

```text
EVALUATION_GATE_MODE=required
```

## Not Completed Yet

The following AR-2B items are not yet production-complete:

- Production framework/regression/publish-gate evaluation smokes through Temporal, Pi, Tool Gateway, Evidence Collector, Scoring, and DB.
- Real Ollama Evaluation E2E through the full evaluation runner.
- Control-plane Dataset, Run, Result, Comparison, and Gate pages.
- Evaluation smoke scripts and CI workflows.
- Full registry publish gate UI flow for selecting a gate decision or override.

Keep AR-2B status as `PARTIAL` until those paths are implemented and verified.
