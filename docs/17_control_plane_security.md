# Control Plane Security

This phase implements the first control-plane authentication and RBAC layer. It is intentionally simple and header-based; enterprise SSO is not implemented yet.

## Identity Headers

control-plane reads identity from:

```text
x-user-id
x-tenant-id
x-roles
x-request-id
```

`x-roles` is a comma-separated list.

All write operations record `operator_id` from `x-user-id`. `tenant_id` scopes Registry queries and BFF downstream calls. `x-request-id` is included in logs and release/audit metadata when available.

## Auth Mode

```text
CONTROL_PLANE_AUTH_MODE=header|disabled
```

Rules:

- production allows only `header`;
- `disabled` is allowed only in development/test;
- production never silently uses a default administrator;
- write APIs do not allow anonymous access.

## Roles

`platform_admin`

- all reads;
- create/update draft;
- clone;
- validate;
- publish;
- gray;
- rollback;
- deprecate;
- disable;
- Human Task approve/reject;
- audit and release record reads.

`capability_operator`

- Registry reads;
- create/update draft;
- clone;
- validate;
- publish;
- gray;
- rollback;
- Human Task approve/reject;
- operations reads.

`auditor`

- read-only Registry, release, TaskRun, Human Task, Audit, and ToolCall access;
- no write operations;
- no Human Task approve/reject.

## Error Mapping

Auth and authorization errors use the standard response contract:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing control-plane identity headers"
  },
  "trace_id": "request-id"
}
```

Permission denial returns `403 FORBIDDEN`.

## BFF Boundary

control-plane BFF endpoints only proxy existing runtime-api and tool-gateway operations:

- Human Task decisions are sent to runtime-api.
- Audit and ToolCall reads are sent to tool-gateway.
- control-plane does not execute tools.
- control-plane does not copy the Human Task state machine.

Forwarded headers:

```text
x-user-id
x-tenant-id
x-roles
x-request-id
```

Downstream failures map to `503 DOWNSTREAM_UNAVAILABLE`.

## Sensitive Data

The API error mapper removes SQL, connection, stack, token, password, and secret-like details from error responses.

tool-gateway masks sensitive fields in audit payloads and tool call preview/result JSON before returning operations query responses.

No `.env`, token, credential, or private key is copied into the control-plane Docker image.
