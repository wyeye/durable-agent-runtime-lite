alter table evaluation_run
  drop constraint if exists chk_evaluation_run_status;

alter table evaluation_run
  add constraint chk_evaluation_run_status
    check (status in ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'));

alter table evaluation_case_result
  drop constraint if exists chk_evaluation_case_result_status;

alter table evaluation_case_result
  add constraint chk_evaluation_case_result_status
    check (status in ('queued', 'running', 'passed', 'failed', 'skipped', 'system_error', 'cancelled'));
