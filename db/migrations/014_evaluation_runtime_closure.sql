alter table evaluation_run
  add column if not exists workflow_id text,
  add column if not exists workflow_run_id text,
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists system_error_cases int not null default 0,
  add column if not exists execution_started_at timestamptz,
  add column if not exists evidence_collection_status text not null default 'not_started';

do $$
begin
  alter table evaluation_run
    add constraint chk_evaluation_run_system_error_cases
      check (system_error_cases >= 0);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table evaluation_run
    add constraint chk_evaluation_run_evidence_collection_status
      check (evidence_collection_status in ('not_started', 'partial', 'completed', 'failed'));
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_evaluation_run_workflow
  on evaluation_run(workflow_id);

alter table evaluation_case_result
  add column if not exists workflow_id text,
  add column if not exists workflow_run_id text,
  add column if not exists evidence_snapshot_json jsonb,
  add column if not exists evidence_hash text,
  add column if not exists candidate_fidelity_verified boolean not null default false,
  add column if not exists assertion_failure_count int not null default 0,
  add column if not exists hard_gate_failure_count int not null default 0,
  add column if not exists system_error_class text;

do $$
begin
  alter table evaluation_case_result
    add constraint chk_evaluation_case_result_evidence_hash
      check (evidence_hash is null or evidence_hash ~ '^[a-f0-9]{64}$');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table evaluation_case_result
    add constraint chk_evaluation_case_result_failure_counts
      check (assertion_failure_count >= 0 and hard_gate_failure_count >= 0);
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_evaluation_case_result_workflow
  on evaluation_case_result(workflow_id);

create table if not exists evaluation_comparison (
  comparison_id text primary key,
  candidate_run_id text not null references evaluation_run(evaluation_run_id) on delete cascade,
  baseline_run_id text not null references evaluation_run(evaluation_run_id) on delete cascade,
  dataset_id text not null,
  dataset_version int not null,
  dataset_hash text not null,
  comparable boolean not null,
  result_json jsonb not null,
  created_by text,
  created_at timestamptz not null default now(),
  constraint chk_evaluation_comparison_dataset_hash
    check (dataset_hash ~ '^[a-f0-9]{64}$')
);

create unique index if not exists idx_evaluation_comparison_runs
  on evaluation_comparison(candidate_run_id, baseline_run_id);

alter table tool_call_log
  add column if not exists execution_context_type text,
  add column if not exists evaluation_run_id text,
  add column if not exists evaluation_case_id text,
  add column if not exists evaluation_execution_plan_ref text,
  add column if not exists evaluation_execution_plan_hash text;

do $$
begin
  alter table tool_call_log
    add constraint chk_tool_call_log_execution_context_type
      check (execution_context_type is null or execution_context_type in ('runtime', 'evaluation'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table tool_call_log
    add constraint chk_tool_call_log_evaluation_plan_hash
      check (evaluation_execution_plan_hash is null or evaluation_execution_plan_hash ~ '^[a-f0-9]{64}$');
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_tool_call_log_evaluation
  on tool_call_log(evaluation_run_id, evaluation_case_id, created_at);
