import { randomUUID } from 'node:crypto';

export function createTaskRunId(): string {
  return `task_${randomUUID().replaceAll('-', '')}`;
}

export function createRequestId(): string {
  return `req_${randomUUID().replaceAll('-', '')}`;
}
