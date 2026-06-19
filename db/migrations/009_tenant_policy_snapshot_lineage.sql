alter table tenant_runtime_policy_snapshot
  add column if not exists root_snapshot_ref text,
  add column if not exists parent_snapshot_ref text,
  add column if not exists derivation_type text,
  add column if not exists lineage_depth int;

update tenant_runtime_policy_snapshot
set root_snapshot_ref = snapshot_ref,
    derivation_type = 'root',
    lineage_depth = 0
where root_snapshot_ref is null
   or derivation_type is null
   or lineage_depth is null;

alter table tenant_runtime_policy_snapshot
  alter column root_snapshot_ref set not null,
  alter column derivation_type set not null,
  alter column lineage_depth set not null;

alter table tenant_runtime_policy_snapshot
  drop constraint if exists chk_tenant_runtime_policy_snapshot_derivation_type,
  add constraint chk_tenant_runtime_policy_snapshot_derivation_type
    check (derivation_type in ('root', 'flow_agent_child', 'workflow_handoff', 'nested_handoff'));

alter table tenant_runtime_policy_snapshot
  drop constraint if exists chk_tenant_runtime_policy_snapshot_lineage_depth,
  add constraint chk_tenant_runtime_policy_snapshot_lineage_depth
    check (lineage_depth >= 0 and lineage_depth <= 8);

alter table tenant_runtime_policy_snapshot
  drop constraint if exists chk_tenant_runtime_policy_snapshot_root_shape,
  add constraint chk_tenant_runtime_policy_snapshot_root_shape
    check (
      (derivation_type = 'root' and parent_snapshot_ref is null and root_snapshot_ref = snapshot_ref and lineage_depth = 0)
      or
      (derivation_type <> 'root' and parent_snapshot_ref is not null and root_snapshot_ref <> snapshot_ref and lineage_depth > 0)
    );

create index if not exists idx_tenant_runtime_policy_snapshot_root
  on tenant_runtime_policy_snapshot(tenant_id, root_snapshot_ref, lineage_depth);

create index if not exists idx_tenant_runtime_policy_snapshot_parent
  on tenant_runtime_policy_snapshot(tenant_id, parent_snapshot_ref);

create index if not exists idx_tenant_runtime_policy_snapshot_derivation
  on tenant_runtime_policy_snapshot(tenant_id, derivation_type, created_at desc);
