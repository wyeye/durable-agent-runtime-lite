create table if not exists evaluation_dataset (
  dataset_id text not null,
  version int not null,
  status text not null,
  name text not null,
  description text,
  domain text,
  tags_json jsonb not null default '[]'::jsonb,
  default_weight numeric not null default 1,
  revision int not null default 1,
  dataset_hash text not null,
  created_by text,
  updated_by text,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (dataset_id, version),
  constraint chk_evaluation_dataset_status
    check (status in ('draft', 'validated', 'published', 'deprecated', 'disabled')),
  constraint chk_evaluation_dataset_hash
    check (dataset_hash ~ '^[a-f0-9]{64}$'),
  constraint chk_evaluation_dataset_revision
    check (revision > 0),
  constraint chk_evaluation_dataset_weight
    check (default_weight > 0)
);

create index if not exists idx_evaluation_dataset_status
  on evaluation_dataset(status, updated_at desc);

create table if not exists evaluation_case (
  case_id text not null,
  dataset_id text not null,
  dataset_version int not null,
  name text not null,
  description text,
  input_json jsonb not null,
  context_refs_json jsonb not null default '[]'::jsonb,
  expected_status text,
  expected_tool_calls_json jsonb not null default '[]'::jsonb,
  forbidden_tools_json jsonb not null default '[]'::jsonb,
  final_assertions_json jsonb not null default '[]'::jsonb,
  policy_assertions_json jsonb not null default '[]'::jsonb,
  latency_budget_ms int,
  input_token_budget int,
  output_token_budget int,
  total_token_budget int,
  cost_budget numeric,
  weight numeric not null default 1,
  tags_json jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (dataset_id, dataset_version, case_id),
  constraint fk_evaluation_case_dataset
    foreign key (dataset_id, dataset_version)
    references evaluation_dataset(dataset_id, version)
    on delete cascade,
  constraint chk_evaluation_case_weight
    check (weight > 0),
  constraint chk_evaluation_case_budgets
    check (
      (latency_budget_ms is null or latency_budget_ms > 0)
      and (input_token_budget is null or input_token_budget > 0)
      and (output_token_budget is null or output_token_budget > 0)
      and (total_token_budget is null or total_token_budget > 0)
      and (cost_budget is null or cost_budget >= 0)
    )
);

create index if not exists idx_evaluation_case_dataset
  on evaluation_case(dataset_id, dataset_version, enabled, case_id);

create or replace function prevent_published_evaluation_case_mutation()
returns trigger as $$
declare
  dataset_status text;
begin
  select status into dataset_status
  from evaluation_dataset
  where dataset_id = old.dataset_id and version = old.dataset_version;

  if dataset_status = 'published' then
    raise exception 'published evaluation dataset cases are immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_evaluation_case_published_immutable on evaluation_case;
create trigger trg_evaluation_case_published_immutable
before update or delete on evaluation_case
for each row execute function prevent_published_evaluation_case_mutation();

create table if not exists evaluation_subject_snapshot (
  subject_snapshot_id text primary key,
  subject_snapshot_ref text not null unique,
  primary_subject_type text not null,
  primary_subject_id text not null,
  primary_subject_version int not null,
  primary_subject_hash text not null,
  candidate_bundle_json jsonb not null,
  candidate_bundle_hash text not null unique,
  created_at timestamptz not null default now(),
  constraint chk_evaluation_subject_type
    check (primary_subject_type in ('prompt', 'agent', 'model_policy')),
  constraint chk_evaluation_subject_hash
    check (primary_subject_hash ~ '^[a-f0-9]{64}$' and candidate_bundle_hash ~ '^[a-f0-9]{64}$')
);

create index if not exists idx_evaluation_subject_snapshot_resource
  on evaluation_subject_snapshot(primary_subject_type, primary_subject_id, primary_subject_version, primary_subject_hash);

create or replace function prevent_evaluation_subject_snapshot_mutation()
returns trigger as $$
begin
  raise exception 'evaluation_subject_snapshot is immutable';
end;
$$ language plpgsql;

drop trigger if exists trg_evaluation_subject_snapshot_immutable on evaluation_subject_snapshot;
create trigger trg_evaluation_subject_snapshot_immutable
before update or delete on evaluation_subject_snapshot
for each row execute function prevent_evaluation_subject_snapshot_mutation();

