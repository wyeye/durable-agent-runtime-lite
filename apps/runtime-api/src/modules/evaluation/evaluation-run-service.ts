import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  evaluationRunCreateRequestSchema,
  evaluationRunQuerySchema,
  type EvaluationCaseResult,
  type EvaluationRun,
  type EvaluationRunCreateRequest,
} from '@dar/contracts';
import {
  EvaluationCaseRepository,
  EvaluationCaseResultRepository,
  EvaluationExecutionPlanRepository,
  EvaluationRepositoryError,
  EvaluationRunRepository,
  type Database,
} from '@dar/db';
import { type RuntimeConfig } from '@dar/config';
import type { Kysely } from 'kysely';
import {
  createEvaluationWorkflowStarter,
  type EvaluationWorkflowStarter,
} from '../workflow/workflow-starter.js';

const authenticatedEvaluationRunCreateRequestSchema = evaluationRunCreateRequestSchema.extend({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  request_id: z.string().min(1),
  trace_id: z.string().min(1).optional(),
});

export interface EvaluationRunServiceOptions {
  db: Kysely<Database>;
  config: RuntimeConfig;
  workflowStarter?: EvaluationWorkflowStarter;
}

export interface EvaluationRunCreateResponse {
  evaluation_run: EvaluationRun;
  workflow_start: {
    workflow_id: string;
    run_id?: string;
    task_run_id: string;
    started: boolean;
    mode: 'mock' | 'temporal';
  };
}

export class EvaluationRunService {
  private readonly runs: EvaluationRunRepository;
  private readonly plans: EvaluationExecutionPlanRepository;
  private readonly cases: EvaluationCaseRepository;
  private readonly results: EvaluationCaseResultRepository;
  private readonly workflowStarter: EvaluationWorkflowStarter;

  constructor(private readonly options: EvaluationRunServiceOptions) {
    this.runs = new EvaluationRunRepository(options.db);
    this.plans = new EvaluationExecutionPlanRepository(options.db);
    this.cases = new EvaluationCaseRepository(options.db);
    this.results = new EvaluationCaseResultRepository(options.db);
    this.workflowStarter = options.workflowStarter ?? createEvaluationWorkflowStarter(options.config);
  }

  async create(input: unknown): Promise<EvaluationRunCreateResponse> {
    const request = authenticatedEvaluationRunCreateRequestSchema.parse(input);
    const planRef = required(request.evaluation_execution_plan_ref, 'evaluation_execution_plan_ref');
    const planHash = required(request.evaluation_execution_plan_hash, 'evaluation_execution_plan_hash');
    const plan = await this.plans.getByRef(planRef);
    if (!plan || plan.tenant_id !== request.tenant_id || plan.plan_hash !== planHash) {
      throw new EvaluationRepositoryError(
        'EVALUATION_EXECUTION_PLAN_HASH_MISMATCH',
        'EvaluationExecutionPlan ref/hash does not match tenant scoped source of truth',
      );
    }
    verifyRequestMatchesPlan(request, plan);
    const enabledCases = await this.cases.list(plan.dataset_id, plan.dataset_version, true);
    const evaluationRunId = `eval_run_${randomUUID()}`;
    const workflowId = buildEvaluationRunWorkflowId(request.tenant_id, evaluationRunId);
    const run = await this.runs.create({
      tenantId: request.tenant_id,
      datasetId: plan.dataset_id,
      datasetVersion: plan.dataset_version,
      datasetHash: plan.dataset_hash,
      subjectSnapshotRef: plan.subject_snapshot_ref,
      subjectSnapshotHash: plan.subject_snapshot_hash,
      evaluationExecutionPlanRef: plan.evaluation_execution_plan_ref,
      evaluationExecutionPlanHash: plan.plan_hash,
      triggerType: request.trigger_type,
      ...(request.baseline_run_id ? { baselineRunId: request.baseline_run_id } : {}),
      createdBy: request.user_id,
      totalCases: enabledCases.length,
      workflowId,
    });

    try {
      const workflowStart = await this.workflowStarter.startEvaluationRun({
        tenant_id: run.tenant_id,
        user_id: request.user_id,
        evaluation_run_id: run.evaluation_run_id,
        evaluation_execution_plan_ref: run.evaluation_execution_plan_ref,
        evaluation_execution_plan_hash: run.evaluation_execution_plan_hash,
        workflow_id: workflowId,
        request_id: request.request_id,
        ...(request.trace_id ? { trace_id: request.trace_id } : {}),
      });
      const attached = await this.runs.attachWorkflow(
        run.evaluation_run_id,
        workflowStart.workflow_id,
        workflowStart.run_id,
      );
      return {
        evaluation_run: attached,
        workflow_start: {
          workflow_id: workflowStart.workflow_id,
          ...(workflowStart.run_id ? { run_id: workflowStart.run_id } : {}),
          task_run_id: workflowStart.task_run_id,
          started: workflowStart.started,
          mode: workflowStart.mode,
        },
      };
    } catch (error) {
      await this.runs.fail(run.evaluation_run_id, 'EVALUATION_WORKFLOW_START_FAILED', errorMessage(error));
      throw error;
    }
  }

