create table if not exists flow_execution_plan (
  execution_plan_id text primary key,
  execution_plan_ref text not null unique,
  tenant_id text not null default 'default',
  flow_id text not null,
  flow_version int not null,
  flow_sha256 text not null,
  plan_json jsonb not null,
  execution_plan_hash text not null unique,
  generated_at timestamptz not null default now(),
  unique(tenant_id, flow_id, flow_version, execution_plan_hash)
);

create index if not exists idx_flow_execution_plan_flow
  on flow_execution_plan(tenant_id, flow_id, flow_version, generated_at desc);

alter table task_run
  add column if not exists execution_plan_ref text;

create index if not exists idx_task_run_execution_plan_ref
  on task_run(tenant_id, execution_plan_ref);