create table if not exists evaluation_execution_plan (
  evaluation_execution_plan_id text primary key,
  evaluation_execution_plan_ref text not null unique,
  subject_snapshot_ref text not null,
  subject_snapshot_hash text not null,
  tenant_id text not null,
  dataset_id text not null,
  dataset_version int not null,
  dataset_hash text not null,
  candidate_bundle_hash text not null,
  plan_json jsonb not null,
  plan_hash text not null unique,
  created_at timestamptz not null default now(),
  constraint fk_evaluation_plan_dataset
    foreign key (dataset_id, dataset_version)
    references evaluation_dataset(dataset_id, version),
  constraint chk_evaluation_plan_hash
    check (
      subject_snapshot_hash ~ '^[a-f0-9]{64}$'
      and dataset_hash ~ '^[a-f0-9]{64}$'
      and candidate_bundle_hash ~ '^[a-f0-9]{64}$'
      and plan_hash ~ '^[a-f0-9]{64}$'
    )
);

create index if not exists idx_evaluation_execution_plan_subject
  on evaluation_execution_plan(subject_snapshot_ref, created_at desc);

create index if not exists idx_evaluation_execution_plan_dataset
  on evaluation_execution_plan(tenant_id, dataset_id, dataset_version, created_at desc);

create or replace function prevent_evaluation_execution_plan_mutation()
returns trigger as $$
begin
  raise exception 'evaluation_execution_plan is immutable';
end;
$$ language plpgsql;

drop trigger if exists trg_evaluation_execution_plan_immutable on evaluation_execution_plan;
create trigger trg_evaluation_execution_plan_immutable
before update or delete on evaluation_execution_plan
for each row execute function prevent_evaluation_execution_plan_mutation();

create table if not exists evaluation_run (
  evaluation_run_id text primary key,
  tenant_id text not null,
  dataset_id text not null,
  dataset_version int not null,
  dataset_hash text not null,
  subject_snapshot_ref text not null,
  subject_snapshot_hash text not null,
  evaluation_execution_plan_ref text not null,
  evaluation_execution_plan_hash text not null,
  baseline_run_id text,
  trigger_type text not null,
  status text not null,
  total_cases int not null default 0,
  completed_cases int not null default 0,
  passed_cases int not null default 0,
  failed_cases int not null default 0,
  skipped_cases int not null default 0,
  aggregate_score numeric,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fk_evaluation_run_plan
    foreign key (evaluation_execution_plan_ref)
    references evaluation_execution_plan(evaluation_execution_plan_ref),
  constraint chk_evaluation_run_trigger
    check (trigger_type in ('manual', 'publish_gate', 'regression', 'ci')),
  constraint chk_evaluation_run_status
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  constraint chk_evaluation_run_hash
    check (
      dataset_hash ~ '^[a-f0-9]{64}$'
      and subject_snapshot_hash ~ '^[a-f0-9]{64}$'
      and evaluation_execution_plan_hash ~ '^[a-f0-9]{64}$'
    )
);

create index if not exists idx_evaluation_run_tenant_status
  on evaluation_run(tenant_id, status, created_at desc);

create index if not exists idx_evaluation_run_subject
  on evaluation_run(tenant_id, subject_snapshot_ref, created_at desc);

create table if not exists evaluation_case_result (
  evaluation_case_result_id text primary key,
  evaluation_run_id text not null references evaluation_run(evaluation_run_id) on delete cascade,
  case_id text not null,
  status text not null,
  score numeric,
  metric_results_json jsonb not null default '[]'::jsonb,
  actual_status text,
  task_run_id text,
  agent_run_id text,
  model_call_ids_json jsonb not null default '[]'::jsonb,
  tool_call_ids_json jsonb not null default '[]'::jsonb,
  final_output_ref text,
  safe_output_json jsonb,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  total_tokens int,
  estimated_cost numeric,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(evaluation_run_id, case_id),
  constraint chk_evaluation_case_result_status
    check (status in ('queued', 'running', 'passed', 'failed', 'skipped', 'system_error')),
  constraint chk_evaluation_case_result_score
    check (score is null or (score >= 0 and score <= 1)),
  constraint chk_evaluation_case_safe_output_size
    check (safe_output_json is null or pg_column_size(safe_output_json) <= 1048576)
);

