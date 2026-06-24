# Examples

`pnpm dar db seed` publishes the sample FlowSpec, RouteSpec, ToolManifest, AgentSpec, and Prompt into PostgreSQL.

The sample flow is intentionally small:

```text
input.normalize
  -> knowledge.search
  -> agent.plan
  -> record.write.mock preview -> human confirm/reject -> commit
```

`knowledge.search` is L1 read-only and can use `invoke`.

`record.write.mock` is L3 side-effect. It must not execute through direct `invoke`; the real runtime path is:

1. worker Activity calls `tool-gateway /preview`;
2. tool-gateway writes `tool_call_log=pending_confirmation` and `audit_event=tool.preview`;
3. worker Activity creates a pending `human_task`;
4. runtime-api approve/reject writes the decision and `audit_event`;
5. approved tasks continue to `tool-gateway /commit`;
6. commit writes `tool_call_log=committed`, `audit_event=tool.commit`, and `idempotency_record`.

Local Docker smoke:

```bash
docker compose -f infra/docker-compose.yml up -d postgres valkey temporal temporal-ui
corepack pnpm dar db migrate
corepack pnpm dar db seed
docker compose -f infra/docker-compose.yml up -d tool-gateway runtime-worker runtime-api
corepack pnpm dar smoke run temporal-db
```
