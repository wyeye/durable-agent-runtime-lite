import {
  runTaskRequestSchema,
  runTaskResponseSchema,
  routerPreviewResponseSchema,
  taskRunSchema,
  type RouteSpec,
  type RunTaskRequest,
  type RunTaskResponse,
  type RouterPreviewResponse,
  type TaskRun,
  type WorkflowStartRequest,
} from '@dar/contracts';
import {
  AuditEventRepository,
  buildDbFlowSnapshotRef,
  closeDb,
  createDb,
  HumanTaskRepository,
  TaskRunRepository,
  ToolCallLogRepository,
  type Database,
} from '@dar/db';
import { loadConfig, type RuntimeConfig } from '@dar/config';
import { buildTaskWorkflowId } from '@dar/temporal';
import type { Kysely } from 'kysely';
import { DEFAULT_AGENT_ID } from '../router/route-registry.js';
import { routeByRules } from '../router/rule-router.js';
import { DbRouteSpecSource, MemoryRouteSpecSource, type RouteSpecSource } from '../router/route-source.js';
import { createWorkflowStarter, type WorkflowStarter } from '../workflow/workflow-starter.js';
import { HumanTaskService } from '../human-task/human-task-service.js';
import { createRequestId, createTaskRunId } from './task-id.js';
import { DbTaskRunStore, InMemoryTaskRunStore, type TaskRunStore } from './task-store.js';

export interface NormalizedRunTaskRequest extends RunTaskRequest {
  request_id: string;
  tenant_id: string;
  user_id: string;
}

export interface TaskServiceOptions {
  routes?: RouteSpec[];
  routeSource?: RouteSpecSource;
  taskStore?: TaskRunStore;
  workflowStarter?: WorkflowStarter;
  allowMockRouteFallback?: boolean;
  buildFlowSnapshotRef?: (flowId: string, version: number) => string;
}

export class TaskService {
  private readonly routeSource: RouteSpecSource;
  private readonly taskStore: TaskRunStore;
  private readonly workflowStarter: WorkflowStarter;
  private readonly allowMockRouteFallback: boolean;
  private readonly buildFlowSnapshotRef: (flowId: string, version: number) => string;

  constructor(options: TaskServiceOptions = {}) {
    this.routeSource = options.routeSource ?? new MemoryRouteSpecSource(options.routes);
    this.taskStore = options.taskStore ?? new InMemoryTaskRunStore();
    this.workflowStarter = options.workflowStarter ?? createWorkflowStarter();
    this.allowMockRouteFallback = options.allowMockRouteFallback ?? true;
    this.buildFlowSnapshotRef =
      options.buildFlowSnapshotRef ??
      (this.allowMockRouteFallback ? buildLocalFlowSnapshotRef : buildDbFlowSnapshotRef);
  }

  async preview(input: unknown): Promise<RouterPreviewResponse> {
    const normalized = normalizeRunTaskRequest(input);
    const routes = await this.routeSource.listPublished(normalized.tenant_id);
    return previewRoute(input, routes, this.allowMockRouteFallback);
  }

