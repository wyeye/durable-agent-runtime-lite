create table if not exists model_policy (
  id bigserial primary key,
  tenant_id text not null default 'default',
  model_policy_id text not null,
  version int not null,
  status text not null,
  protocol text not null,
  targets_json jsonb not null,
  retry_policy_json jsonb not null,
  fallback_policy_json jsonb not null,
  request_policy_json jsonb not null,
  revision int not null default 1,
  created_by text,
  updated_by text,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  unique(tenant_id, model_policy_id, version)
);

create unique index if not exists idx_model_policy_one_published
  on model_policy(tenant_id, model_policy_id)
  where status = 'published';

create index if not exists idx_model_policy_status
  on model_policy(tenant_id, status, updated_at desc);

create index if not exists idx_model_policy_id
  on model_policy(tenant_id, model_policy_id, version desc);

create or replace function prevent_published_model_policy_content_mutation()
returns trigger as $$
begin
  if old.status in ('published', 'gray', 'deprecated', 'disabled')
    and (
      old.protocol <> new.protocol
      or old.targets_json <> new.targets_json
      or old.retry_policy_json <> new.retry_policy_json
      or old.fallback_policy_json <> new.fallback_policy_json
      or old.request_policy_json <> new.request_policy_json
    ) then
    raise exception 'model_policy published content is immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_model_policy_published_content_immutable on model_policy;
create trigger trg_model_policy_published_content_immutable
before update on model_policy
for each row execute function prevent_published_model_policy_content_mutation();

create table if not exists model_call_log (
  model_call_id text primary key,
  model_request_key text not null unique,
  tenant_id text not null,
  user_id text,
  task_run_id text,
  workflow_id text,
  workflow_run_id text,
  agent_run_id text,
  segment_index int,
  model_turn_index int,
  model_policy_id text not null,
  model_policy_version int not null,
  model_policy_hash text not null,
  target_id text,
  provider text,
  model_id text,
  protocol text not null,
  attempt_count int not null default 0,
  fallback_index int not null default 0,
  status text not null,
  finish_reason text,
  response_id text,
  input_tokens int,
  output_tokens int,
  total_tokens int,
  estimated_cost numeric,
  latency_ms int,
  error_class text,
  error_code text,
  request_hash text not null,
  response_hash text,
  safe_response_json jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_model_call_safe_response_size check (
    safe_response_json is null or pg_column_size(safe_response_json) <= 1048576
  )
);

create index if not exists idx_model_call_log_task
  on model_call_log(tenant_id, task_run_id, created_at desc);

create index if not exists idx_model_call_log_agent
  on model_call_log(tenant_id, agent_run_id, segment_index, model_turn_index);

create index if not exists idx_model_call_log_policy
  on model_call_log(tenant_id, model_policy_id, model_policy_version, created_at desc);

create index if not exists idx_model_call_log_model
  on model_call_log(tenant_id, provider, model_id, status, created_at desc);

create table if not exists model_call_attempt (
  attempt_id text primary key,
  model_call_id text not null references model_call_log(model_call_id) on delete cascade,
  attempt_index int not null,
  target_id text not null,
  provider text,
  model_id text not null,
  status text not null,
  http_status int,
  error_class text,
  error_code text,
  latency_ms int,
  response_id text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(model_call_id, attempt_index)
);

create index if not exists idx_model_call_attempt_call
  on model_call_attempt(model_call_id, attempt_index asc);

alter table agent_execution_plan
  add column if not exists model_policy_id text,
  add column if not exists model_policy_version int,
  add column if not exists model_policy_hash text,
  add column if not exists resolved_model_policy_json jsonb;

alter table agent_run
  add column if not exists workflow_run_id text,
  add column if not exists model_policy_id text,
  add column if not exists model_policy_version int,
  add column if not exists model_policy_hash text,
  add column if not exists selected_model_id text,
  add column if not exists selected_provider text,
  add column if not exists fallback_count int not null default 0,
  add column if not exists model_call_count int not null default 0;
