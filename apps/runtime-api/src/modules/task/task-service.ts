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
  type TenantRuntimePolicySnapshot,
} from '@dar/contracts';
import {
  AuditEventRepository,
  AgentExecutionPlanRepository,
  AgentRunRepository,
  AgentStepRepository,
  buildDbFlowSnapshotRef,
  closeDb,
  createDb,
  FlowExecutionPlanRepository,
  HumanTaskRepository,
  RouteEmbeddingRepository,
  TenantAgentAdmissionRepository,
  TenantRuntimePolicyResolver,
  TenantRuntimePolicyError,
  TaskRunRepository,
  ToolCallLogRepository,
  type Database,
} from '@dar/db';
import { loadConfig, type RuntimeConfig } from '@dar/config';
import { buildTaskWorkflowId } from '@dar/temporal';
import type { Kysely } from 'kysely';
import { DEFAULT_AGENT_ID } from '../router/route-registry.js';
import { routeByRules, routeWithSemanticRecall, type SemanticRoutingOptions } from '../router/rule-router.js';
import { DbRouteSpecSource, MemoryRouteSpecSource, type RouteSpecSource } from '../router/route-source.js';
import { RouterEmbeddingModelResolver } from '../router/router-embedding-model-resolver.js';
import { PgVectorRecallAdapter } from '../router/vector-recall.js';
import { createWorkflowStarter, TemporalHumanTaskSignalSender, type WorkflowStarter } from '../workflow/workflow-starter.js';
import { HumanTaskService } from '../human-task/human-task-service.js';
import { EvaluationRunService } from '../evaluation/evaluation-run-service.js';
import { AgentRunService, DbAgentRunStore, DbAgentStepStore } from './agent-run-service.js';
import { createRequestId, createTaskRunId } from './task-id.js';
import { DbTaskRunStore, InMemoryTaskRunStore, type TaskRunStore } from './task-store.js';

export interface NormalizedRunTaskRequest extends RunTaskRequest {
  request_id: string;
  tenant_id: string;
  user_id: string;
  request_locale: 'zh-CN';
}

export interface TaskServiceOptions {
  routes?: RouteSpec[];
  routeSource?: RouteSpecSource;
  taskStore?: TaskRunStore;
  workflowStarter?: WorkflowStarter;
  allowMockRouteFallback?: boolean;
  buildFlowSnapshotRef?: (flowId: string, version: number) => string;
  executionPlanResolver?: ExecutionPlanResolver;
  agentExecutionPlanResolver?: AgentExecutionPlanResolver;
  tenantPolicyResolver?: RuntimeTenantPolicyResolver;
  admissionRepository?: TenantAgentAdmissionRepository;
  tenantPolicyMode?: 'required' | 'optional';
  semanticRouting?: Partial<SemanticRoutingOptions>;
}

export interface ExecutionPlanResolver {
  resolve(input: {
    tenantId: string;
    userId: string;
    flowId: string;
    flowVersion: number;
  }): Promise<{ executionPlanRef: string; executionPlanHash: string; flowSha256: string; hasAgentSteps: boolean } | undefined>;
}

export interface AgentExecutionPlanResolver {
  resolve(input: {
    tenantId: string;
    userId: string;
    executionPlanRef: string;
  }): Promise<{ executionPlanRef: string; executionPlanHash: string } | undefined>;
}

export interface RuntimeTenantPolicyResolver {
  resolve(input: {
    tenant_id: string;
    user_id: string;
    execution_plan_ref: string;
    execution_plan_hash?: string;
    execution_plan_type: 'flow' | 'agent';
    request_id?: string;
    mode?: 'required' | 'optional';
  }): Promise<{ snapshot: TenantRuntimePolicySnapshot }>;
}

export class TaskService {
  private readonly routeSource: RouteSpecSource;
  private readonly taskStore: TaskRunStore;
  private readonly workflowStarter: WorkflowStarter;
  private readonly allowMockRouteFallback: boolean;
  private readonly buildFlowSnapshotRef: (flowId: string, version: number) => string;
  private readonly executionPlanResolver: ExecutionPlanResolver | undefined;
  private readonly agentExecutionPlanResolver: AgentExecutionPlanResolver | undefined;
  private readonly tenantPolicyResolver: RuntimeTenantPolicyResolver | undefined;
  private readonly admissionRepository: TenantAgentAdmissionRepository | undefined;
  private readonly tenantPolicyMode: 'required' | 'optional';
  private readonly semanticRouting: Partial<SemanticRoutingOptions>;

