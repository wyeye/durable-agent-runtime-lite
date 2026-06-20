# OpenAI Tool Round Trip

The OpenAI-compatible Model Gateway adapter preserves structured tool calls without executing them directly.

Runtime flow:

```text
Pi model turn
  -> assistant.tool_calls
  -> deferred tool proposal
  -> Temporal activity
  -> Tool Gateway
  -> tool result with tool_call_id
  -> second Pi model turn
  -> final
```

Rules:

- Canonical tool names such as `knowledge.search` are encoded to provider-safe names for the OpenAI-compatible request.
- Returned provider tool names are decoded back to canonical runtime names before entering Pi state.
- `tool_call_id` is preserved from assistant tool call to tool result.
- Unknown tool aliases, duplicate tool call ids, missing tool result ids, duplicate tool results, and unmatched tool results fail closed.
- Medium/high risk side effects still go through preview, Human Task, signal, commit, audit, and idempotency.
- Model output is logged through the model-call ledger as safe normalized response data; hidden chain-of-thought must not be persisted.

Containerized Ollama readonly and L3 smokes are the current release-gate proof:

```bash
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm smoke:ollama-containerized-e2e
```

Readonly evidence must show at least two `local-ollama` model calls and exactly one `knowledge.search` tool call. L3 evidence must show at least two `local-ollama` model calls, exactly one `record.write.mock` committed tool call, one approved Human Task, audit events, and one idempotency record.
