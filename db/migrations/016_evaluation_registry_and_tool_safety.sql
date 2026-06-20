create table if not exists evaluation_tool_call_reservation (
  tenant_id text not null,
  evaluation_run_id text not null,
  evaluation_case_id text not null,
  tool_name text not null,
  logical_tool_call_id text not null,
  tool_version text not null,
  operation text not null,
  idempotency_key text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, evaluation_run_id, evaluation_case_id, tool_name, logical_tool_call_id),
  constraint evaluation_tool_call_reservation_operation_chk
    check (operation in ('invoke', 'preview', 'commit'))
);

create index if not exists idx_eval_tool_call_reservation_scope
  on evaluation_tool_call_reservation (
    tenant_id,
    evaluation_run_id,
    evaluation_case_id,
    tool_name,
    created_at
  );

create unique index if not exists idx_evaluation_case_case_id_unique
  on evaluation_case(case_id);
