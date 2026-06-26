import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusUpdates = vi.hoisted(() => [] as Array<{ taskRunId: string; input: unknown }>);
const releasedAdmissions = vi.hoisted(() => [] as Array<{ admissionId: string; reason: string }>);

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
    TenantAgentAdmissionRepository: class {
      async release(admissionId: string, reason = 'released') {
        releasedAdmissions.push({ admissionId, reason });
        return { admission_id: admissionId, status: 'released' };
      }
    },
  };
});

describe('updateTaskRunStatusActivity', () => {
  beforeEach(() => {
    statusUpdates.length = 0;
    releasedAdmissions.length = 0;
  });

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
    expect(releasedAdmissions).toEqual([]);
  });

  it('releases tenant admission only after terminal task_run status', async () => {
    const { updateTaskRunStatusActivity } = await import('../src/activities/index.js');

    await updateTaskRunStatusActivity({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
      request_id: 'req_1',
      tenant_admission_id: 'admission_1',
      status: 'running',
    });
    await updateTaskRunStatusActivity({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
      request_id: 'req_1',
      tenant_admission_id: 'admission_1',
      status: 'waiting_human',
    });
    await updateTaskRunStatusActivity({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
      request_id: 'req_1',
      tenant_admission_id: 'admission_1',
      status: 'waiting_user',
    });

    expect(releasedAdmissions).toEqual([]);

    await updateTaskRunStatusActivity({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
      request_id: 'req_1',
      tenant_admission_id: 'admission_1',
      status: 'completed',
    });
    await updateTaskRunStatusActivity({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_2',
      workflow_id: 'workflow_2',
      request_id: 'req_2',
      tenant_admission_id: 'admission_2',
      status: 'failed',
      error_code: 'WORKFLOW_FAILED',
      error_message: 'workflow failed',
    });

    expect(releasedAdmissions).toEqual([
      { admissionId: 'admission_1', reason: 'workflow_completed' },
      { admissionId: 'admission_2', reason: 'workflow_failed' },
    ]);
  });

  it('does not release tenant admission for waiting_user task_run status', async () => {
    const { updateTaskRunStatusActivity } = await import('../src/activities/index.js');

    await updateTaskRunStatusActivity({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_waiting_user',
      workflow_id: 'workflow_waiting_user',
      request_id: 'req_waiting_user',
      tenant_admission_id: 'admission_waiting_user',
      status: 'waiting_user',
    });

    expect(statusUpdates).toContainEqual({
      taskRunId: 'task_waiting_user',
      input: { status: 'waiting_user', errorCode: undefined, errorMessage: undefined },
    });
    expect(releasedAdmissions).toEqual([]);
  });
});
