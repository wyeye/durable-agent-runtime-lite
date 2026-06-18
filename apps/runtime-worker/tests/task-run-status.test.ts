import { describe, expect, it, vi } from 'vitest';

const statusUpdates = vi.hoisted(() => [] as Array<{ taskRunId: string; input: unknown }>);

vi.mock('@dar/config', () => ({
  getToolGatewayUrl: () => 'http://localhost:3200',
  loadConfig: () => ({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    TOOL_GATEWAY_URL: 'http://localhost:3200',
  }),
}));

vi.mock('@dar/db', async (importActual) => {
  const actual = await importActual<typeof import('@dar/db')>();
  return {
    ...actual,
    createDb: vi.fn(() => ({ fake: true })),
    closeDb: vi.fn(async () => undefined),
    TaskRunRepository: class {
      async updateStatus(taskRunId: string, input: unknown) {
        statusUpdates.push({ taskRunId, input });
        return { task_run_id: taskRunId, status: (input as { status?: string }).status };
      }
    },
  };
});

describe('updateTaskRunStatusActivity', () => {
  it('writes completed and failed task_run status through the DB repository', async () => {
    const { updateTaskRunStatusActivity } = await import('../src/activities/index.js');

    await updateTaskRunStatusActivity({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
      request_id: 'req_1',
      status: 'completed',
    });
    await updateTaskRunStatusActivity({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
      request_id: 'req_1',
      status: 'failed',
      error_code: 'TOOL_FAILED',
      error_message: 'tool gateway request failed',
    });

    expect(statusUpdates).toEqual([
      { taskRunId: 'task_1', input: { status: 'completed', errorCode: undefined, errorMessage: undefined } },
      {
        taskRunId: 'task_1',
        input: {
          status: 'failed',
          errorCode: 'TOOL_FAILED',
          errorMessage: 'tool gateway request failed',
        },
      },
    ]);
  });
});
