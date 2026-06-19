# Policy Enforcement

Policy enforcement is deliberately layered.

## Runtime API

`runtime-api` resolves the execution plan and tenant policy snapshot before workflow start. Missing required policy, plan hash mismatch, or admission exhaustion fails before starting the workflow.

## Runtime Worker

`runtime-worker` performs fail-fast checks in Activities and service calls outside deterministic workflow logic:

- model allowed by effective policy;
- tool allowed for operation and risk;
- handoff allowed by effective policy;
- budget cap;
- snapshot ref/hash and execution plan ref/hash.

The worker never bypasses Tool Gateway for real tool execution.

## Tool Gateway

`tool-gateway` is the final authority for tools. Every invoke, preview, or commit validates:

- tool manifest exact version/hash/risk;
- tool arguments schema;
- tenant policy snapshot ref/hash;
- execution plan ref/hash;
- operation allowed by immutable snapshot;
- L3 human confirmation before commit;
- idempotency replay/conflict.

Unknown or unavailable policy state does not become empty success in production.
