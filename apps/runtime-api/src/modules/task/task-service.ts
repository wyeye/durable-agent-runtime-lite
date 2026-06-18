import {
  runTaskRequestSchema,
  runTaskResponseSchema,
  routerPreviewResponseSchema,
  taskRunSchema,
  taskRunQuerySchema,
  workflowStartRequestSchema,
  type RouteSpec,
  type RunTaskRequest,
  type RunTaskResponse,
  type RouterPreviewResponse,
  type TaskRun,
  type WorkflowStartRequest,
} from '@dar/contracts';
import {
  AuditEventRepository,
  AgentRunRepository,
  AgentStepRepository,
  buildDbFlowSnapshotRef,
  closeDb,
  createDb,
  FlowExecutionPlanRepository,
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
import { createWorkflowStarter, TemporalHumanTaskSignalSender, type WorkflowStarter } from '../workflow/workflow-starter.js';
import { HumanTaskService } from '../human-task/human-task-service.js';
import { AgentRunService, DbAgentRunStore, DbAgentStepStore } from './agent-run-service.js';
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
  executionPlanResolver?: ExecutionPlanResolver;
}

export interface ExecutionPlanResolver {
  resolve(input: {
    tenantId: string;
    userId: string;
    flowId: string;
    flowVersion: number;
  }): Promise<{ executionPlanRef: string; flowSha256: string } | undefined>;
}

export class TaskService {
  private readonly routeSource: RouteSpecSource;
  private readonly taskStore: TaskRunStore;
  private readonly workflowStarter: WorkflowStarter;
  private readonly allowMockRouteFallback: boolean;
  private readonly buildFlowSnapshotRef: (flowId: string, version: number) => string;
  private readonly executionPlanResolver: ExecutionPlanResolver | undefined;

  constructor(options: TaskServiceOptions = {}) {
    this.routeSource = options.routeSource ?? new MemoryRouteSpecSource(options.routes);
    this.taskStore = options.taskStore ?? new InMemoryTaskRunStore();
    this.workflowStarter = options.workflowStarter ?? createWorkflowStarter();
    this.allowMockRouteFallback = options.allowMockRouteFallback ?? true;
    this.buildFlowSnapshotRef =
      options.buildFlowSnapshotRef ??
      (this.allowMockRouteFallback ? buildLocalFlowSnapshotRef : buildDbFlowSnapshotRef);
    this.executionPlanResolver = options.executionPlanResolver;
  }

  async preview(input: unknown): Promise<RouterPreviewResponse> {
    const normalized = normalizeRunTaskRequest(input);
    const routes = await this.routeSource.listPublished(normalized.tenant_id, normalized.user_id);
    return previewRoute(input, routes, this.allowMockRouteFallback);
  }

