create table if not exists model_gateway_profile (
  profile_id text primary key,
  display_name text not null,
  protocol text not null,
  base_url text not null,
  auth_type text not null,
  status text not null,
  config_hash text not null,
  revision int not null default 1,
  credential_ciphertext text,
  credential_iv text,
  credential_auth_tag text,
  credential_fingerprint text,
  credential_revision int not null default 0,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  disabled_at timestamptz,
  constraint chk_model_gateway_profile_protocol check (protocol in ('openai_chat_completions')),
  constraint chk_model_gateway_profile_auth_type check (auth_type in ('none', 'bearer')),
  constraint chk_model_gateway_profile_status check (status in ('draft', 'published', 'disabled')),
  constraint chk_model_gateway_profile_bearer_credential check (
    (auth_type = 'bearer' and credential_ciphertext is not null and credential_iv is not null and credential_auth_tag is not null and credential_fingerprint is not null)
    or
    (auth_type = 'none' and credential_ciphertext is null and credential_iv is null and credential_auth_tag is null and credential_fingerprint is null)
  )
);

create index if not exists idx_model_gateway_profile_status
  on model_gateway_profile(status, updated_at desc);

create or replace function prevent_published_model_gateway_profile_public_config_mutation()
returns trigger as $$
begin
  if old.status = 'published'
    and (
      old.display_name <> new.display_name
      or old.protocol <> new.protocol
      or old.base_url <> new.base_url
      or old.auth_type <> new.auth_type
      or old.config_hash <> new.config_hash
    ) then
    raise exception 'model_gateway_profile published public config is immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_model_gateway_profile_published_public_config_immutable on model_gateway_profile;
create trigger trg_model_gateway_profile_published_public_config_immutable
before update on model_gateway_profile
for each row execute function prevent_published_model_gateway_profile_public_config_mutation();

create table if not exists model_definition (
  model_id text not null,
  version int not null,
  display_name text not null,
  gateway_profile_id text not null references model_gateway_profile(profile_id),
  gateway_profile_config_hash text not null,
  upstream_model_id text not null,
  provider text not null,
  capabilities_json jsonb not null,
  context_window int not null,
  max_output_tokens int not null,
  input_cost_per_million numeric not null default 0,
  output_cost_per_million numeric not null default 0,
  currency text not null default 'USD',
  tags_json jsonb not null default '[]'::jsonb,
  status text not null,
  revision int not null default 1,
  model_hash text not null,
  created_by text,
  updated_by text,
  published_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  disabled_at timestamptz,
  primary key(model_id, version),
  constraint chk_model_definition_status check (status in ('draft', 'validated', 'published', 'disabled', 'deprecated')),
  constraint chk_model_definition_context_window check (context_window > 0),
  constraint chk_model_definition_max_output_tokens check (max_output_tokens > 0),
  constraint chk_model_definition_costs check (input_cost_per_million >= 0 and output_cost_per_million >= 0)
);

create index if not exists idx_model_definition_status
  on model_definition(status, updated_at desc);

create index if not exists idx_model_definition_gateway
  on model_definition(gateway_profile_id, status, updated_at desc);

create or replace function prevent_published_model_definition_content_mutation()
returns trigger as $$
begin
  if old.status in ('published', 'disabled', 'deprecated')
    and (
      old.display_name <> new.display_name
      or old.gateway_profile_id <> new.gateway_profile_id
      or old.gateway_profile_config_hash <> new.gateway_profile_config_hash
      or old.upstream_model_id <> new.upstream_model_id
      or old.provider <> new.provider
      or old.capabilities_json <> new.capabilities_json
      or old.context_window <> new.context_window
      or old.max_output_tokens <> new.max_output_tokens
      or old.input_cost_per_million <> new.input_cost_per_million
      or old.output_cost_per_million <> new.output_cost_per_million
      or old.currency <> new.currency
      or old.tags_json <> new.tags_json
      or old.model_hash <> new.model_hash
    ) then
    raise exception 'model_definition published content is immutable';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_model_definition_published_content_immutable on model_definition;
create trigger trg_model_definition_published_content_immutable
before update on model_definition
for each row execute function prevent_published_model_definition_content_mutation();

alter table model_call_log
  add column if not exists model_version int,
  add column if not exists model_hash text,
  add column if not exists gateway_profile_id text,
  add column if not exists gateway_profile_config_hash text,
  add column if not exists credential_fingerprint text,
  add column if not exists credential_revision int,
  add column if not exists upstream_model_id text;

alter table model_call_attempt
  add column if not exists global_attempt_index int,
  add column if not exists target_attempt_index int,
  add column if not exists fallback_index int not null default 0,
  add column if not exists model_version int,
  add column if not exists model_hash text,
  add column if not exists gateway_profile_id text,
  add column if not exists gateway_profile_config_hash text,
  add column if not exists credential_fingerprint text,
  add column if not exists credential_revision int,
  add column if not exists upstream_model_id text;

update model_call_attempt
set global_attempt_index = coalesce(global_attempt_index, attempt_index),
    target_attempt_index = coalesce(target_attempt_index, attempt_index)
where global_attempt_index is null or target_attempt_index is null;

alter table model_call_attempt
  alter column global_attempt_index set not null,
  alter column target_attempt_index set not null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'model_call_attempt_model_call_id_attempt_index_key'
  ) then
    alter table model_call_attempt drop constraint model_call_attempt_model_call_id_attempt_index_key;
  end if;
end;
$$;

drop index if exists idx_model_call_attempt_call;
drop index if exists model_call_attempt_model_call_id_attempt_index_key;

create unique index if not exists idx_model_call_attempt_global
  on model_call_attempt(model_call_id, global_attempt_index);

create index if not exists idx_model_call_attempt_call
  on model_call_attempt(model_call_id, global_attempt_index asc);

create index if not exists idx_model_call_log_gateway_model
  on model_call_log(tenant_id, gateway_profile_id, model_id, model_version, status, created_at desc);
