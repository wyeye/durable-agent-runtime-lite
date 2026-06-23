# Registry Lifecycle

This phase adds the backend governance foundation for FlowSpec, RouteSpec, ToolManifest, AgentSpec, and PromptDefinition.

## Status Machine

Valid statuses for new data are:

- `draft`
- `validated`
- `published`
- `gray`
- `deprecated`
- `disabled`

`archived` is not valid for new contract data. Development data is reset through the single baseline migration, so no old `archived` compatibility conversion is maintained.

Allowed transitions:

```text
draft -> validated
validated -> draft
validated -> published
published -> gray
gray -> published
published -> deprecated
gray -> deprecated
draft -> disabled
validated -> disabled
published -> disabled
gray -> disabled
```

Disallowed direct restore paths include `published -> draft`, `gray -> draft`, `deprecated -> published`, and `disabled -> published`. Re-enabling must clone a new version.

## Immutability And Optimistic Locking

`draft` and `validated` versions can be edited through `updateDraft`.

Rules:

- Editing a `validated` version moves it back to `draft`.
- `published`, `gray`, `deprecated`, and `disabled` versions cannot be edited through `updateDraft`.
- `updateDraft` requires `expectedRevision`.
- A revision mismatch returns `REGISTRY_OPTIMISTIC_LOCK_CONFLICT`.
- Successful draft updates increment `revision`.
- Published version content is immutable; changes must use `cloneVersion`.

## Baseline Schema

`db/migrations/001_baseline.sql` defines governance columns for:

- `flow_definition`
- `flow_route_config`
- `tool_manifest`
- `agent_spec`
- `prompt_definition`

Added columns include `updated_by`, `published_by`, `updated_at`, `published_at` where missing, `revision`, and `gray_policy_json`.

The baseline also defines:

- `capability_release`
- lifecycle indexes for registry resources
- release history indexes

The repository migration runner wraps the baseline migration in a transaction, so partial application rolls back on failure.

## Capability Releases

`capability_release` records append-only release actions:

- `publish`
- `gray`
- `rollback`
- `disable`
- `deprecate`

Each release records the resource type, resource id, version, previous version when known, target status, operator, validation result, release note, metadata, and timestamp.

Publish, gray, rollback, deprecate, and disable operations also write `audit_event`.

## Release Transactions

`RegistryReleaseService` performs release operations inside DB transactions.

Implemented operations:

- `validate`
- `publish`
- `publishFlowWithRoute`
- `setGray`
- `rollback`
- `deprecate`
- `disable`

If validation or any write fails, the transaction fails and no release record should be left behind.

`publishFlowWithRoute` publishes Flow and bound Route in one transaction. The Flow is published first inside the transaction so Route validation can depend on the just-published Flow; if Route validation fails, the whole transaction rolls back.

## Rollback Semantics

Rollback does not rewrite historical spec content.

The current implementation requires the rollback target version to already be `published`. Rollback marks later `published` or `gray` versions of the same resource as `deprecated`, then writes a new `capability_release` action.

Temporal workflow inputs continue to use `db://flow/{flow_id}/versions/{version}` snapshot refs, so already-running workflows keep their startup version. New requests use the current published/gray selection.

## Gray Allowlist

Gray data uses `gray_policy_json` with:

- `tenant_allowlist`
- `user_allowlist`

Selection is deterministic:

- If tenant or user is in the gray allowlist, choose the `gray` version.
- Otherwise choose the `published` version.
- No random split is used.

`runtime-api` and `tool-gateway` keep production execution limited to `published` and `gray`. `draft`, `validated`, `deprecated`, and `disabled` are not executable statuses.

## Validation Service

`RegistryValidationService` validates:

- FlowSpec schema, step ids, condition targets, mapping syntax, dependency presence/status, L3 confirmation mode, and L4 auto-execution denial.
- RouteSpec schema, Flow dependency, thresholds, match signals, channel/role strings, and obvious keyword conflicts.
- ToolManifest schema shape, risk/side-effect consistency, L3/L4 rules, adapter config, and plaintext secret patterns.
- AgentSpec prompt/tool dependencies, limits, output schema, direct URL, and secret patterns.
- PromptDefinition content, variables, and secret patterns.

Validation returns:

- `valid`
- `can_publish`
- `errors`
- `warnings`
- `dependency_graph`

## Current Non-Goals

This backend batch does not implement:

- control-plane HTTP management API
- React pages
- control-plane Docker shape changes
- real Pi integration
- real business system adapters
- a fifth production app
