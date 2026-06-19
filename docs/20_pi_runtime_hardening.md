# Pi Runtime Hardening

AR-1.1 hardens the segmented Pi runtime without adding another production service.
Pi still runs inside `runtime-worker`; Temporal owns durable supervision between
segments; Tool Gateway remains the only side-effect boundary.

## Boundary

```text
runtime-api /v1/agent-tasks
  -> Temporal piDurableAgentWorkflow
  -> runPiSegmentActivity
  -> Pi Agent Core Agent.prompt / Agent.continue
  -> DeferredPiTool proposal
  -> Temporal Activity -> tool-gateway
  -> authoritative boundary result
  -> persisted Pi context snapshot
  -> next segment
```

Pi never receives DB, Temporal Client, filesystem, shell, MCP, or Tool Gateway
capabilities. Deferred tools only emit proposals with `call_id`, tool identity,
arguments, risk level, and immutable tool hash.

## Budget Ledger

`piDurableAgentWorkflow` carries an `AgentBudgetLedger` across segment retries,
worker restarts, and Continue-As-New. The ledger tracks:

- `segment_count`
- `model_turn_count`
- `tool_call_count`
- `handoff_count`
- `input_tokens`
- `output_tokens`
- `total_tokens`
- `estimated_cost`
- `elapsed_duration_ms`
- `context_bytes`

Each segment receives `budget_remaining`, calculated from the immutable
`AgentExecutionPlan.budget` minus this ledger. Tool proposals are charged when
the workflow processes them, including denied proposals, so a model cannot avoid
tool-call budget by repeatedly asking for unauthorized tools. Handoff requests
are charged before child workflow execution. Token usage and model turn counts
come from Pi/model stream usage and are persisted on `agent_run`.

Workflow duration uses Temporal workflow time. The implementation uses
workflow-side `Date.now()`, which the Temporal TypeScript SDK virtualizes for
deterministic replay; it does not use Activity host wall-clock time as the
workflow duration source.

Budget exhaustion updates:

- `agent_run.status=budget_exceeded`
- `task_run.status=failed`
- stable error code such as `AGENT_TOKEN_BUDGET_EXCEEDED`

## Tool Idempotency

Agent tool calls use `AgentToolExecutionIdentity`:

```text
agent_run_id
segment_index
call_id
operation
tool_name
tool_version
```

The idempotency key is:

```text
agent:{agent_run_id}:segment:{segment_index}:call:{call_id}:{operation}
```

`operation` is one of `invoke`, `preview`, or `commit`. The same Activity retry
or worker replay reuses the same key. Two calls to the same tool in the same
segment do not conflict when Pi produced different `call_id` values. Existing
ConfigDrivenWorkflow step idempotency keys are unchanged.

## AgentStep Lifecycle

`AgentStep` is created when a Pi segment reaches a durable boundary. The same
row is updated after the boundary is resolved. Important fields:

- `proposed_tool_calls`
- `authoritative_tool_result_refs`
- `tool_result_refs`
- `human_task_ids`
- `context_snapshot_before`
- `context_snapshot_after`
- `handoff_refs`
- `usage`
- `error_code` / `error_message`

`stable_step_key = {agent_run_id}:{segment_index}` prevents duplicate rows on
Activity retry. Tool results are stored as references and summaries, not full
sensitive adapter payloads.

## Context Budget

Context snapshots are bounded by the current `AgentExecutionPlan.budget`.
`persistToolResultsToPiContextActivity` and
`appendUserInputToPiContextActivity` receive the explicit plan
`max_context_bytes`. They no longer use `agentBudgetSchema.parse({})` defaults.

The codec preserves the message pairs needed for Pi recovery. It redacts unsafe
metadata and hidden reasoning, and it fails clearly when the full recovery
snapshot is too large rather than silently truncating required tool-call /
tool-result pairs.

## Continue-As-New

`PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW` is loaded through an Activity, then
carried in `PiDurableAgentWorkflowInput.continue_as_new_segment_threshold`.
Continue-As-New only runs after a boundary has been fully resolved and the next
context snapshot has been persisted. The new run receives:

- `agent_run_id`
- `agent_execution_plan_ref`
- `context_snapshot_ref`
- `budget_ledger`
- `segment_index`
- `started_at_ms`
- request context fields
- `handoff_chain`

The workflow does not put full Pi message history into Temporal history.
`agent_run.workflow_run_id` is updated to the current Temporal run id after
workflow start/resume.

## Handoff

`handoff_to_workflow` is implemented as a controlled Temporal child workflow.

Rules:

- target ref must be in `AgentExecutionPlan.allowed_handoffs`;
- target is loaded by exact `FlowExecutionPlan.execution_plan_ref`;
- only `ConfigDrivenWorkflow` targets are accepted;
- child workflow id is stable and includes parent workflow id, agent run id,
  handoff index, and target execution plan id;
- handoff count is budgeted;
- recursion through the current handoff chain is denied.

The step records:

- `parent_workflow_id`
- `child_workflow_id`
- `target_execution_plan_ref`
- `handoff_arguments_ref`
- `child_result_ref`
- `child_status`

On child success, a safe authoritative handoff result is written into the Pi
context and the next Pi segment continues. On child failure, the agent fails
with an explicit handoff error.

## Smoke Scripts

The root scripts use real Pi Agent Core and deterministic/model-gateway streams:

```bash
corepack pnpm smoke:pi-readonly-e2e
corepack pnpm smoke:pi-l3-e2e
corepack pnpm smoke:pi-user-input-e2e
corepack pnpm smoke:pi-handoff-e2e
corepack pnpm smoke:pi-restart-resume-e2e
corepack pnpm smoke:pi-model-gateway-e2e
```

They require the Docker stack and database to be initialized first. The
`restart_resume` script exercises the same persisted context recovery path, but
the operational stop/start of the worker is still a manual Docker step.

## Current Limits

- Production live model credentials are not required for AR-1.1.
- The local mock gateway is dev/test only.
- Agent audit events are still primarily represented by existing human task,
  tool call, task run, and agent run/step records; a richer `agent.*` audit
  taxonomy remains follow-up work.
