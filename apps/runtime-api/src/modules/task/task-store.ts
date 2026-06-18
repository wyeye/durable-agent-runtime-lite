import type { TaskRun } from '@dar/contracts';
import { TaskRunRepository, type CreateTaskRunInput, type UpdateTaskRunStatusInput } from '@dar/db';
import type { WorkflowStartResponse } from '@dar/contracts';

export interface TaskRunStore {
  create(input: CreateTaskRunInput): Promise<TaskRun>;
  get(taskRunId: string): Promise<TaskRun | undefined>;
  updateStatus(
    taskRunId: string,
    input: TaskRun['status'] | UpdateTaskRunStatusInput,
  ): Promise<TaskRun | undefined>;
  updateWorkflowStart(taskRunId: string, workflowStart: WorkflowStartResponse): Promise<TaskRun | undefined>;
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

  async updateStatus(
    taskRunId: string,
    input: TaskRun['status'] | UpdateTaskRunStatusInput,
  ): Promise<TaskRun | undefined> {
    const existing = this.taskRuns.get(taskRunId);
    if (!existing) {
      return undefined;
    }

    const status = typeof input === 'string' ? input : input.status;
    const errorCode = typeof input === 'string' ? undefined : input.errorCode;
    const errorMessage = typeof input === 'string' ? undefined : input.errorMessage;
    const updated = {
      ...existing,
      status,
      error_code: status === 'failed' || status === 'failed_to_start' ? errorCode ?? 'WORKFLOW_FAILED' : undefined,
      error_message: status === 'failed' || status === 'failed_to_start' ? errorMessage ?? 'Workflow failed' : undefined,
      updated_at: new Date().toISOString(),
    };
    this.taskRuns.set(taskRunId, updated);
    return updated;
  }

  async updateWorkflowStart(taskRunId: string): Promise<TaskRun | undefined> {
    const existing = this.taskRuns.get(taskRunId);
    if (!existing) {
      return undefined;
    }

    const updated = { ...existing, updated_at: new Date().toISOString() };
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

  async updateStatus(
    taskRunId: string,
    input: TaskRun['status'] | UpdateTaskRunStatusInput,
  ): Promise<TaskRun | undefined> {
    return this.repository.updateStatus(taskRunId, input);
  }

  async updateWorkflowStart(
    taskRunId: string,
    workflowStart: WorkflowStartResponse,
  ): Promise<TaskRun | undefined> {
    return this.repository.updateWorkflowStart(taskRunId, workflowStart);
  }
}
