import type { TaskRun } from '@dar/contracts';
import { TaskRunRepository, type CreateTaskRunInput } from '@dar/db';

export interface TaskRunStore {
  create(input: CreateTaskRunInput): Promise<TaskRun>;
  get(taskRunId: string): Promise<TaskRun | undefined>;
  updateStatus(taskRunId: string, status: TaskRun['status']): Promise<TaskRun | undefined>;
}

export class InMemoryTaskRunStore implements TaskRunStore {
  private readonly taskRuns = new Map<string, TaskRun>();

  async create(input: CreateTaskRunInput): Promise<TaskRun> {
    const taskRun = input.taskRun;
    this.taskRuns.set(taskRun.task_run_id, taskRun);
    return taskRun;
  }

  async get(taskRunId: string): Promise<TaskRun | undefined> {
    return this.taskRuns.get(taskRunId);
  }

  list(): TaskRun[] {
    return [...this.taskRuns.values()];
  }

  async updateStatus(taskRunId: string, status: TaskRun['status']): Promise<TaskRun | undefined> {
    const existing = this.taskRuns.get(taskRunId);
    if (!existing) {
      return undefined;
    }

    const updated = { ...existing, status, updated_at: new Date().toISOString() };
    this.taskRuns.set(taskRunId, updated);
    return updated;
  }
}

export class DbTaskRunStore implements TaskRunStore {
  constructor(private readonly repository: TaskRunRepository) {}

  async create(input: CreateTaskRunInput): Promise<TaskRun> {
    return this.repository.create(input);
  }

  async get(taskRunId: string): Promise<TaskRun | undefined> {
    return this.repository.get(taskRunId);
  }

  async updateStatus(taskRunId: string, status: TaskRun['status']): Promise<TaskRun | undefined> {
    return this.repository.updateStatus(taskRunId, status);
  }
}