create index if not exists idx_evaluation_case_result_run
  on evaluation_case_result(evaluation_run_id, status, case_id);

create table if not exists evaluation_gate_policy (
  gate_policy_id text not null,
  version int not null,
  status text not null,
  resource_types_json jsonb not null,
  required_dataset_refs_json jsonb not null,
  thresholds_json jsonb not null default '{}'::jsonb,
  regression_rules_json jsonb not null default '{}'::jsonb,
  required_case_tags_json jsonb not null default '[]'::jsonb,
  allow_override boolean not null default false,
  revision int not null default 1,
  gate_policy_hash text not null,
  created_by text,
  updated_by text,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (gate_policy_id, version),
  constraint chk_evaluation_gate_policy_status
    check (status in ('draft', 'validated', 'published', 'deprecated', 'disabled')),
  constraint chk_evaluation_gate_policy_hash
    check (gate_policy_hash ~ '^[a-f0-9]{64}$'),
  constraint chk_evaluation_gate_policy_revision
    check (revision > 0)
);

create index if not exists idx_evaluation_gate_policy_status
  on evaluation_gate_policy(status, updated_at desc);

create table if not exists evaluation_gate_decision (
  gate_decision_id text primary key,
  resource_type text not null,
  resource_id text not null,
  resource_version int not null,
  resource_hash text not null,
  candidate_bundle_hash text not null,
  gate_policy_id text not null,
  gate_policy_version int not null,
  gate_policy_hash text not null,
  evaluation_run_ids_json jsonb not null,
  decision text not null,
  reasons_json jsonb not null default '[]'::jsonb,
  decided_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint fk_evaluation_gate_decision_policy
    foreign key (gate_policy_id, gate_policy_version)
    references evaluation_gate_policy(gate_policy_id, version),
  constraint chk_evaluation_gate_decision_type
    check (resource_type in ('prompt', 'agent', 'model_policy')),
  constraint chk_evaluation_gate_decision_status
    check (decision in ('passed', 'failed', 'stale', 'overridden', 'advisory_failed')),
  constraint chk_evaluation_gate_decision_hash
    check (
      resource_hash ~ '^[a-f0-9]{64}$'
      and candidate_bundle_hash ~ '^[a-f0-9]{64}$'
      and gate_policy_hash ~ '^[a-f0-9]{64}$'
    )
);

create unique index if not exists idx_evaluation_gate_decision_exact
  on evaluation_gate_decision(resource_type, resource_id, resource_version, resource_hash, candidate_bundle_hash, gate_policy_id, gate_policy_version, gate_policy_hash);

create index if not exists idx_evaluation_gate_decision_resource
  on evaluation_gate_decision(resource_type, resource_id, resource_version, decided_at desc);

create or replace function prevent_evaluation_gate_decision_mutation()
returns trigger as $$
begin
  raise exception 'evaluation_gate_decision is immutable';
end;
$$ language plpgsql;

drop trigger if exists trg_evaluation_gate_decision_immutable on evaluation_gate_decision;
create trigger trg_evaluation_gate_decision_immutable
before update or delete on evaluation_gate_decision
for each row execute function prevent_evaluation_gate_decision_mutation();

create table if not exists evaluation_gate_override (
  override_id text primary key,
  gate_decision_id text not null references evaluation_gate_decision(gate_decision_id),
  resource_type text not null,
  resource_id text not null,
  resource_version int not null,
  resource_hash text not null,
  operator_id text not null,
  reason text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint chk_evaluation_gate_override_type
    check (resource_type in ('prompt', 'agent', 'model_policy')),
  constraint chk_evaluation_gate_override_hash
    check (resource_hash ~ '^[a-f0-9]{64}$'),
  constraint chk_evaluation_gate_override_reason
    check (char_length(reason) >= 12)
);

create index if not exists idx_evaluation_gate_override_decision
  on evaluation_gate_override(gate_decision_id, created_at desc);

create index if not exists idx_evaluation_gate_override_resource
  on evaluation_gate_override(resource_type, resource_id, resource_version, resource_hash, created_at desc);

alter table capability_release
  add column if not exists evaluation_gate_decision_id text,
  add column if not exists evaluation_gate_override_id text;
