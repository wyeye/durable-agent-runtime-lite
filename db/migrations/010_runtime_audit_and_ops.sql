alter table audit_event
  add column if not exists event_key text;

create unique index if not exists idx_audit_event_event_key
  on audit_event(event_key)
  where event_key is not null;

create index if not exists idx_audit_event_tenant_action_time
  on audit_event(tenant_id, action, occurred_at desc);

create index if not exists idx_tenant_agent_admission_workflow
  on tenant_agent_admission(tenant_id, workflow_id);

create index if not exists idx_tenant_agent_admission_acquired
  on tenant_agent_admission(tenant_id, acquired_at desc);
