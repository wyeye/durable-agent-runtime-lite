alter table evaluation_case
  add column if not exists minimum_case_score numeric;

do $$
begin
  alter table evaluation_case
    add constraint chk_evaluation_case_minimum_case_score
      check (minimum_case_score is null or (minimum_case_score >= 0 and minimum_case_score <= 1));
exception
  when duplicate_object then null;
end $$;
