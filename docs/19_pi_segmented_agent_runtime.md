# Pi Segmented Agent Runtime

AR-1 introduced a real Pi Agent Core inner loop supervised by Temporal segment boundaries. AR-1.1 hardens the same runtime with cumulative budget ledgers, stable tool idempotency, AgentStep boundary updates, Continue-As-New, controlled workflow handoff, and local model-gateway smoke coverage.

## Packages

Runtime worker uses exact Pi package versions:

```text
@earendil-works/pi-agent-core 0.79.6
@earendil-works/pi-ai 0.79.6
```

Used Pi APIs:

- `Agent`
- `AgentOptions.initialState`
- `Agent.state.messages`
- `Agent.prompt()`
- `Agent.continue()`
- `Agent.abort()`
- `Agent.subscribe()`
- `AgentTool`
- `AgentTool.execute()`
- `AgentToolResult.terminate`
- `afterToolCall`
- `toolExecution`
- `StreamFn`
- `AgentMessage`
- `ToolResultMessage`
- Pi AI faux provider helpers for deterministic tests.

The runtime does not use `pi-coding-agent`, `pi-tui`, shell tools, filesystem tools, MCP tools, or network tools from Pi.

## Architecture

```text
Temporal piDurableAgentWorkflow
  -> runPiSegmentActivity
  -> Pi Agent Core Agent.prompt/continue
  -> DeferredPiTool boundary
  -> Temporal validates and invokes Tool Gateway / Human Task
  -> append authoritative result to Pi context snapshot
  -> next runPiSegmentActivity
```

Pi owns the model -> tool -> model inner loop. Temporal owns only durable segment orchestration.

## Deferred Tools

Runtime worker creates Pi `AgentTool` objects from immutable `AgentExecutionPlan.allowed_tools`.

Deferred tool execution only returns a structured proposal:

```json
{
  "kind": "deferred_tool_proposal",
  "call_id": "...",
  "tool_name": "...",
  "tool_version": "...",
  "tool_sha256": "...",
  "arguments": {},
  "risk_level": "L1"
}
```

It does not call Tool Gateway, DB, MCP, filesystem, shell, or external network. The stop mechanism is Pi's public `AgentToolResult.terminate = true`; runtime-worker also sets Pi `toolExecution = "sequential"`.

Special durable boundary tools:

- `request_user_input`
- `handoff_to_workflow`

Mixed boundary batches fail closed with `INVALID_BOUNDARY_BATCH`.

## Temporal Governance

`piDurableAgentWorkflow` performs deterministic orchestration:

- creates `agent_run`;
- calls `runPiSegmentActivity`;
- validates proposed tool name/version/hash/risk against `AgentExecutionPlan`;
- routes L1 through Tool Gateway invoke;
- routes L3 through Tool Gateway preview -> Human Task -> Temporal Signal -> Tool Gateway commit;
- writes authoritative tool results back into the Pi context snapshot;
- handles `user_input_required` through `kind=user_input` Human Task and `userInputResponseSignal`;
- starts allowed `handoff_to_workflow` targets as child `ConfigDrivenWorkflow` executions;
- denies unauthorized, recursive, or over-budget handoff targets;
- updates `AgentRun` and `AgentStep` state at every durable boundary.

The workflow does not access DB, HTTP, model APIs, or Pi Agent Core directly.

## Context Snapshot Safety

`PiContextCodec` persists only safe recovery messages:

- user text;
- assistant text;
- assistant tool calls;
- tool result messages.

It removes or redacts:

- thinking blocks;
- hidden reasoning metadata;
- diagnostics;
- API keys;
- Authorization headers;
- cookies;
- passwords;
- tokens;
- secrets.

Tool Gateway results replace the deferred placeholder by `toolCallId` and `toolName`; they are not appended as duplicate tool results.

`AgentStep` stores boundary metadata and references, including proposed tool calls, authoritative tool result refs, human task ids, context snapshot before/after refs, handoff refs, usage, and errors. It does not store full sensitive tool result payloads.

## Budget and Recovery

`AgentBudgetLedger` is carried between segments and Continue-As-New runs. It tracks segment count, model turns, tool calls, handoff count, token usage, cost estimate, elapsed duration, and context bytes. Each segment receives only the remaining budget. Denied tool proposals still consume tool-call budget.

Context updates use the current `AgentExecutionPlan.budget.max_context_bytes`; they do not fall back to default budget values. The workflow fails clearly on context overflow rather than truncating required tool-call / tool-result recovery pairs.

`PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW` is loaded through an Activity and applied only after a safe boundary has persisted the next context snapshot. Continue-As-New carries only safe refs and ledgers, not full Pi messages.

## Workflow Handoff

`handoff_to_workflow` must target an execution plan listed in `AgentExecutionPlan.allowed_handoffs`. The worker loads the exact `FlowExecutionPlan`, requires `ConfigDrivenWorkflow`, starts a stable child workflow id, records parent/child refs in `AgentStep.handoff_refs`, writes a safe handoff result into Pi context on success, and fails the agent on denied or failed handoff according to the current policy.

## Runtime Modes

```text
PI_AGENT_MODE=disabled|deterministic|model_gateway
```

- `disabled`: no agent execution.
- `deterministic`: development/test only.
- `model_gateway`: production mode.

Production readiness fails unless `PI_AGENT_MODE=model_gateway`.

Local Docker Compose exposes the Pi and Model Gateway environment variables, but keeps
`PI_AGENT_MODE=disabled` by default. Set `PI_AGENT_MODE=model_gateway` only together
with real `MODEL_GATEWAY_BASE_URL`, `MODEL_GATEWAY_API_KEY`, and
`MODEL_GATEWAY_MODEL` values; otherwise runtime-worker should remain `not_ready`
rather than pretending agent execution is available.

Deterministic scenarios are selected with `model_policy=deterministic:<scenario>`, for example:

```text
deterministic:final_only
deterministic:readonly_tool
deterministic:l3_tool
deterministic:need_user
```

Deterministic mode still runs through real Pi `Agent.prompt()` / `Agent.continue()` and Pi tool execution. It only replaces model streaming with a deterministic Pi-compatible stream.

Model gateway mode uses the contract in `docs/21_model_gateway_contract.md`. The local mock gateway is exposed only by `infra/docker-compose.pi-smoke.yml`.
