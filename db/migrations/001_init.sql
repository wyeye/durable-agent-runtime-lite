create extension if not exists vector;

create table if not exists schema_migration (
  version text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

create table if not exists flow_definition (
  id bigserial primary key,
  tenant_id text not null default 'default',
  flow_id text not null,
  version int not null,
  status text not null,
  spec_json jsonb not null,
  sha256 text not null,
  created_by text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique(tenant_id, flow_id, version)
);

create table if not exists flow_route_config (
  id bigserial primary key,
  tenant_id text not null default 'default',
  route_id text not null,
  flow_id text not null,
  flow_version int not null,
  status text not null,
  route_spec_json jsonb not null,
  priority int not null default 50,
  sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id, route_id, flow_version)
);

create table if not exists flow_route_embedding (
  id bigserial primary key,
  tenant_id text not null default 'default',
  route_id text not null,
  flow_id text not null,
  flow_version int not null,
  example_text text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create table if not exists agent_spec (
  id bigserial primary key,
  tenant_id text not null default 'default',
  spec_id text not null,
  version int not null,
  status text not null,
  spec_json jsonb not null,
  sha256 text not null,
  created_by text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique(tenant_id, spec_id, version)
);

create table if not exists tool_manifest (
  id bigserial primary key,
  tenant_id text not null default 'default',
  spec_id text not null,
  version int not null,
  status text not null,
  spec_json jsonb not null,
  sha256 text not null,
  created_by text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique(tenant_id, spec_id, version)
);

create table if not exists prompt_definition (
  id bigserial primary key,
  tenant_id text not null default 'default',
  spec_id text not null,
  version int not null,
  status text not null,
  spec_json jsonb not null,
  sha256 text not null,
  created_by text,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique(tenant_id, spec_id, version)
);

create table if not exists task_run (
  task_run_id text primary key,
  tenant_id text not null,
  user_id text not null,
  route_type text not null,
  flow_id text,
  flow_version int,
  workflow_id text,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists human_task (
  human_task_id text primary key,
  tenant_id text not null,
  task_run_id text not null,
  workflow_id text,
  status text not null,
  assignee text,
  candidate_groups jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  decision jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists audit_event (
  event_id text primary key,
  tenant_id text not null,
  actor_id text,
  action text not null,
  target_type text not null,
  target_id text not null,
  result text not null,
  reason text,
  payload jsonb not null default '{}'::jsonb,
  trace_id text,
  occurred_at timestamptz not null default now()
);

create table if not exists idempotency_record (
  idempotency_key text primary key,
  tenant_id text not null,
  target_type text not null,
  target_id text not null,
  request_hash text not null,
  response_json jsonb,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tool_call_log (
  id bigserial primary key,
  task_run_id text,
  workflow_id text,
  tenant_id text not null,
  user_id text,
  tool_name text not null,
  tool_version text not null,
  risk_level text not null,
  policy_decision text not null,
  status text not null,
  duration_ms int,
  idempotency_key text,
  input_hash text,
  output_hash text,
  error_code text,
  adapter_type text,
  created_at timestamptz not null default now()
);

create index if not exists idx_flow_definition_status on flow_definition(tenant_id, status, flow_id, version);
create index if not exists idx_flow_route_config_lookup on flow_route_config(tenant_id, status, priority desc);
create index if not exists idx_task_run_tenant_status on task_run(tenant_id, status, created_at desc);
create index if not exists idx_human_task_status on human_task(tenant_id, status, created_at desc);
create index if not exists idx_audit_event_target on audit_event(tenant_id, target_type, target_id, occurred_at desc);
create index if not exists idx_tool_call_log_task on tool_call_log(tenant_id, task_run_id, created_at desc);
