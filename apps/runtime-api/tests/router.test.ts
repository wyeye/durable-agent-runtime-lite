import { describe, expect, it } from 'vitest';
import type { HumanTask, RouteSpec, TaskRun, WorkflowStartResponse } from '@dar/contracts';
import type { HumanTaskDecisionSignalInput } from '@dar/temporal';
import { buildServer } from '../src/index.js';
import {
  HumanTaskService,
  InMemoryHumanTaskAuditStore,
  InMemoryHumanTaskStore,
  InMemoryHumanTaskToolCallLogStore,
} from '../src/modules/human-task/human-task-service.js';
import { routeByRules } from '../src/modules/router/rule-router.js';
import { defaultRouteSpecs } from '../src/modules/router/route-registry.js';
import type { RouteSpecSource } from '../src/modules/router/route-source.js';
import { createRuntimeApiTaskService, TaskService } from '../src/modules/task/task-service.js';
import type { TaskRunStore } from '../src/modules/task/task-store.js';

class StaticRouteSource implements RouteSpecSource {
  constructor(private readonly routes: RouteSpec[]) {}

  async listPublished(): Promise<RouteSpec[]> {
    return this.routes;
  }
}

class RecordingTaskRunStore implements TaskRunStore {
  readonly calls: string[] = [];
  private readonly taskRuns = new Map<string, TaskRun>();

  async create(input: { taskRun: TaskRun }): Promise<TaskRun> {
    this.calls.push('create');
    this.taskRuns.set(input.taskRun.task_run_id, input.taskRun);
    return input.taskRun;
  }

  async get(taskRunId: string): Promise<TaskRun | undefined> {
    return this.taskRuns.get(taskRunId);
  }

  async updateStatus(taskRunId: string, input: TaskRun['status'] | { status: TaskRun['status'] }): Promise<TaskRun | undefined> {
    this.calls.push('updateStatus');
    const existing = this.taskRuns.get(taskRunId);
    if (!existing) {
      return undefined;
    }
    const status = typeof input === 'string' ? input : input.status;
    const updated = { ...existing, status };
    this.taskRuns.set(taskRunId, updated);
    return updated;
  }

  async updateWorkflowStart(taskRunId: string): Promise<TaskRun | undefined> {
    this.calls.push('updateWorkflowStart');
    return this.taskRuns.get(taskRunId);
  }
}

const staticExecutionPlanResolver = {
  async resolve(input: { flowId: string; flowVersion: number }) {
    return {
      executionPlanRef: `db://flow-execution-plan/plan_${input.flowId}_${input.flowVersion}`,
      flowSha256: 'a'.repeat(64),
    };
  },
};

const dbOnlyRoute: RouteSpec = {
  route_id: 'db_only_route',
  flow_id: 'db_route_flow',
  version: 3,
  status: 'published',
  route: {
    priority: 100,
    keywords: ['db-only'],
    examples: [],
    negative_examples: [],
    supported_channels: [],
    role_constraints: [],
    confidence_threshold: 0.5,
    ambiguous_threshold: 0.3,
  },
};

