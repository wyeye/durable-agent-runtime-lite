import type { TaskRun } from '@dar/contracts';

export class InMemoryTaskRunStore {
  private readonly taskRuns = new Map<string, TaskRun>();

  create(taskRun: TaskRun): TaskRun {
    this.taskRuns.set(taskRun.task_run_id, taskRun);
    return taskRun;
  }

  get(taskRunId: string): TaskRun | undefined {
    return this.taskRuns.get(taskRunId);
  }

  list(): TaskRun[] {
    return [...this.taskRuns.values()];
  }
}
