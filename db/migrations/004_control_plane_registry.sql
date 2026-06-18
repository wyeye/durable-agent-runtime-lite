alter table flow_definition
  add column if not exists updated_by text,
  add column if not exists published_by text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists revision int not null default 1,
  add column if not exists gray_policy_json jsonb not null default '{}'::jsonb;

alter table flow_route_config
  add column if not exists created_by text,
  add column if not exists updated_by text,
  add column if not exists published_by text,
  add column if not exists published_at timestamptz,
  add column if not exists revision int not null default 1,
  add column if not exists gray_policy_json jsonb not null default '{}'::jsonb;

alter table tool_manifest
  add column if not exists updated_by text,
  add column if not exists published_by text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists revision int not null default 1,
  add column if not exists gray_policy_json jsonb not null default '{}'::jsonb;

alter table agent_spec
  add column if not exists updated_by text,
  add column if not exists published_by text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists revision int not null default 1,
  add column if not exists gray_policy_json jsonb not null default '{}'::jsonb;

alter table prompt_definition
  add column if not exists updated_by text,
  add column if not exists published_by text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists revision int not null default 1,
  add column if not exists gray_policy_json jsonb not null default '{}'::jsonb;

update flow_definition
set status = 'deprecated',
    spec_json = jsonb_set(spec_json, '{status}', '"deprecated"', true),
    updated_at = now()
where status = 'archived';

update flow_route_config
set status = 'deprecated',
    route_spec_json = jsonb_set(route_spec_json, '{status}', '"deprecated"', true),
    updated_at = now()
where status = 'archived';

update tool_manifest
set status = 'deprecated',
    spec_json = jsonb_set(spec_json, '{status}', '"deprecated"', true),
    updated_at = now()
where status = 'archived';

update agent_spec
set status = 'deprecated',
    spec_json = jsonb_set(spec_json, '{status}', '"deprecated"', true),
    updated_at = now()
where status = 'archived';

update prompt_definition
set status = 'deprecated',
    spec_json = jsonb_set(spec_json, '{status}', '"deprecated"', true),
    updated_at = now()
where status = 'archived';

create table if not exists capability_release (
  release_id text primary key,
  tenant_id text not null default 'default',
  resource_type text not null,
  resource_id text not null,
  resource_version int not null,
  action text not null,
  previous_version int,
  target_status text not null,
  operator_id text not null,
  validation_result jsonb,
  release_note text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_capability_release_resource
  on capability_release(tenant_id, resource_type, resource_id, created_at desc);

create index if not exists idx_capability_release_action
  on capability_release(tenant_id, action, created_at desc);

create index if not exists idx_flow_definition_lifecycle
  on flow_definition(tenant_id, flow_id, status, version desc);

create index if not exists idx_flow_route_config_lifecycle
  on flow_route_config(tenant_id, route_id, status, flow_version desc);

create index if not exists idx_tool_manifest_lifecycle
  on tool_manifest(tenant_id, spec_id, status, version desc);

create index if not exists idx_agent_spec_lifecycle
  on agent_spec(tenant_id, spec_id, status, version desc);

create index if not exists idx_prompt_definition_lifecycle
  on prompt_definition(tenant_id, spec_id, status, version desc);
