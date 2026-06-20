alter table model_call_attempt
  add column if not exists global_attempt_index int,
  add column if not exists target_attempt_index int,
  add column if not exists fallback_index int;

update model_call_attempt
set
  global_attempt_index = coalesce(global_attempt_index, attempt_index),
  target_attempt_index = coalesce(target_attempt_index, attempt_index),
  fallback_index = coalesce(fallback_index, 0)
where global_attempt_index is null
  or target_attempt_index is null
  or fallback_index is null;

alter table model_call_attempt
  alter column global_attempt_index set not null,
  alter column target_attempt_index set not null,
  alter column fallback_index set not null;

drop index if exists idx_model_call_attempt_call;

create index if not exists idx_model_call_attempt_call
  on model_call_attempt(model_call_id, global_attempt_index asc);

create unique index if not exists idx_model_call_attempt_global_unique
  on model_call_attempt(model_call_id, global_attempt_index);
