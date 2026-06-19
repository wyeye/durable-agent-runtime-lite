alter table agent_run
  add column if not exists workflow_run_id text;

alter table agent_step
  add column if not exists authoritative_tool_result_refs_json jsonb not null default '[]'::jsonb,
  add column if not exists human_task_ids_json jsonb not null default '[]'::jsonb,
  add column if not exists context_snapshot_before_ref jsonb,
  add column if not exists context_snapshot_after_ref jsonb,
  add column if not exists handoff_refs_json jsonb not null default '[]'::jsonb;

update agent_step
set authoritative_tool_result_refs_json = tool_result_refs_json
where authoritative_tool_result_refs_json = '[]'::jsonb
  and tool_result_refs_json <> '[]'::jsonb;