  async create(input: unknown): Promise<RunTaskResponse> {
    const normalized = normalizeRunTaskRequest(input);
    const routes = await this.routeSource.listPublished(normalized.tenant_id);
    const routeResult = routeByRules(
      {
        input: normalized.input,
        channel: normalized.channel,
        roles: normalized.roles,
        allowMockFallback: this.allowMockRouteFallback,
      },
      routes,
    );

    const taskRunId = createTaskRunId();
    const workflowId = buildTaskWorkflowId(normalized.tenant_id, taskRunId);
    const decision = routeResult.route_decision;

    const workflowRequest: WorkflowStartRequest = decision.decision === 'matched'
      ? {
          tenant_id: normalized.tenant_id,
          user_id: normalized.user_id,
          task_run_id: taskRunId,
          workflow_type: 'ConfigDrivenWorkflow',
          workflow_id: workflowId,
          flow_id: decision.flow_id,
          flow_version: decision.flow_version,
          flow_snapshot_ref: this.buildFlowSnapshotRef(decision.flow_id, decision.flow_version),
          input: normalized.input,
          request_id: normalized.request_id,
          trace_id: normalized.trace_id,
        }
      : {
          tenant_id: normalized.tenant_id,
          user_id: normalized.user_id,
          task_run_id: taskRunId,
          workflow_type: 'GenericAgentWorkflow',
          workflow_id: workflowId,
          agent_id: decision.decision === 'agent_fallback' ? decision.agent_id : DEFAULT_AGENT_ID,
          input: normalized.input,
          request_id: normalized.request_id,
          trace_id: normalized.trace_id,
        };

    const queuedResponse = runTaskResponseSchema.parse({
      task_run_id: taskRunId,
      workflow_id: workflowId,
      status: 'queued',
      route_decision: decision,
      flow_id: decision.decision === 'matched' ? decision.flow_id : undefined,
      flow_version: decision.decision === 'matched' ? decision.flow_version : undefined,
      agent_id: decision.decision === 'agent_fallback' ? decision.agent_id : undefined,
    });

    await this.taskStore.create({
      taskRun: taskRunSchema.parse({
        task_run_id: taskRunId,
        tenant_id: normalized.tenant_id,
        user_id: normalized.user_id,
        route_type: decision.decision === 'matched' ? 'matched' : 'agent_fallback',
        flow_id: queuedResponse.flow_id,
        flow_version: queuedResponse.flow_version,
        workflow_id: workflowId,
        status: queuedResponse.status,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      input: normalized.input,
      routeResult,
    });

    try {
      const workflowStart = await this.workflowStarter.start(workflowRequest);
      await this.taskStore.updateWorkflowStart(taskRunId, workflowStart);
      return runTaskResponseSchema.parse({
        ...queuedResponse,
        workflow_start: workflowStart,
      });
    } catch (error) {
      await this.taskStore.updateStatus(taskRunId, {
        status: 'failed_to_start',
        errorCode: 'WORKFLOW_START_FAILED',
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }

  async get(taskRunId: string): Promise<TaskRun | undefined> {
    return this.taskStore.get(taskRunId);
  }
}

export function normalizeRunTaskRequest(input: unknown): NormalizedRunTaskRequest {
  const parsed = runTaskRequestSchema.parse(input);

  return {
    ...parsed,
    request_id: parsed.request_id ?? createRequestId(),
    tenant_id: parsed.tenant_id ?? 'default',
    user_id: parsed.user_id ?? 'anonymous',
  };
}

function buildLocalFlowSnapshotRef(flowId: string, version: number): string {
  return `${flowId}@${version}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow failed to start';
}

export function previewRoute(
  input: unknown,
  routes: RouteSpec[],
  allowMockFallback = true,
): RouterPreviewResponse {
  const normalized = normalizeRunTaskRequest(input);
  const result = routeByRules(
    {
      input: normalized.input,
      channel: normalized.channel,
      roles: normalized.roles,
      allowMockFallback,
    },
    routes,
  );

  return routerPreviewResponseSchema.parse(result);
}

export function createTaskRunPreview(
  input: unknown,
  routes: RouteSpec[],
): RunTaskResponse {
  const normalized = normalizeRunTaskRequest(input);
  const routeResult = routeByRules(
    {
      input: normalized.input,
      channel: normalized.channel,
      roles: normalized.roles,
    },
    routes,
  );

  const taskRunId = createTaskRunId();
  const workflowId = buildTaskWorkflowId(normalized.tenant_id, taskRunId);
  const decision = routeResult.route_decision;

  if (decision.decision === 'matched') {
    return runTaskResponseSchema.parse({
      task_run_id: taskRunId,
      workflow_id: workflowId,
      status: 'queued',
      route_decision: decision,
      flow_id: decision.flow_id,
      flow_version: decision.flow_version,
    });
  }

  return runTaskResponseSchema.parse({
    task_run_id: taskRunId,
    workflow_id: workflowId,
    status: 'queued',
    route_decision: decision,
    agent_id: decision.decision === 'agent_fallback' ? decision.agent_id : DEFAULT_AGENT_ID,
  });
}

export interface RuntimeApiTaskServiceHandle {
  taskService: TaskService;
  humanTaskService: HumanTaskService;
  close(): Promise<void>;
}

export function createRuntimeApiTaskService(config: RuntimeConfig = loadConfig()): RuntimeApiTaskServiceHandle {
  if (isProductionRuntime(config) && config.RUNTIME_API_ROUTE_SOURCE !== 'db') {
    throw new Error('RUNTIME_API_ROUTE_SOURCE=db is required in production');
  }

  if (config.RUNTIME_API_ROUTE_SOURCE === 'db') {
    const db: Kysely<Database> = createDb({ databaseUrl: config.DATABASE_URL });
    return {
      taskService: new TaskService({
        routeSource: new DbRouteSpecSource(db),
        taskStore: new DbTaskRunStore(new TaskRunRepository(db)),
        workflowStarter: createWorkflowStarter(config),
        allowMockRouteFallback: false,
        buildFlowSnapshotRef: buildDbFlowSnapshotRef,
      }),
      humanTaskService: new HumanTaskService({
        store: new HumanTaskRepository(db),
        auditStore: new AuditEventRepository(db),
        toolCallLogStore: new ToolCallLogRepository(db),
      }),
      close: async () => closeDb(db),
    };
  }

  return {
    taskService: new TaskService({
      workflowStarter: createWorkflowStarter(config),
      allowMockRouteFallback: true,
    }),
    humanTaskService: new HumanTaskService(),
    close: async () => undefined,
  };
}

function isProductionRuntime(config: RuntimeConfig): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}
