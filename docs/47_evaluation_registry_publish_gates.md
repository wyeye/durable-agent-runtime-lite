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
  -> candidate bundle hash
  -> published EvaluationGatePolicy id/version/hash
  -> exact EvaluationGateDecision
  -> optional active EvaluationGateOverride
  -> Registry publish
  -> CapabilityRelease with gate ids
```

No default dataset, latest candidate, missing decision fallback, deterministic/mock model fallback, or memory fallback is allowed in required mode.

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

- Temporal evaluation workflow and activity execution.
- Real Ollama Evaluation E2E through the full evaluation runner.
- Control-plane Dataset, Run, Result, Comparison, and Gate pages.
- Evaluation smoke scripts and CI workflows.
- Full registry publish gate UI flow for selecting a gate decision or override.

Keep AR-2B status as `PARTIAL` until those paths are implemented and verified.
