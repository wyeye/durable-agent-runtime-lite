# Runtime Readiness

`/healthz` means the process is alive. `/readyz` means the process can serve the real runtime path without falling back to mock, memory, or placeholder dependencies.

## Runtime API

`runtime-api /readyz` uses `RuntimeApiReadinessService` and checks:

- config;
- PostgreSQL lightweight read probe;
- Route Registry read probe;
- Temporal connection probe;
- Tenant Policy repository read probe;
- production auth mode.

Production readiness requires:

```text
RUNTIME_API_AUTH_MODE=header
RUNTIME_API_ROUTE_SOURCE=db
RUNTIME_API_WORKFLOW_STARTER=temporal
TENANT_RUNTIME_POLICY_MODE=required
```

## Tool Gateway

`tool-gateway /readyz` uses `ToolGatewayReadinessService` and checks:

- config;
- PostgreSQL lightweight read probe;
- Tool Registry read probe;
- Tenant Policy Snapshot store read probe;
- service-token configuration.

Production readiness requires:

```text
TOOL_GATEWAY_REGISTRY_SOURCE=db
TOOL_GATEWAY_AUTH_MODE=service_token
TENANT_RUNTIME_POLICY_MODE=required
```

Runtime-worker and control-plane service tokens must exist, differ, meet the minimum length, and not be known placeholders. Probe responses return safe codes and do not expose connection strings, token values, or raw internal error messages.

## Debug Endpoint

`GET /v1/idempotency-records/:key` is disabled by default:

```text
TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED=false
```

When enabled it requires `idempotency:debug`; it no longer reuses `tool_call:read`.