  async create(input: unknown): Promise<RunTaskResponse> {
    const normalized = normalizeRunTaskRequest(input);
    const routes = await this.routeSource.listPublished(normalized.tenant_id, normalized.user_id);
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
    const executionPlan = decision.decision === 'matched'
      ? await this.resolveExecutionPlan(normalized.tenant_id, normalized.user_id, decision.flow_id, decision.flow_version)
      : undefined;

    if (decision.decision !== 'matched' && !this.allowMockRouteFallback) {
      const blockedResponse = runTaskResponseSchema.parse({
        task_run_id: taskRunId,
        workflow_id: workflowId,
        status: 'failed',
        route_decision: decision,
      });

      await this.taskStore.create({
        taskRun: taskRunSchema.parse({
          task_run_id: taskRunId,
          tenant_id: normalized.tenant_id,
          user_id: normalized.user_id,
          route_type: decision.decision === 'need_clarify' ? 'manual' : 'unknown',
          workflow_id: workflowId,
          status: blockedResponse.status,
          error_code: decision.decision === 'need_clarify' ? 'ROUTE_NEEDS_CLARIFICATION' : 'ROUTE_NOT_MATCHED',
          error_message: decision.decision === 'need_clarify' ? decision.question : decision.reason,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        input: normalized.input,
        routeResult,
      });

      return blockedResponse;
    }

    const workflowRequest: WorkflowStartRequest = decision.decision === 'matched'
      ? {
          tenant_id: normalized.tenant_id,
          user_id: normalized.user_id,
          task_run_id: taskRunId,
          workflow_type: 'ConfigDrivenWorkflow',
          workflow_id: workflowId,
          flow_id: decision.flow_id,
          flow_version: decision.flow_version,
          ...(!executionPlan ? { flow_snapshot_ref: this.buildFlowSnapshotRef(decision.flow_id, decision.flow_version) } : {}),
          execution_plan_ref: executionPlan?.executionPlanRef,
          flow_sha256: executionPlan?.flowSha256,
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
        execution_plan_ref: executionPlan?.executionPlanRef,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      input: normalized.input,
      routeResult,
      ...(executionPlan?.executionPlanRef ? { executionPlanRef: executionPlan.executionPlanRef } : {}),
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

  async createAgentTask(input: unknown): Promise<RunTaskResponse> {
    const parsed = workflowStartRequestSchema.pick({
      tenant_id: true,
      user_id: true,
      agent_execution_plan_ref: true,
      input: true,
      request_id: true,
      trace_id: true,
      execution_mode: true,
    }).parse({
      ...(typeof input === 'object' && input ? input : {}),
      request_id: (typeof input === 'object' && input && 'request_id' in input && typeof input.request_id === 'string')
        ? input.request_id
        : createRequestId(),
    });
    if (!parsed.agent_execution_plan_ref) {
      throw new Error('agent_execution_plan_ref is required for /v1/agent-tasks');
    }
    const taskRunId = createTaskRunId();
    const workflowId = buildTaskWorkflowId(parsed.tenant_id, taskRunId);
    const workflowRequest: WorkflowStartRequest = {
      tenant_id: parsed.tenant_id,
      user_id: parsed.user_id,
      task_run_id: taskRunId,
      workflow_type: 'GenericAgentWorkflow',
      workflow_id: workflowId,
      agent_execution_plan_ref: parsed.agent_execution_plan_ref,
      input: parsed.input,
      request_id: parsed.request_id,
      ...(parsed.trace_id ? { trace_id: parsed.trace_id } : {}),
      ...(parsed.execution_mode ? { execution_mode: parsed.execution_mode } : {}),
    };
    const routeDecision = {
      decision: 'agent_fallback' as const,
      agent_id: parsed.agent_execution_plan_ref,
      confidence: 1,
      reason: 'explicit_agent_execution_plan_ref',
    };
    const queuedResponse = runTaskResponseSchema.parse({
      task_run_id: taskRunId,
      workflow_id: workflowId,
      status: 'queued',
      route_decision: routeDecision,
      agent_id: parsed.agent_execution_plan_ref,
    });

    await this.taskStore.create({
      taskRun: taskRunSchema.parse({
        task_run_id: taskRunId,
        tenant_id: parsed.tenant_id,
        user_id: parsed.user_id,
        route_type: 'agent_fallback',
        workflow_id: workflowId,
        status: 'queued',
        execution_plan_ref: parsed.agent_execution_plan_ref,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      input: parsed.input,
      routeResult: { route_decision: routeDecision, candidates: [] },
      executionPlanRef: parsed.agent_execution_plan_ref,
    });

    try {
      const workflowStart = await this.workflowStarter.start(workflowRequest);
      await this.taskStore.updateWorkflowStart(taskRunId, workflowStart);
      return runTaskResponseSchema.parse({ ...queuedResponse, workflow_start: workflowStart });
    } catch (error) {
      await this.taskStore.updateStatus(taskRunId, {
        status: 'failed_to_start',
        errorCode: 'WORKFLOW_START_FAILED',
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }

  private async resolveExecutionPlan(
    tenantId: string,
    userId: string,
    flowId: string,
    flowVersion: number,
  ): Promise<{ executionPlanRef: string; flowSha256: string } | undefined> {
    if (!this.executionPlanResolver) {
      if (this.allowMockRouteFallback) {
        return undefined;
      }
      throw new Error(`FlowExecutionPlan resolver is not configured for ${flowId}@${flowVersion}`);
    }

    const plan = await this.executionPlanResolver.resolve({ tenantId, userId, flowId, flowVersion });
    if (!plan) {
      throw new Error(`FlowExecutionPlan not found for ${flowId}@${flowVersion}`);
    }
    return plan;
  }

  async get(taskRunId: string): Promise<TaskRun | undefined> {
    return this.taskStore.get(taskRunId);
  }

  async list(input: unknown): Promise<TaskRun[]> {
    const query = taskRunQuerySchema.parse(input);
    return this.taskStore.list({
      tenantId: query.tenant_id ?? 'default',
      ...(query.status ? { status: query.status } : {}),
      ...(query.flow_id ? { flowId: query.flow_id } : {}),
      ...(query.workflow_id ? { workflowId: query.workflow_id } : {}),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
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
  agentRunService: AgentRunService;
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
        executionPlanResolver: new DbExecutionPlanResolver(db),
        allowMockRouteFallback: false,
        buildFlowSnapshotRef: buildDbFlowSnapshotRef,
      }),
      humanTaskService: new HumanTaskService({
        store: new HumanTaskRepository(db),
        auditStore: new AuditEventRepository(db),
        toolCallLogStore: new ToolCallLogRepository(db),
        ...(config.RUNTIME_API_WORKFLOW_STARTER === 'temporal'
          ? { signalSender: new TemporalHumanTaskSignalSender(config) }
          : {}),
      }),
      agentRunService: new AgentRunService(
        new DbAgentRunStore(new AgentRunRepository(db)),
        new DbAgentStepStore(new AgentStepRepository(db)),
      ),
      close: async () => closeDb(db),
    };
  }

  return {
    taskService: new TaskService({
      workflowStarter: createWorkflowStarter(config),
      allowMockRouteFallback: true,
    }),
    humanTaskService: new HumanTaskService(),
    agentRunService: new AgentRunService(),
    close: async () => undefined,
  };
}

export class DbExecutionPlanResolver implements ExecutionPlanResolver {
  private readonly repository: FlowExecutionPlanRepository;

  constructor(db: Kysely<Database>) {
    this.repository = new FlowExecutionPlanRepository(db);
  }

  async resolve(input: {
    tenantId: string;
    userId: string;
    flowId: string;
    flowVersion: number;
  }): Promise<{ executionPlanRef: string; flowSha256: string } | undefined> {
    void input.userId;
    const plan = await this.repository.getLatestForFlow(input.flowId, input.flowVersion, { tenantId: input.tenantId });
    return plan
      ? { executionPlanRef: plan.execution_plan_ref, flowSha256: plan.flow_sha256 }
      : undefined;
  }
}

function isProductionRuntime(config: RuntimeConfig): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}