describe('runtime-api router and task endpoints', () => {
  it('matches by keyword and priority', () => {
    const result = routeByRules({ input: { text: '请执行 mvp 示例流程', payload: {} }, channel: 'web' }, defaultRouteSpecs);
    expect(result.route_decision.decision).toBe('matched');
    if (result.route_decision.decision === 'matched') {
      expect(result.route_decision.flow_id).toBe('sample_flow');
    }
  });

  it('creates and queries a mock-started task run', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_1',
        input: { text: '请执行 mvp 示例流程' },
      },
    });
    expect(response.statusCode).toBe(200);
    const created = response.json();
    expect(created.data.status).toBe('queued');
    expect(created.data.workflow_start.mode).toBe('mock');

    const queried = await server.inject({ method: 'GET', url: `/v1/tasks/${created.data.task_run_id}` });
    expect(queried.statusCode).toBe(200);
    expect(queried.json().data.task_run_id).toBe(created.data.task_run_id);
    const wrongTenant = await server.inject({
      method: 'GET',
      url: `/v1/tasks/${created.data.task_run_id}?tenant_id=tenant_2`,
    });
    expect(wrongTenant.statusCode).toBe(404);

    const list = await server.inject({
      method: 'GET',
      url: '/v1/tasks?tenant_id=tenant_1&status=queued&page=1&page_size=5',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.map((task: TaskRun) => task.task_run_id)).toContain(created.data.task_run_id);
    await server.close();
  });

  it('uses DB RouteSpec source for preview and task creation without default route fallback', async () => {
    const server = buildServer(
      new TaskService({
        routeSource: new StaticRouteSource([dbOnlyRoute]),
        allowMockRouteFallback: false,
        executionPlanResolver: staticExecutionPlanResolver,
      }),
    );

    const preview = await server.inject({
      method: 'POST',
      url: '/v1/router/preview',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_db_preview',
        input: { text: 'please run db-only path' },
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.route_decision).toMatchObject({
      decision: 'matched',
      flow_id: 'db_route_flow',
      flow_version: 3,
    });

    const task = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_db_task',
        input: { text: 'please run db-only path' },
      },
    });
    expect(task.statusCode).toBe(200);
    expect(task.json().data).toMatchObject({
      flow_id: 'db_route_flow',
      flow_version: 3,
      route_decision: { decision: 'matched', flow_id: 'db_route_flow', flow_version: 3 },
    });
    expect(task.json().data.workflow_start).toMatchObject({
      mode: 'mock',
    });

    const defaultPreview = await server.inject({
      method: 'POST',
      url: '/v1/router/preview',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_no_sample',
        input: { text: '请执行 mvp 示例流程' },
      },
    });
    expect(defaultPreview.json().data.route_decision).toMatchObject({
      decision: 'need_clarify',
    });
    expect(defaultPreview.json().data.route_decision.flow_id).not.toBe('sample_flow');

    await server.close();
  });

  it('does not fall back to sample route when DB RouteSpec source is empty', async () => {
    const server = buildServer(
      new TaskService({
        routeSource: new StaticRouteSource([]),
        allowMockRouteFallback: false,
        executionPlanResolver: staticExecutionPlanResolver,
      }),
    );

    const preview = await server.inject({
      method: 'POST',
      url: '/v1/router/preview',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        input: { text: '请执行 mvp 示例流程' },
      },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.route_decision).toMatchObject({
      decision: 'reject',
      reason: 'no_published_route_match',
    });

    await server.close();
  });

  it('does not start a default agent workflow when DB routing cannot match', async () => {
    const starts: unknown[] = [];
    const server = buildServer(
      new TaskService({
        routeSource: new StaticRouteSource([]),
        allowMockRouteFallback: false,
        executionPlanResolver: staticExecutionPlanResolver,
        workflowStarter: {
          async start(request) {
            starts.push(request);
            return {
              workflow_id: request.workflow_id,
              task_run_id: request.task_run_id,
              started: true,
              mode: 'mock',
            };
          },
        },
      }),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        input: { text: 'unmatched production request' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'failed',
      route_decision: {
        decision: 'reject',
        reason: 'no_published_route_match',
      },
    });
    expect(response.json().data.workflow_start).toBeUndefined();
    expect(starts).toHaveLength(0);

    await server.close();
  });

  it('uses local sample refs only for memory development source', async () => {
    const workflowStarts: unknown[] = [];
    const server = buildServer(
      new TaskService({
        workflowStarter: {
          async start(request) {
            workflowStarts.push(request);
            return {
              workflow_id: request.workflow_id,
              task_run_id: request.task_run_id,
              started: true,
              mode: 'mock',
            };
          },
        },
      }),
    );

    const task = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_memory_task',
        input: { text: '请执行 mvp 示例流程' },
      },
    });

    expect(task.statusCode).toBe(200);
    expect(workflowStarts).toHaveLength(1);
    expect(workflowStarts[0]).toMatchObject({
      flow_snapshot_ref: 'sample_flow@1',
    });

    await server.close();
  });

  it('persists queued task_run before starting the workflow', async () => {
    const taskStore = new RecordingTaskRunStore();
    const workflowStart: WorkflowStartResponse = {
      workflow_id: 'workflow_placeholder',
      task_run_id: 'task_placeholder',
      started: true,
      mode: 'mock',
    };
    const service = new TaskService({
      routeSource: new StaticRouteSource([dbOnlyRoute]),
      taskStore,
      executionPlanResolver: staticExecutionPlanResolver,
      workflowStarter: {
        async start(request) {
          expect(taskStore.calls).toEqual(['create']);
          expect(request).toMatchObject({
            execution_plan_ref: 'db://flow-execution-plan/plan_db_route_flow_3',
            flow_sha256: 'a'.repeat(64),
          });
          return {
            ...workflowStart,
            workflow_id: request.workflow_id,
            task_run_id: request.task_run_id,
          };
        },
      },
      allowMockRouteFallback: false,
    });

    const response = await service.create({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      request_id: 'req_order',
      input: { text: 'db-only' },
    });

    expect(response.workflow_start).toMatchObject({ mode: 'mock', started: true });
    expect(taskStore.calls).toEqual(['create', 'updateWorkflowStart']);
  });

  it('requires DB RouteSpec source in production', () => {
    expect(() =>
      createRuntimeApiTaskService({
        NODE_ENV: 'production',
        APP_ENV: 'production',
        APP_VERSION: '0.1.5',
        HOST: '0.0.0.0',
        DATABASE_URL: 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
        VALKEY_URL: 'redis://localhost:16380',
        TEMPORAL_ADDRESS: 'localhost:7233',
        TEMPORAL_NAMESPACE: 'default',
        MODEL_GATEWAY_BASE_URL: 'http://localhost:4100',
        MODEL_GATEWAY_API_KEY: 'dev-only-placeholder',
        JWT_ISSUER: 'http://localhost:3000',
        JWT_AUDIENCE: 'durable-agent-runtime-lite',
        LOG_LEVEL: 'info',
        CONTROL_PLANE_PORT: 3000,
        RUNTIME_API_PORT: 3001,
        RUNTIME_WORKER_PORT: 3002,
        TOOL_GATEWAY_PORT: 3003,
        RUNTIME_WORKER_MODE: 'mock',
        RUNTIME_API_WORKFLOW_STARTER: 'mock',
        RUNTIME_API_ROUTE_SOURCE: 'memory',
        TOOL_GATEWAY_REGISTRY_SOURCE: 'db',
      }),
    ).toThrow('RUNTIME_API_ROUTE_SOURCE=db is required in production');
  });

  it('lists, reads, approves, and rejects human tasks with tenant/user context', async () => {
    const pendingTask: HumanTask = {
      human_task_id: 'human_l3_1',
      tenant_id: 'tenant_1',
      task_run_id: 'task_l3_1',
      workflow_id: 'workflow_l3_1',
      status: 'pending',
      candidate_groups: [],
      payload: {
        tool_call_id: 'tool_call_l3_1',
        tool_name: 'record.write.mock',
      },
      created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    const rejectedTask: HumanTask = {
      ...pendingTask,
      human_task_id: 'human_l3_2',
      task_run_id: 'task_l3_2',
      workflow_id: 'workflow_l3_2',
      payload: {
        tool_call_id: 'tool_call_l3_2',
        tool_name: 'record.write.mock',
      },
    };
    const auditStore = new InMemoryHumanTaskAuditStore();
    const toolCallStore = new InMemoryHumanTaskToolCallLogStore();
    const signals: HumanTaskDecisionSignalInput[] = [];
    const humanTaskService = new HumanTaskService({
      store: new InMemoryHumanTaskStore([pendingTask, rejectedTask]),
      auditStore,
      toolCallLogStore: toolCallStore,
      signalSender: {
        async send(input) {
          signals.push(input);
        },
      },
    });
    const server = buildServer(undefined, undefined, humanTaskService);

    const list = await server.inject({
      method: 'GET',
      url: '/v1/human-tasks?tenant_id=tenant_1&user_id=user_1&status=pending&page=1&page_size=1',
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.human_tasks.map((task: HumanTask) => task.human_task_id)).toEqual([
      'human_l3_1',
    ]);

    const get = await server.inject({
      method: 'GET',
      url: '/v1/human-tasks/human_l3_1?tenant_id=tenant_1&user_id=user_1',
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.human_task.payload.tool_call_id).toBe('tool_call_l3_1');

    const approve = await server.inject({
      method: 'POST',
      url: '/v1/human-tasks/human_l3_1/approve',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'approver_1',
        decision_reason: 'safe in test',
        payload: { note: 'approved' },
        request_id: 'req_human_approve',
      },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().data.human_task).toMatchObject({
      human_task_id: 'human_l3_1',
      status: 'approved',
      decided_by: 'approver_1',
      decision_reason: 'safe in test',
    });

    const duplicateApprove = await server.inject({
      method: 'POST',
      url: '/v1/human-tasks/human_l3_1/approve',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'approver_1',
        decision_reason: 'duplicate',
        request_id: 'req_human_approve_duplicate',
      },
    });
    expect(duplicateApprove.statusCode).toBe(200);

    const reject = await server.inject({
      method: 'POST',
      url: '/v1/human-tasks/human_l3_2/reject',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'approver_2',
        decision_reason: 'not safe',
        request_id: 'req_human_reject',
      },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().data.human_task).toMatchObject({
      human_task_id: 'human_l3_2',
      status: 'rejected',
      decided_by: 'approver_2',
    });

    expect(auditStore.events.map((event) => event.action)).toEqual(['human_task.approve', 'human_task.reject']);
    expect(toolCallStore.updates).toEqual([
      { toolCallId: 'tool_call_l3_1', input: { status: 'approved' } },
      { toolCallId: 'tool_call_l3_2', input: { status: 'rejected' } },
    ]);
    expect(signals).toEqual([
      expect.objectContaining({ human_task_id: 'human_l3_1', status: 'approved', workflow_id: 'workflow_l3_1' }),
      expect.objectContaining({ human_task_id: 'human_l3_2', status: 'rejected', workflow_id: 'workflow_l3_2' }),
    ]);

    await server.close();
  });
});
