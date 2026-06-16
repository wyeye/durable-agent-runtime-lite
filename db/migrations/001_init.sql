create extension if not exists vector;

create table if not exists flow_definition (
  id bigserial primary key,
  flow_id text not null,
  version int not null,
  status text not null,
  flow_spec_json jsonb not null,
  flow_hash text not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique(flow_id, version)
);

create table if not exists route_definition (
  id bigserial primary key,
  flow_id text not null,
  version int not null,
  route_spec_json jsonb not null,
  priority int not null default 50,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
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
  created_at timestamptz not null default now()
);
