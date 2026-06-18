alter table task_run
  add column if not exists error_code text,
  add column if not exists error_message text;