  async get(runId: string, input: unknown): Promise<EvaluationRun | undefined> {
    const query = evaluationRunQuerySchema.pick({ tenant_id: true }).partial().parse(input ?? {});
    const run = await this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    if (query.tenant_id && run.tenant_id !== query.tenant_id) {
      return undefined;
    }
    return run;
  }

  async list(input: unknown): Promise<EvaluationRun[]> {
    const query = evaluationRunQuerySchema.parse(input);
    if (!query.tenant_id) {
      throw new EvaluationRepositoryError('TENANT_REQUIRED', 'tenant_id is required for evaluation run query');
    }
    return this.runs.list({
      tenantId: query.tenant_id,
      ...(query.dataset_id ? { datasetId: query.dataset_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.trigger_type ? { triggerType: query.trigger_type } : {}),
      ...(query.resource_id ? { resourceId: query.resource_id } : {}),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
  }

  async listResults(runId: string, input: unknown): Promise<EvaluationCaseResult[]> {
    const run = await this.get(runId, input);
    if (!run) {
      return [];
    }
    return this.results.listByRun(runId);
  }

  async cancel(runId: string, input: unknown): Promise<EvaluationRun> {
    const run = await this.get(runId, input);
    if (!run) {
      throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'EvaluationRun not found');
    }
    const marked = await this.runs.markCancellationRequested(runId);
    if (marked.workflow_id) {
      await this.workflowStarter.cancelEvaluationRun(marked.workflow_id);
    }
    return marked;
  }
}

function verifyRequestMatchesPlan(request: EvaluationRunCreateRequest, plan: {
  dataset_id: string;
  dataset_version: number;
  dataset_hash: string;
  subject_snapshot_ref: string;
  subject_snapshot_hash: string;
}): void {
  if (
    request.dataset_id !== plan.dataset_id ||
    request.dataset_version !== plan.dataset_version ||
    (request.dataset_hash && request.dataset_hash !== plan.dataset_hash) ||
    (request.subject_snapshot_ref && request.subject_snapshot_ref !== plan.subject_snapshot_ref) ||
    (request.subject_snapshot_hash && request.subject_snapshot_hash !== plan.subject_snapshot_hash)
  ) {
    throw new EvaluationRepositoryError(
      'EVALUATION_RUN_REQUEST_PLAN_MISMATCH',
      'Evaluation run request does not match immutable EvaluationExecutionPlan',
    );
  }
}

function required(value: string | undefined, field: string): string {
  if (!value) {
    throw new EvaluationRepositoryError('EVALUATION_EXECUTION_PLAN_REQUIRED', `${field} is required`);
  }
  return value;
}

function buildEvaluationRunWorkflowId(tenantId: string, runId: string): string {
  return `evaluation-run-${sanitize(tenantId)}-${sanitize(runId)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Evaluation workflow failed to start';
}
