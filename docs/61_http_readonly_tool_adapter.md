# HTTP Readonly Tool Adapter

`http_readonly` is the MVP adapter for generic read-only HTTP tools. It keeps HTTP execution inside `tool-gateway`; Pi, `runtime-api`, `runtime-worker`, and the control-plane never receive direct HTTP or business-system capabilities.

## Scope

Supported:

- GET only.
- `risk_level=L0|L1`.
- `side_effect=false`.
- Fixed `base_url` and `path` from ToolManifest.
- Tool arguments mapped to query parameters through `URLSearchParams`.
- JSON responses only.
- Optional simple dot-path response body selection.
- Output validation through Tool `output_schema`.

Not supported in this MVP:

- POST, PUT, PATCH, DELETE, request bodies, path parameter replacement, redirects, arbitrary headers, OAuth, MCP, SQL tools, browser automation, L3 HTTP commit, or production secret-manager integration.

## Manifest Example

```json
{
  "tool_name": "company.policy.lookup",
  "version": "1.0.0",
  "risk_level": "L1",
  "side_effect": false,
  "adapter": {
    "type": "http_readonly",
    "base_url": "https://policy.example.internal",
    "path": "/business-api/v1/policies",
    "query_mapping": { "keyword": "query" },
    "static_query": { "locale": "zh-CN" },
    "auth": { "type": "bearer_env", "secret_ref": "env:TOOL_SECRET_POLICY_API" },
    "timeout_ms": 5000,
    "max_response_bytes": 65536,
    "retry": {
      "max_attempts": 2,
      "retryable_status_codes": [408, 429, 500, 502, 503, 504],
      "backoff_ms": 100
    },
    "response_body_path": "data",
    "response_headers_allowlist": []
  },
  "input_schema": {
    "type": "object",
    "required": ["query"],
    "properties": { "query": { "type": "string" } }
  },
  "output_schema": {
    "type": "object",
    "required": ["items"],
    "properties": { "items": { "type": "array" } }
  }
}
```

`company.policy.lookup` is a smoke-test example only. The adapter remains generic and must not embed domain-specific behavior.

## Security Policy

Production defaults:

- `https:` only.
- Explicit Host allowlist through `TOOL_HTTP_ALLOWED_HOSTS`.
- No wildcard `*`.
- No username/password URL components.
- No fragment.
- No redirects.
- DNS result validation after host lookup.
- SSRF blocks for loopback, link-local, metadata, unspecified and unapproved private addresses.

Development/test may explicitly allow local HTTP:

```text
TOOL_HTTP_ALLOWED_HOSTS=mock-server,localhost,127.0.0.1
TOOL_HTTP_ALLOW_INSECURE_LOCALHOST=true
```

This is only for local smoke and CI. Real internal service hosts must be explicitly listed, and the risk of private network access must be reviewed.

## Secrets

Manifest values never contain API keys. Supported auth modes:

```json
{ "type": "none" }
{ "type": "bearer_env", "secret_ref": "env:TOOL_SECRET_POLICY_API" }
{ "type": "api_key_env", "secret_ref": "env:TOOL_SECRET_POLICY_API", "header_name": "X-API-Key" }
```

`secret_ref` must match `env:TOOL_SECRET_[A-Z0-9_]+`. Missing secrets fail closed with `TOOL_HTTP_SECRET_NOT_CONFIGURED` before any network request. In this MVP, changing a secret requires restarting `tool-gateway`.

## Runtime Limits

Environment ceilings:

```text
TOOL_HTTP_MAX_TIMEOUT_MS=15000
TOOL_HTTP_MAX_RESPONSE_BYTES=1048576
```

The adapter supports AbortSignal and bounded retry for GET requests. Retry is limited to retryable network errors and status codes such as `408`, `429`, `500`, `502`, `503`, and `504`. It does not retry `400`, `401`, `403`, or `404`.

## Persistence And Audit

Tool Gateway remains the source of truth for policy, schema validation, tenant policy, idempotency and audit. ToolCall and Audit records store normalized results and stable error codes. Raw response headers, full upstream error bodies and secrets are not persisted.

## Control-Plane Configuration

The Tool visual editor exposes `http_readonly` fields in Chinese, keeps JSON read-only, restricts risk to `L0` / `L1`, forces `side_effect=false`, and asks only for `env:TOOL_SECRET_*` references.

## Smoke

Local/CI development smoke:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml up -d mock-server tool-gateway runtime-worker runtime-api control-plane
corepack pnpm smoke:http-readonly-tool-e2e
```

The smoke uses `devtools/mock-server` as an external HTTP API simulator, checks Bearer auth, expects one external request for the success path, and verifies ToolCall, Audit and Idempotency evidence.
