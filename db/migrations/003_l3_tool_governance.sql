alter table human_task
  add column if not exists decided_by text,
  add column if not exists decided_at timestamptz,
  add column if not exists decision_reason text;

alter table tool_call_log
  add column if not exists tool_call_id text,
  add column if not exists mode text,
  add column if not exists preview_json jsonb,
  add column if not exists result_json jsonb,
  add column if not exists updated_at timestamptz not null default now();

update tool_call_log
set tool_call_id = 'tool_call_' || id::text
where tool_call_id is null;

alter table tool_call_log
  alter column tool_call_id set not null;

create unique index if not exists idx_tool_call_log_tool_call_id on tool_call_log(tool_call_id);
create index if not exists idx_human_task_task_run on human_task(tenant_id, task_run_id, created_at desc);
create index if not exists idx_human_task_payload_tool_call_id on human_task((payload ->> 'tool_call_id'));
