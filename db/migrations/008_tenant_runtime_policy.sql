create table if not exists tenant_runtime_policy (
  id bigserial primary key,
  tenant_id text not null,
  version int not null,
  status text not null,
  allowed_tools_json jsonb not null default '[]'::jsonb,
  denied_tools_json jsonb not null default '[]'::jsonb,
  allowed_models_json jsonb not null default '[]'::jsonb,
  denied_models_json jsonb not null default '[]'::jsonb,
  allowed_handoffs_json jsonb not null default '[]'::jsonb,
  denied_handoffs_json jsonb not null default '[]'::jsonb,
  budget_cap_json jsonb not null default '{}'::jsonb,
  max_concurrent_agent_runs int not null,
  revision int not null default 1,
  created_by text,
  updated_by text,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  unique(tenant_id, version),
  constraint chk_tenant_runtime_policy_status
    check (status in ('draft', 'validated', 'published', 'deprecated', 'disabled')),
  constraint chk_tenant_runtime_policy_concurrency
    check (max_concurrent_agent_runs > 0),
  constraint chk_tenant_runtime_policy_revision
    check (revision > 0)
);

create unique index if not exists idx_tenant_runtime_policy_one_published
  on tenant_runtime_policy(tenant_id)
  where status = 'published';

create index if not exists idx_tenant_runtime_policy_status
  on tenant_runtime_policy(tenant_id, status, version desc);

create or replace function prevent_published_tenant_runtime_policy_mutation()
returns trigger as $$
begin
  if old.status in ('published', 'deprecated', 'disabled') then
    if old.allowed_tools_json <> new.allowed_tools_json
      or old.denied_tools_json <> new.denied_tools_json
      or old.allowed_models_json <> new.allowed_models_json
      or old.denied_models_json <> new.denied_models_json
      or old.allowed_handoffs_json <> new.allowed_handoffs_json
      or old.denied_handoffs_json <> new.denied_handoffs_json
      or old.budget_cap_json <> new.budget_cap_json
      or old.max_concurrent_agent_runs <> new.max_concurrent_agent_runs then
      raise exception 'published tenant_runtime_policy content is immutable';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_tenant_runtime_policy_immutable_content on tenant_runtime_policy;
create trigger trg_tenant_runtime_policy_immutable_content
before update on tenant_runtime_policy
for each row execute function prevent_published_tenant_runtime_policy_mutation();

create table if not exists tenant_runtime_policy_snapshot (
  snapshot_id text primary key,
  snapshot_ref text not null unique,
  tenant_id text not null,
  source_policy_version int not null,
  source_policy_hash text not null,
  execution_plan_ref text not null,
  execution_plan_hash text not null,
  execution_plan_type text not null,
  policy_json jsonb not null,
  resolved_policy_json jsonb not null,
  snapshot_hash text not null,
  created_at timestamptz not null default now(),
  constraint chk_tenant_runtime_policy_snapshot_type
    check (execution_plan_type in ('flow', 'agent'))
);

create unique index if not exists idx_tenant_runtime_policy_snapshot_hash
  on tenant_runtime_policy_snapshot(tenant_id, snapshot_hash);

create index if not exists idx_tenant_runtime_policy_snapshot_tenant
  on tenant_runtime_policy_snapshot(tenant_id, created_at desc);

create index if not exists idx_tenant_runtime_policy_snapshot_plan
  on tenant_runtime_policy_snapshot(tenant_id, execution_plan_ref);

create or replace function prevent_tenant_runtime_policy_snapshot_mutation()
returns trigger as $$
begin
  raise exception 'tenant_runtime_policy_snapshot is immutable';
end;
$$ language plpgsql;

drop trigger if exists trg_tenant_runtime_policy_snapshot_immutable on tenant_runtime_policy_snapshot;
create trigger trg_tenant_runtime_policy_snapshot_immutable
before update on tenant_runtime_policy_snapshot
for each row execute function prevent_tenant_runtime_policy_snapshot_mutation();

create table if not exists tenant_agent_admission (
  admission_id text primary key,
  tenant_id text not null,
  task_run_id text not null unique,
  agent_run_id text,
  workflow_id text,
  workflow_run_id text,
  policy_snapshot_ref text not null,
  status text not null,
  acquired_at timestamptz not null default now(),
  activated_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz not null default now(),
  release_reason text,
  revision int not null default 1,
  constraint chk_tenant_agent_admission_status
    check (status in ('reserved', 'active', 'released', 'rejected', 'orphaned', 'reconciled')),
  constraint chk_tenant_agent_admission_revision
    check (revision > 0)
);

create index if not exists idx_tenant_agent_admission_active
  on tenant_agent_admission(tenant_id, status, updated_at desc)
  where status in ('reserved', 'active');

create index if not exists idx_tenant_agent_admission_snapshot
  on tenant_agent_admission(tenant_id, policy_snapshot_ref);

alter table task_run
  add column if not exists tenant_policy_snapshot_ref text,
  add column if not exists tenant_policy_hash text,
  add column if not exists tenant_admission_id text;

create index if not exists idx_task_run_tenant_policy_snapshot
  on task_run(tenant_id, tenant_policy_snapshot_ref);

alter table agent_run
  add column if not exists tenant_policy_snapshot_ref text,
  add column if not exists tenant_policy_version int,
  add column if not exists tenant_policy_hash text,
  add column if not exists tenant_admission_id text;

create index if not exists idx_agent_run_tenant_policy_snapshot
  on agent_run(tenant_id, tenant_policy_snapshot_ref);

alter table tool_call_log
  add column if not exists tenant_policy_snapshot_ref text,
  add column if not exists policy_decision_code text;

create index if not exists idx_tool_call_log_tenant_policy_snapshot
  on tool_call_log(tenant_id, tenant_policy_snapshot_ref);
