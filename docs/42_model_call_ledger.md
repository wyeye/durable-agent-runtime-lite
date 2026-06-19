# Model Call Ledger

Model calls are recorded in:

- `model_call_log`
- `model_call_attempt`

Each model turn uses a stable key:

```text
model:{agent_run_id}:segment:{segment_index}:turn:{model_turn_index}:{model_policy_hash_prefix}:{target_id}
```

The ledger records tenant, task, workflow, agent run, segment, model turn, ModelPolicy id/version/hash, target, provider, model id, protocol, attempt count, fallback index, status, finish reason, response id, usage, latency, request hash, response hash, and a safe response.

Safe response storage contains only the Pi-resumable structured result:

- text blocks, truncated for bounded storage;
- tool call blocks and JSON-object arguments;
- finish reason;
- usage.

It does not store API keys, Authorization headers, cookies, hidden reasoning, full raw provider metadata, or full sensitive prompt/context content.

If the same key and request hash has already succeeded, runtime replays the safe response. If the same key arrives with a different request hash, runtime fails closed with an idempotency conflict.
