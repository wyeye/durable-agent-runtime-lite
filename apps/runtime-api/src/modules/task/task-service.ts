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
import { buildTaskWorkflowId } from '@dar/temporal';
import { defaultRouteSpecs, DEFAULT_AGENT_ID } from '../router/route-registry.js';
import { routeByRules } from '../router/rule-router.js';
import { createWorkflowStarter, type WorkflowStarter } from '../workflow/workflow-starter.js';
import { createRequestId, createTaskRunId } from './task-id.js';
import { InMemoryTaskRunStore } from './task-store.js';

export interface NormalizedRunTaskRequest extends RunTaskRequest {
  request_id: string;
  tenant_id: string;
  user_id: string;
}

export interface TaskServiceOptions {
  routes?: RouteSpec[];
  taskStore?: InMemoryTaskRunStore;
  workflowStarter?: WorkflowStarter;
}

export class TaskService {
  private readonly routes: RouteSpec[];
  private readonly taskStore: InMemoryTaskRunStore;
  private readonly workflowStarter: WorkflowStarter;

  constructor(options: TaskServiceOptions = {}) {
    this.routes = options.routes ?? defaultRouteSpecs;
    this.taskStore = options.taskStore ?? new InMemoryTaskRunStore();
    this.workflowStarter = options.workflowStarter ?? createWorkflowStarter();
  }

  preview(input: unknown): RouterPreviewResponse {
    return previewRoute(input, this.routes);
  }

  async create(input: unknown): Promise<RunTaskResponse> {
    const normalized = normalizeRunTaskRequest(input);
    const routeResult = routeByRules(
      {
        input: normalized.input,
        channel: normalized.channel,
        roles: normalized.roles,
      },
      this.routes,
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
          flow_snapshot_ref: `${decision.flow_id}@${decision.flow_version}`,
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

    const workflowStart = await this.workflowStarter.start(workflowRequest);
    const response = runTaskResponseSchema.parse({
      task_run_id: taskRunId,
      workflow_id: workflowId,
      status: 'queued',
      route_decision: decision,
      workflow_start: workflowStart,
      flow_id: decision.decision === 'matched' ? decision.flow_id : undefined,
      flow_version: decision.decision === 'matched' ? decision.flow_version : undefined,
      agent_id: decision.decision === 'agent_fallback' ? decision.agent_id : undefined,
    });

    this.taskStore.create(
      taskRunSchema.parse({
        task_run_id: taskRunId,
        tenant_id: normalized.tenant_id,
        user_id: normalized.user_id,
        route_type: decision.decision === 'matched' ? 'matched' : 'agent_fallback',
        flow_id: response.flow_id,
        flow_version: response.flow_version,
        workflow_id: workflowId,
        status: response.status,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    );

    return response;
  }

  get(taskRunId: string): TaskRun | undefined {
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

export function previewRoute(
  input: unknown,
  routes: RouteSpec[] = defaultRouteSpecs,
): RouterPreviewResponse {
  const normalized = normalizeRunTaskRequest(input);
  const result = routeByRules(
    {
      input: normalized.input,
      channel: normalized.channel,
      roles: normalized.roles,
    },
    routes,
  );

  return routerPreviewResponseSchema.parse(result);
}

export function createTaskRunPreview(
  input: unknown,
  routes: RouteSpec[] = defaultRouteSpecs,
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
