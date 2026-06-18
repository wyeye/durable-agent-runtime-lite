# Pi Segmented Agent Runtime

AR-1 introduces a real Pi Agent Core inner loop supervised by Temporal segment boundaries.

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
- denies unauthorized handoff targets.

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