  constructor(options: TaskServiceOptions = {}) {
    this.routeSource = options.routeSource ?? new MemoryRouteSpecSource(options.routes);
    this.taskStore = options.taskStore ?? new InMemoryTaskRunStore();
    this.workflowStarter = options.workflowStarter ?? createWorkflowStarter();
    this.allowMockRouteFallback = options.allowMockRouteFallback ?? true;
    this.buildFlowSnapshotRef =
      options.buildFlowSnapshotRef ??
      (this.allowMockRouteFallback ? buildLocalFlowSnapshotRef : buildDbFlowSnapshotRef);
    this.executionPlanResolver = options.executionPlanResolver;
    this.agentExecutionPlanResolver = options.agentExecutionPlanResolver;
    this.tenantPolicyResolver = options.tenantPolicyResolver;
    this.admissionRepository = options.admissionRepository;
    this.tenantPolicyMode = options.tenantPolicyMode ?? 'optional';
    this.semanticRouting = options.semanticRouting ?? {};
  }

  async preview(input: unknown): Promise<RouterPreviewResponse> {
    const normalized = normalizeRunTaskRequest(input);
    const routes = await this.routeSource.listPublished(normalized.tenant_id, normalized.user_id);
    return previewRoute(input, routes, this.allowMockRouteFallback, this.semanticRouting);
  }

