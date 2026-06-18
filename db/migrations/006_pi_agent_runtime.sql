create table if not exists agent_execution_plan (
  execution_plan_id text primary key,
  execution_plan_ref text not null unique,
  tenant_id text not null default 'default',
  agent_id text not null,
  agent_version int not null,
  agent_sha256 text not null,
  prompt_id text not null,
  prompt_version int not null,
  prompt_sha256 text not null,
  model_policy_json jsonb not null,
  allowed_tools_json jsonb not null,
  allowed_handoffs_json jsonb not null default '[]'::jsonb,
  output_schema_json jsonb,
  budget_json jsonb not null,
  plan_json jsonb not null,
  execution_plan_hash text not null unique,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(tenant_id, agent_id, agent_version, execution_plan_hash)
);

create index if not exists idx_agent_execution_plan_agent
  on agent_execution_plan(tenant_id, agent_id, agent_version, generated_at desc);

create or replace function prevent_agent_execution_plan_mutation()
returns trigger as $$
begin
  if old.execution_plan_hash <> new.execution_plan_hash
    or old.plan_json <> new.plan_json
    or old.execution_plan_ref <> new.execution_plan_ref then
    raise exception 'agent_execution_plan is immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_agent_execution_plan_immutable on agent_execution_plan;
create trigger trg_agent_execution_plan_immutable
before update on agent_execution_plan
for each row execute function prevent_agent_execution_plan_mutation();

create table if not exists agent_run (
  agent_run_id text primary key,
  tenant_id text not null,
  user_id text not null,
  task_run_id text not null,
  workflow_id text not null,
  parent_workflow_id text,
  execution_plan_ref text not null,
  execution_plan_hash text not null,
  agent_id text not null,
  agent_version int not null,
  prompt_id text not null,
  prompt_version int not null,
  model text not null,
  execution_mode text not null,
  status text not null,
  current_segment_index int not null default 0,
  model_turn_count int not null default 0,
  tool_call_count int not null default 0,
  handoff_count int not null default 0,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  total_tokens int not null default 0,
  estimated_cost numeric,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_run_tenant_status
  on agent_run(tenant_id, status, created_at desc);

create index if not exists idx_agent_run_task
  on agent_run(tenant_id, task_run_id, created_at desc);

create table if not exists agent_step (
  agent_step_id text primary key,
  agent_run_id text not null references agent_run(agent_run_id) on delete cascade,
  segment_index int not null,
  stable_step_key text not null unique,
  segment_status text not null,
  decision_summary text,
  proposed_tool_calls_json jsonb not null default '[]'::jsonb,
  tool_result_refs_json jsonb not null default '[]'::jsonb,
  context_snapshot_ref jsonb,
  output_ref text,
  usage_json jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(agent_run_id, segment_index),
  constraint chk_agent_step_decision_summary_len check (decision_summary is null or char_length(decision_summary) <= 2000)
);

create index if not exists idx_agent_step_run
  on agent_step(agent_run_id, segment_index asc);

create table if not exists agent_context_snapshot (
  snapshot_id text primary key,
  agent_run_id text not null references agent_run(agent_run_id) on delete cascade,
  previous_snapshot_id text references agent_context_snapshot(snapshot_id),
  schema_version text not null,
  sanitized_messages_json jsonb not null,
  snapshot_hash text not null unique,
  message_count int not null,
  byte_size int not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_context_snapshot_run
  on agent_context_snapshot(agent_run_id, created_at desc);

create or replace function prevent_agent_context_snapshot_mutation()
returns trigger as $$
begin
  raise exception 'agent_context_snapshot is immutable';
end;
$$ language plpgsql;

drop trigger if exists trg_agent_context_snapshot_immutable on agent_context_snapshot;
create trigger trg_agent_context_snapshot_immutable
before update on agent_context_snapshot
for each row execute function prevent_agent_context_snapshot_mutation();

alter table human_task
  add column if not exists kind text not null default 'approval',
  add column if not exists requested_schema_json jsonb,
  add column if not exists response_json jsonb,
  add column if not exists responded_by text,
  add column if not exists responded_at timestamptz,
  add column if not exists response_idempotency_key text;

create unique index if not exists idx_human_task_response_idempotency
  on human_task(tenant_id, human_task_id, response_idempotency_key)
  where response_idempotency_key is not null;