  async create(input: unknown): Promise<RunTaskResponse> {
    const normalized = normalizeRunTaskRequest(input);
    const routes = await this.routeSource.listPublished(normalized.tenant_id, normalized.user_id);
    const routeResult = await routeWithSemanticRecall(
      {
        tenantId: normalized.tenant_id,
        input: normalized.input,
        channel: normalized.channel,
        roles: normalized.roles,
        allowMockFallback: this.allowMockRouteFallback,
      },
      routes,
      this.semanticRouting,
    );

    const taskRunId = createTaskRunId();
    const workflowId = buildTaskWorkflowId(normalized.tenant_id, taskRunId);
    const decision = routeResult.route_decision;
    const executionPlan = decision.decision === 'matched'
      ? await this.resolveExecutionPlan(normalized.tenant_id, normalized.user_id, decision.flow_id, decision.flow_version)
      : undefined;
    const policySnapshot = executionPlan
      ? await this.resolveTenantPolicySnapshot({
          tenantId: normalized.tenant_id,
          userId: normalized.user_id,
          executionPlanRef: executionPlan.executionPlanRef,
          executionPlanHash: executionPlan.executionPlanHash,
          executionPlanType: 'flow',
          requestId: normalized.request_id,
        })
      : undefined;
    const admission = executionPlan?.hasAgentSteps && policySnapshot
      ? await this.reserveAdmission({
          tenantId: normalized.tenant_id,
          taskRunId,
          policySnapshot,
        })
      : undefined;

    if (decision.decision !== 'matched' && !this.allowMockRouteFallback) {
      const blockedResponse = runTaskResponseSchema.parse({
        task_run_id: taskRunId,
        workflow_id: workflowId,
        status: 'failed',
        route_decision: decision,
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
          tenant_policy_snapshot_ref: policySnapshot?.snapshot_ref,
          tenant_policy_hash: policySnapshot?.snapshot_hash,
          tenant_admission_id: admission?.admission_id,
          input: normalized.input,
          request_locale: normalized.request_locale,
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
          request_locale: normalized.request_locale,
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
      tenant_policy_snapshot_ref: policySnapshot?.snapshot_ref,
      tenant_policy_hash: policySnapshot?.snapshot_hash,
      tenant_admission_id: admission?.admission_id,
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
        tenant_policy_snapshot_ref: policySnapshot?.snapshot_ref,
        tenant_policy_hash: policySnapshot?.snapshot_hash,
        tenant_admission_id: admission?.admission_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      input: normalized.input,
      routeResult,
      ...(executionPlan?.executionPlanRef ? { executionPlanRef: executionPlan.executionPlanRef } : {}),
      ...(policySnapshot ? {
        tenantPolicySnapshotRef: policySnapshot.snapshot_ref,
        tenantPolicyHash: policySnapshot.snapshot_hash,
      } : {}),
      ...(admission ? { tenantAdmissionId: admission.admission_id } : {}),
    });

    try {
      const workflowStart = await this.workflowStarter.start(workflowRequest);
      await this.taskStore.updateWorkflowStart(taskRunId, workflowStart);
      if (admission) {
        await this.admissionRepository?.activate(admission.admission_id, {
          workflowId,
          ...(workflowStart.run_id ? { workflowRunId: workflowStart.run_id } : {}),
        });
      }
      return runTaskResponseSchema.parse({
        ...queuedResponse,
        workflow_start: workflowStart,
      });
    } catch (error) {
      if (admission) {
        await this.admissionRepository?.release(admission.admission_id, 'workflow_start_failed');
      }
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
      request_locale: true,
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
    const agentPlan = await this.resolveAgentExecutionPlan(parsed.tenant_id, parsed.user_id, parsed.agent_execution_plan_ref);
    const policySnapshot = await this.resolveTenantPolicySnapshot({
      tenantId: parsed.tenant_id,
      userId: parsed.user_id,
      executionPlanRef: agentPlan.executionPlanRef,
      executionPlanHash: agentPlan.executionPlanHash,
      executionPlanType: 'agent',
      requestId: parsed.request_id,
    });
    const admission = await this.reserveAdmission({
      tenantId: parsed.tenant_id,
      taskRunId,
      ...(policySnapshot ? { policySnapshot } : {}),
    });
    const workflowRequest: WorkflowStartRequest = {
      tenant_id: parsed.tenant_id,
      user_id: parsed.user_id,
      task_run_id: taskRunId,
      workflow_type: 'GenericAgentWorkflow',
      workflow_id: workflowId,
      agent_execution_plan_ref: parsed.agent_execution_plan_ref,
      ...(policySnapshot ? {
        tenant_policy_snapshot_ref: policySnapshot.snapshot_ref,
        tenant_policy_hash: policySnapshot.snapshot_hash,
      } : {}),
      ...(admission ? { tenant_admission_id: admission.admission_id } : {}),
      input: parsed.input,
      ...(parsed.request_locale ? { request_locale: parsed.request_locale } : {}),
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
      tenant_policy_snapshot_ref: policySnapshot?.snapshot_ref,
      tenant_policy_hash: policySnapshot?.snapshot_hash,
      tenant_admission_id: admission?.admission_id,
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
        tenant_policy_snapshot_ref: policySnapshot?.snapshot_ref,
        tenant_policy_hash: policySnapshot?.snapshot_hash,
        tenant_admission_id: admission?.admission_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      input: parsed.input,
      routeResult: { route_decision: routeDecision, candidates: [] },
      executionPlanRef: parsed.agent_execution_plan_ref,
      ...(policySnapshot ? {
        tenantPolicySnapshotRef: policySnapshot.snapshot_ref,
        tenantPolicyHash: policySnapshot.snapshot_hash,
      } : {}),
      ...(admission ? { tenantAdmissionId: admission.admission_id } : {}),
    });

    try {
      const workflowStart = await this.workflowStarter.start(workflowRequest);
      await this.taskStore.updateWorkflowStart(taskRunId, workflowStart);
      if (admission) {
        await this.admissionRepository?.activate(admission.admission_id, {
          workflowId,
          ...(workflowStart.run_id ? { workflowRunId: workflowStart.run_id } : {}),
        });
      }
      return runTaskResponseSchema.parse({ ...queuedResponse, workflow_start: workflowStart });
    } catch (error) {
      if (admission) {
        await this.admissionRepository?.release(admission.admission_id, 'workflow_start_failed');
      }
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
  ): Promise<{ executionPlanRef: string; executionPlanHash: string; flowSha256: string; hasAgentSteps: boolean } | undefined> {
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

  private async resolveAgentExecutionPlan(
    tenantId: string,
    userId: string,
    executionPlanRef: string,
  ): Promise<{ executionPlanRef: string; executionPlanHash: string }> {
    if (!this.agentExecutionPlanResolver) {
      if (this.allowMockRouteFallback) {
        return { executionPlanRef, executionPlanHash: '0'.repeat(64) };
      }
      throw new Error(`AgentExecutionPlan resolver is not configured for ${executionPlanRef}`);
    }
    const plan = await this.agentExecutionPlanResolver.resolve({ tenantId, userId, executionPlanRef });
    if (!plan) {
      throw new Error(`AgentExecutionPlan not found: ${executionPlanRef}`);
    }
    return plan;
  }

  private async resolveTenantPolicySnapshot(input: {
    tenantId: string;
    userId: string;
    executionPlanRef: string;
    executionPlanHash: string;
    executionPlanType: 'flow' | 'agent';
    requestId: string;
  }): Promise<TenantRuntimePolicySnapshot | undefined> {
    if (!this.tenantPolicyResolver) {
      if (this.tenantPolicyMode === 'required') {
        throw new TenantRuntimePolicyError('TENANT_RUNTIME_POLICY_NOT_FOUND', 'Tenant runtime policy resolver is not configured', 403);
      }
      return undefined;
    }
    const result = await this.tenantPolicyResolver.resolve({
      tenant_id: input.tenantId,
      user_id: input.userId,
      execution_plan_ref: input.executionPlanRef,
      execution_plan_hash: input.executionPlanHash,
      execution_plan_type: input.executionPlanType,
      request_id: input.requestId,
      mode: this.tenantPolicyMode,
    });
    return result.snapshot;
  }

  private async reserveAdmission(input: {
    tenantId: string;
    taskRunId: string;
    policySnapshot?: TenantRuntimePolicySnapshot;
  }) {
    if (!input.policySnapshot) {
      if (this.tenantPolicyMode === 'required') {
        throw new TenantRuntimePolicyError('TENANT_RUNTIME_POLICY_NOT_FOUND', 'Tenant runtime policy snapshot is required for admission', 403);
      }
      return undefined;
    }
    if (!this.admissionRepository) {
      if (this.tenantPolicyMode === 'required') {
        throw new TenantRuntimePolicyError('TENANT_AGENT_ADMISSION_UNAVAILABLE', 'Tenant admission repository is required', 503);
      }
      return undefined;
    }
    const result = await this.admissionRepository.reserve({
      tenantId: input.tenantId,
      taskRunId: input.taskRunId,
      policySnapshotRef: input.policySnapshot.snapshot_ref,
      maxConcurrentAgentRuns: input.policySnapshot.max_concurrent_agent_runs,
    });
    if (!result.accepted || !result.admission) {
      throw new TenantRuntimePolicyError(
        'TENANT_AGENT_CONCURRENCY_EXCEEDED',
        'Tenant agent concurrency limit exceeded',
        429,
        { active_count: result.activeCount, max_concurrent_agent_runs: input.policySnapshot.max_concurrent_agent_runs },
      );
    }
    return result.admission;
  }

  async get(taskRunId: string): Promise<TaskRun | undefined> {
    return this.taskStore.get(taskRunId);
  }

  async list(input: unknown): Promise<TaskRun[]> {
    const query = taskRunQuerySchema.parse(input);
    if (!query.tenant_id) {
      throw new Error('tenant_id is required for task_run query');
    }
    return this.taskStore.list({
      tenantId: query.tenant_id,
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
    request_locale: parsed.request_locale ?? 'zh-CN',
  };
}

function buildLocalFlowSnapshotRef(flowId: string, version: number): string {
  return `${flowId}@${version}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow failed to start';
}

export async function previewRoute(
  input: unknown,
  routes: RouteSpec[],
  allowMockFallback = true,
  semanticRouting: Partial<SemanticRoutingOptions> = {},
): Promise<RouterPreviewResponse> {
  const normalized = normalizeRunTaskRequest(input);
  const result = await routeWithSemanticRecall(
      {
        tenantId: normalized.tenant_id,
        input: normalized.input,
      channel: normalized.channel,
      roles: normalized.roles,
      allowMockFallback,
    },
    routes,
    semanticRouting,
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
        tenantId: normalized.tenant_id,
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
  evaluationRunService?: EvaluationRunService;
  db?: Kysely<Database>;
  routeSource?: RouteSpecSource;
  close(): Promise<void>;
}

export function createRuntimeApiTaskService(config: RuntimeConfig = loadConfig()): RuntimeApiTaskServiceHandle {
  if (isProductionRuntime(config) && config.RUNTIME_API_ROUTE_SOURCE !== 'db') {
    throw new Error('RUNTIME_API_ROUTE_SOURCE=db is required in production');
  }

  if (config.RUNTIME_API_ROUTE_SOURCE === 'db') {
    const db: Kysely<Database> = createDb({ databaseUrl: config.DATABASE_URL });
    const routeSource = new DbRouteSpecSource(db);
    const semanticRouting = createSemanticRouting(config, db);
    return {
      taskService: new TaskService({
        routeSource,
        taskStore: new DbTaskRunStore(new TaskRunRepository(db)),
        workflowStarter: createWorkflowStarter(config),
        executionPlanResolver: new DbExecutionPlanResolver(db),
        agentExecutionPlanResolver: new DbAgentExecutionPlanResolver(db),
        tenantPolicyResolver: new TenantRuntimePolicyResolver(db),
        admissionRepository: new TenantAgentAdmissionRepository(db),
        tenantPolicyMode: config.TENANT_RUNTIME_POLICY_MODE,
        allowMockRouteFallback: false,
        buildFlowSnapshotRef: buildDbFlowSnapshotRef,
        semanticRouting,
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
      evaluationRunService: new EvaluationRunService({ db, config }),
      db,
      routeSource,
      close: async () => closeDb(db),
    };
  }

  const routeSource = new MemoryRouteSpecSource();
  return {
    taskService: new TaskService({
      routeSource,
      workflowStarter: createWorkflowStarter(config),
      allowMockRouteFallback: true,
    }),
    humanTaskService: new HumanTaskService(),
    agentRunService: new AgentRunService(),
    routeSource,
    close: async () => undefined,
  };
}

function createSemanticRouting(
  config: RuntimeConfig,
  db: Kysely<Database>,
): Partial<SemanticRoutingOptions> {
  if (!config.ROUTER_SEMANTIC_ENABLED) {
    return { enabled: false };
  }
  if (!config.ROUTER_EMBEDDING_MODEL_ID || !config.ROUTER_EMBEDDING_MODEL_VERSION) {
    throw new Error('ROUTER_EMBEDDING_MODEL_NOT_CONFIGURED: ROUTER_EMBEDDING_MODEL_ID and ROUTER_EMBEDDING_MODEL_VERSION are required');
  }
  const resolver = new RouterEmbeddingModelResolver({
    db,
    credentialMasterKey: config.MODEL_CREDENTIAL_MASTER_KEY,
    modelId: config.ROUTER_EMBEDDING_MODEL_ID,
    modelVersion: config.ROUTER_EMBEDDING_MODEL_VERSION,
    timeoutMs: config.ROUTER_EMBEDDING_TIMEOUT_MS,
    maxResponseBytes: config.MODEL_GATEWAY_MAX_RESPONSE_BYTES,
    allowInsecureHttp: config.MODEL_GATEWAY_ALLOW_INSECURE_HTTP,
    userAgent: 'durable-agent-runtime-lite/runtime-api-router',
  });
  return {
    enabled: true,
    adapter: new PgVectorRecallAdapter({
      repository: new RouteEmbeddingRepository(db),
      embeddingResolver: resolver,
      topK: config.ROUTER_VECTOR_TOP_K,
    }),
    topK: config.ROUTER_VECTOR_TOP_K,
    matchThreshold: config.ROUTER_SEMANTIC_MATCH_THRESHOLD,
    clarifyThreshold: config.ROUTER_SEMANTIC_CLARIFY_THRESHOLD,
    minMargin: config.ROUTER_SEMANTIC_MIN_MARGIN,
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
  }): Promise<{ executionPlanRef: string; executionPlanHash: string; flowSha256: string; hasAgentSteps: boolean } | undefined> {
    void input.userId;
    const plan = await this.repository.getLatestForFlow(input.flowId, input.flowVersion, { tenantId: input.tenantId });
    return plan
      ? {
          executionPlanRef: plan.execution_plan_ref,
          executionPlanHash: plan.execution_plan_hash,
          flowSha256: plan.flow_sha256,
          hasAgentSteps: plan.agents.length > 0,
        }
      : undefined;
  }
}

export class DbAgentExecutionPlanResolver implements AgentExecutionPlanResolver {
  private readonly repository: AgentExecutionPlanRepository;

  constructor(db: Kysely<Database>) {
    this.repository = new AgentExecutionPlanRepository(db);
  }

  async resolve(input: {
    tenantId: string;
    userId: string;
    executionPlanRef: string;
  }): Promise<{ executionPlanRef: string; executionPlanHash: string } | undefined> {
    void input.userId;
    const plan = await this.repository.getByRef(input.executionPlanRef, { tenantId: input.tenantId });
    return plan
      ? { executionPlanRef: plan.execution_plan_ref, executionPlanHash: plan.execution_plan_hash }
      : undefined;
  }
}

function isProductionRuntime(config: RuntimeConfig): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}
