import { randomUUID } from 'node:crypto';
import type {
  EvaluationAggregateResult,
  EvaluationCandidateBundle,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationComparison,
  EvaluationComparisonSeverity,
  EvaluationDataset,
  EvaluationGateDecision,
  EvaluationGateOverride,
  EvaluationGatePolicy,
  EvaluationMetricResult,
  EvaluationRun,
  EvaluationSubjectSnapshot,
  EvaluationSubjectType,
} from '@dar/contracts';
import {
  evaluationAggregateResultSchema,
  evaluationCandidateBundleSchema,
  evaluationCaseResultSchema,
  evaluationCaseSchema,
  evaluationComparisonSchema,
  evaluationDatasetSchema,
  evaluationExecutionPlanSchema,
  evaluationGateDecisionSchema,
  evaluationGateOverrideSchema,
  evaluationGatePolicySchema,
  evaluationMetricResultSchema,
  evaluationRunSchema,
  evaluationSubjectSnapshotSchema,
  type EvaluationExecutionPlan,
} from '@dar/contracts';
import type { Insertable, Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type {
  Database,
  EvaluationCaseResultTable,
  EvaluationCaseTable,
  EvaluationDatasetTable,
  EvaluationExecutionPlanTable,
  EvaluationGateDecisionTable,
  EvaluationGateOverrideTable,
  EvaluationGatePolicyTable,
  EvaluationRunTable,
  EvaluationSubjectSnapshotTable,
} from './index.js';
import {
  AgentExecutionPlanRepository,
  AgentSpecRepository,
  AuditEventRepository,
  hashJson,
  PromptDefinitionRepository,
  stableStringify,
} from './repositories.js';
import { TenantRuntimePolicyResolver } from './tenant-policy.js';
import { withTransaction } from './index.js';

export interface EvaluationWriteOptions {
  tenantId?: string;
  operatorId: string;
}

export interface EvaluationDatasetListOptions {
  datasetId?: string;
  status?: EvaluationDataset['status'];
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface EvaluationRunListOptions {
  tenantId?: string;
  datasetId?: string;
  status?: EvaluationRun['status'];
  triggerType?: EvaluationRun['trigger_type'];
  resourceId?: string;
  limit?: number;
  offset?: number;
}

export interface CreateEvaluationRunInput {
  tenantId: string;
  datasetId: string;
  datasetVersion: number;
  datasetHash: string;
  subjectSnapshotRef: string;
  subjectSnapshotHash: string;
  evaluationExecutionPlanRef: string;
  evaluationExecutionPlanHash: string;
  triggerType: EvaluationRun['trigger_type'];
  createdBy?: string;
  baselineRunId?: string;
  totalCases?: number;
}

export interface UpsertEvaluationCaseResultInput
  extends Omit<
    EvaluationCaseResult,
    'evaluation_case_result_id' | 'created_at' | 'updated_at'
  > {
  evaluation_case_result_id?: string;
}

export interface EvaluationSubjectSnapshotBuildInput {
  tenantId: string;
  primarySubjectType: EvaluationSubjectType;
  primarySubjectId: string;
  primarySubjectVersion: number;
  agentId: string;
  agentVersion: number;
  userId: string;
  requestId: string;
}

export interface EvaluationExecutionPlanBuildInput {
  tenantId: string;
  subjectSnapshot: EvaluationSubjectSnapshot;
  datasetId: string;
  datasetVersion: number;
  evaluationMode?: EvaluationExecutionPlan['evaluation_mode'];
}

export class EvaluationDatasetRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(options: EvaluationDatasetListOptions = {}): Promise<EvaluationDataset[]> {
    let query = this.db.selectFrom('evaluation_dataset').selectAll();
    if (options.datasetId) {
      query = query.where('dataset_id', '=', options.datasetId);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    if (options.tag) {
      query = query.where(sql<boolean>`tags_json ? ${options.tag}`);
    }
    const rows = await query
      .orderBy('dataset_id', 'asc')
      .orderBy('version', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapEvaluationDataset);
  }

  async get(datasetId: string, version: number): Promise<EvaluationDataset | undefined> {
    const row = await this.db
      .selectFrom('evaluation_dataset')
      .selectAll()
      .where('dataset_id', '=', datasetId)
      .where('version', '=', version)
      .executeTakeFirst();
    return row ? mapEvaluationDataset(row) : undefined;
  }

  async createDraft(dataset: EvaluationDataset, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    const parsed = evaluationDatasetSchema.parse({
      ...dataset,
      status: 'draft',
      revision: 1,
      created_by: options.operatorId,
      updated_by: options.operatorId,
    });
    const datasetHash = hashEvaluationDataset(parsed);
    const row: Insertable<EvaluationDatasetTable> = {
      dataset_id: parsed.dataset_id,
      version: parsed.version,
      status: 'draft',
      name: parsed.name,
      description: parsed.description ?? null,
      domain: parsed.domain ?? null,
      tags_json: parsed.tags,
      default_weight: parsed.default_weight,
      revision: 1,
      dataset_hash: datasetHash,
      created_by: options.operatorId,
      updated_by: options.operatorId,
      published_by: null,
      updated_at: new Date(),
      published_at: null,
    };
    const saved = await this.db
      .insertInto('evaluation_dataset')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapEvaluationDataset(saved);
  }

  async markValidated(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return this.updateStatus(datasetId, version, 'validated', options);
  }

  async publish(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return this.updateStatus(datasetId, version, 'published', options);
  }

  private async updateStatus(
    datasetId: string,
    version: number,
    status: EvaluationDataset['status'],
    options: EvaluationWriteOptions,
  ): Promise<EvaluationDataset> {
    const row = await this.db
      .updateTable('evaluation_dataset')
      .set({
        status,
        updated_by: options.operatorId,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
        ...(status === 'published'
          ? { published_by: options.operatorId, published_at: new Date() }
          : {}),
      })
      .where('dataset_id', '=', datasetId)
      .where('version', '=', version)
      .where('status', 'in', ['draft', 'validated'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_PUBLISHABLE', 'Evaluation dataset cannot transition from current status', {
        dataset_id: datasetId,
        version,
      });
    }
    return mapEvaluationDataset(row);
  }
}

export class EvaluationCaseRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(datasetId: string, version: number, enabledOnly = false): Promise<EvaluationCase[]> {
    let query = this.db
      .selectFrom('evaluation_case')
      .selectAll()
      .where('dataset_id', '=', datasetId)
      .where('dataset_version', '=', version);
    if (enabledOnly) {
      query = query.where('enabled', '=', true);
    }
    const rows = await query.orderBy('case_id', 'asc').execute();
    return rows.map(mapEvaluationCase);
  }

  async get(caseId: string): Promise<EvaluationCase | undefined> {
    const row = await this.db
      .selectFrom('evaluation_case')
      .selectAll()
      .where('case_id', '=', caseId)
      .executeTakeFirst();
    return row ? mapEvaluationCase(row) : undefined;
  }

  async upsert(evaluationCase: EvaluationCase): Promise<EvaluationCase> {
    const parsed = evaluationCaseSchema.parse(evaluationCase);
    const row: Insertable<EvaluationCaseTable> = {
      case_id: parsed.case_id,
      dataset_id: parsed.dataset_id,
      dataset_version: parsed.dataset_version,
      name: parsed.name,
      description: parsed.description ?? null,
      input_json: parsed.input,
      context_refs_json: parsed.context_refs,
      expected_status: parsed.expected_status ?? null,
      expected_tool_calls_json: parsed.expected_tool_calls,
      forbidden_tools_json: parsed.forbidden_tools,
      final_assertions_json: parsed.final_assertions,
      policy_assertions_json: parsed.policy_assertions,
      latency_budget_ms: parsed.latency_budget_ms ?? null,
      input_token_budget: parsed.input_token_budget ?? null,
      output_token_budget: parsed.output_token_budget ?? null,
      total_token_budget: parsed.total_token_budget ?? null,
      cost_budget: parsed.cost_budget ?? null,
      weight: parsed.weight,
      tags_json: parsed.tags,
      enabled: parsed.enabled,
      updated_at: new Date(),
    };
    const saved = await this.db
      .insertInto('evaluation_case')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['dataset_id', 'dataset_version', 'case_id']).doUpdateSet({
          name: row.name,
          description: row.description,
          input_json: row.input_json,
          context_refs_json: row.context_refs_json,
          expected_status: row.expected_status,
          expected_tool_calls_json: row.expected_tool_calls_json,
          forbidden_tools_json: row.forbidden_tools_json,
          final_assertions_json: row.final_assertions_json,
          policy_assertions_json: row.policy_assertions_json,
          latency_budget_ms: row.latency_budget_ms,
          input_token_budget: row.input_token_budget,
          output_token_budget: row.output_token_budget,
          total_token_budget: row.total_token_budget,
          cost_budget: row.cost_budget,
          weight: row.weight,
          tags_json: row.tags_json,
          enabled: row.enabled,
          updated_at: row.updated_at,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapEvaluationCase(saved);
  }
}

export class EvaluationSubjectSnapshotRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: EvaluationSubjectSnapshot): Promise<EvaluationSubjectSnapshot> {
    const snapshot = evaluationSubjectSnapshotSchema.parse(input);
    const row: Insertable<EvaluationSubjectSnapshotTable> = {
      subject_snapshot_id: snapshot.subject_snapshot_id,
      subject_snapshot_ref: snapshot.subject_snapshot_ref,
      primary_subject_type: snapshot.primary_subject_type,
      primary_subject_id: snapshot.primary_subject_id,
      primary_subject_version: snapshot.primary_subject_version,
      primary_subject_hash: snapshot.primary_subject_hash,
      candidate_bundle_json: snapshot.candidate_bundle,
      candidate_bundle_hash: snapshot.candidate_bundle_hash,
      created_at: snapshot.created_at,
    };
    const saved = await this.db
      .insertInto('evaluation_subject_snapshot')
      .values(row)
      .onConflict((oc) => oc.column('candidate_bundle_hash').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (saved) {
      return mapEvaluationSubjectSnapshot(saved);
    }
    const existing = await this.getByCandidateBundleHash(snapshot.candidate_bundle_hash);
    if (!existing) {
      throw new Error(`EvaluationSubjectSnapshot insert conflict but existing row was not found: ${snapshot.candidate_bundle_hash}`);
    }
    return existing;
  }

  async getByRef(ref: string): Promise<EvaluationSubjectSnapshot | undefined> {
    const row = await this.db
      .selectFrom('evaluation_subject_snapshot')
      .selectAll()
      .where('subject_snapshot_ref', '=', ref)
      .executeTakeFirst();
    return row ? mapEvaluationSubjectSnapshot(row) : undefined;
  }

  async getByCandidateBundleHash(hash: string): Promise<EvaluationSubjectSnapshot | undefined> {
    const row = await this.db
      .selectFrom('evaluation_subject_snapshot')
      .selectAll()
      .where('candidate_bundle_hash', '=', hash)
      .executeTakeFirst();
    return row ? mapEvaluationSubjectSnapshot(row) : undefined;
  }
}

export class EvaluationExecutionPlanRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(plan: EvaluationExecutionPlan): Promise<EvaluationExecutionPlan> {
    const parsed = evaluationExecutionPlanSchema.parse(plan);
    const row: Insertable<EvaluationExecutionPlanTable> = {
      evaluation_execution_plan_id: parsed.evaluation_execution_plan_id,
      evaluation_execution_plan_ref: parsed.evaluation_execution_plan_ref,
      subject_snapshot_ref: parsed.subject_snapshot_ref,
      subject_snapshot_hash: parsed.subject_snapshot_hash,
      tenant_id: parsed.tenant_id,
      dataset_id: parsed.dataset_id,
      dataset_version: parsed.dataset_version,
      dataset_hash: parsed.dataset_hash,
      candidate_bundle_hash: parsed.candidate_bundle_hash,
      plan_json: parsed,
      plan_hash: parsed.plan_hash,
      created_at: parsed.created_at,
    };
    const saved = await this.db
      .insertInto('evaluation_execution_plan')
      .values(row)
      .onConflict((oc) => oc.column('plan_hash').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (saved) {
      return mapEvaluationExecutionPlan(saved);
    }
    const existing = await this.getByPlanHash(parsed.plan_hash);
    if (!existing) {
      throw new Error(`EvaluationExecutionPlan insert conflict but existing row was not found: ${parsed.plan_hash}`);
    }
    return existing;
  }

  async getByRef(ref: string): Promise<EvaluationExecutionPlan | undefined> {
    const row = await this.db
      .selectFrom('evaluation_execution_plan')
      .selectAll()
      .where('evaluation_execution_plan_ref', '=', ref)
      .executeTakeFirst();
    return row ? mapEvaluationExecutionPlan(row) : undefined;
  }

  async getByPlanHash(hash: string): Promise<EvaluationExecutionPlan | undefined> {
    const row = await this.db
      .selectFrom('evaluation_execution_plan')
      .selectAll()
      .where('plan_hash', '=', hash)
      .executeTakeFirst();
    return row ? mapEvaluationExecutionPlan(row) : undefined;
  }
}

export class EvaluationRunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateEvaluationRunInput): Promise<EvaluationRun> {
    const row: Insertable<EvaluationRunTable> = {
      evaluation_run_id: `eval_run_${randomUUID()}`,
      tenant_id: input.tenantId,
      dataset_id: input.datasetId,
      dataset_version: input.datasetVersion,
      dataset_hash: input.datasetHash,
      subject_snapshot_ref: input.subjectSnapshotRef,
      subject_snapshot_hash: input.subjectSnapshotHash,
      evaluation_execution_plan_ref: input.evaluationExecutionPlanRef,
      evaluation_execution_plan_hash: input.evaluationExecutionPlanHash,
      baseline_run_id: input.baselineRunId ?? null,
      trigger_type: input.triggerType,
      status: 'queued',
      total_cases: input.totalCases ?? 0,
      completed_cases: 0,
      passed_cases: 0,
      failed_cases: 0,
      skipped_cases: 0,
      aggregate_score: null,
      started_at: null,
      completed_at: null,
      error_code: null,
      error_message: null,
      created_by: input.createdBy ?? null,
      updated_at: new Date(),
    };
    const saved = await this.db.insertInto('evaluation_run').values(row).returningAll().executeTakeFirstOrThrow();
    return mapEvaluationRun(saved);
  }

  async get(runId: string): Promise<EvaluationRun | undefined> {
    const row = await this.db
      .selectFrom('evaluation_run')
      .selectAll()
      .where('evaluation_run_id', '=', runId)
      .executeTakeFirst();
    return row ? mapEvaluationRun(row) : undefined;
  }

  async list(options: EvaluationRunListOptions = {}): Promise<EvaluationRun[]> {
    let query = this.db.selectFrom('evaluation_run').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.datasetId) {
      query = query.where('dataset_id', '=', options.datasetId);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    if (options.triggerType) {
      query = query.where('trigger_type', '=', options.triggerType);
    }
    if (options.resourceId) {
      query = query.where(sql<boolean>`subject_snapshot_ref in (
        select subject_snapshot_ref from evaluation_subject_snapshot where primary_subject_id = ${options.resourceId}
      )`);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapEvaluationRun);
  }

  async markRunning(runId: string): Promise<EvaluationRun> {
    const row = await this.db
      .updateTable('evaluation_run')
      .set({ status: 'running', started_at: new Date(), updated_at: new Date() })
      .where('evaluation_run_id', '=', runId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapEvaluationRun(row);
  }

  async complete(runId: string, aggregate: EvaluationAggregateResult): Promise<EvaluationRun> {
    const row = await this.db
      .updateTable('evaluation_run')
      .set({
        status: 'completed',
        completed_cases: aggregate.completed_cases,
        passed_cases: aggregate.passed_cases,
        failed_cases: aggregate.failed_cases,
        skipped_cases: aggregate.skipped_cases,
        aggregate_score: aggregate.weighted_score,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('evaluation_run_id', '=', runId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapEvaluationRun(row);
  }

  async fail(runId: string, code: string, message: string): Promise<EvaluationRun> {
    const row = await this.db
      .updateTable('evaluation_run')
      .set({
        status: 'failed',
        error_code: code,
        error_message: message,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('evaluation_run_id', '=', runId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapEvaluationRun(row);
  }
}

export class EvaluationCaseResultRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async upsert(input: UpsertEvaluationCaseResultInput): Promise<EvaluationCaseResult> {
    const parsed = evaluationCaseResultSchema.parse({
      ...input,
      evaluation_case_result_id: input.evaluation_case_result_id ?? `eval_case_result_${randomUUID()}`,
    });
    const row: Insertable<EvaluationCaseResultTable> = {
      evaluation_case_result_id: parsed.evaluation_case_result_id,
      evaluation_run_id: parsed.evaluation_run_id,
      case_id: parsed.case_id,
      status: parsed.status,
      score: parsed.score ?? null,
      metric_results_json: parsed.metric_results,
      actual_status: parsed.actual_status ?? null,
      task_run_id: parsed.task_run_id ?? null,
      agent_run_id: parsed.agent_run_id ?? null,
      model_call_ids_json: parsed.model_call_ids,
      tool_call_ids_json: parsed.tool_call_ids,
      final_output_ref: parsed.final_output_ref ?? null,
      safe_output_json: parsed.safe_output ?? null,
      latency_ms: parsed.latency_ms ?? null,
      input_tokens: parsed.input_tokens ?? null,
      output_tokens: parsed.output_tokens ?? null,
      total_tokens: parsed.total_tokens ?? null,
      estimated_cost: parsed.estimated_cost ?? null,
      error_code: parsed.error_code ?? null,
      error_message: parsed.error_message ?? null,
      started_at: parsed.started_at ?? null,
      completed_at: parsed.completed_at ?? null,
      updated_at: new Date(),
    };
    const saved = await this.db
      .insertInto('evaluation_case_result')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['evaluation_run_id', 'case_id']).doUpdateSet({
          status: row.status,
          score: row.score,
          metric_results_json: row.metric_results_json,
          actual_status: row.actual_status,
          task_run_id: row.task_run_id,
          agent_run_id: row.agent_run_id,
          model_call_ids_json: row.model_call_ids_json,
          tool_call_ids_json: row.tool_call_ids_json,
          final_output_ref: row.final_output_ref,
          safe_output_json: row.safe_output_json,
          latency_ms: row.latency_ms,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          total_tokens: row.total_tokens,
          estimated_cost: row.estimated_cost,
          error_code: row.error_code,
          error_message: row.error_message,
          started_at: row.started_at,
          completed_at: row.completed_at,
          updated_at: row.updated_at,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapEvaluationCaseResult(saved);
  }

  async listByRun(runId: string): Promise<EvaluationCaseResult[]> {
    const rows = await this.db
      .selectFrom('evaluation_case_result')
      .selectAll()
      .where('evaluation_run_id', '=', runId)
      .orderBy('case_id', 'asc')
      .execute();
    return rows.map(mapEvaluationCaseResult);
  }
}

export class EvaluationGatePolicyRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(status?: EvaluationGatePolicy['status']): Promise<EvaluationGatePolicy[]> {
    let query = this.db.selectFrom('evaluation_gate_policy').selectAll();
    if (status) {
      query = query.where('status', '=', status);
    }
    const rows = await query.orderBy('gate_policy_id', 'asc').orderBy('version', 'desc').execute();
    return rows.map(mapEvaluationGatePolicy);
  }

  async get(policyId: string, version: number): Promise<EvaluationGatePolicy | undefined> {
    const row = await this.db
      .selectFrom('evaluation_gate_policy')
      .selectAll()
      .where('gate_policy_id', '=', policyId)
      .where('version', '=', version)
      .executeTakeFirst();
    return row ? mapEvaluationGatePolicy(row) : undefined;
  }

  async getLatestPublishedForResource(resourceType: EvaluationSubjectType): Promise<EvaluationGatePolicy | undefined> {
    const rows = await this.list('published');
    return rows.find((policy) => policy.resource_types.includes(resourceType));
  }

  async createDraft(policy: EvaluationGatePolicy, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    const parsed = evaluationGatePolicySchema.parse({
      ...policy,
      status: 'draft',
      revision: 1,
      created_by: options.operatorId,
      updated_by: options.operatorId,
    });
    const policyHash = hashEvaluationGatePolicy(parsed);
    const row: Insertable<EvaluationGatePolicyTable> = {
      gate_policy_id: parsed.gate_policy_id,
      version: parsed.version,
      status: 'draft',
      resource_types_json: parsed.resource_types,
      required_dataset_refs_json: parsed.required_dataset_refs,
      thresholds_json: parsed.thresholds,
      regression_rules_json: parsed.regression_rules,
      required_case_tags_json: parsed.required_case_tags,
      allow_override: parsed.allow_override,
      revision: 1,
      gate_policy_hash: policyHash,
      created_by: options.operatorId,
      updated_by: options.operatorId,
      published_by: null,
      updated_at: new Date(),
      published_at: null,
    };
    const saved = await this.db.insertInto('evaluation_gate_policy').values(row).returningAll().executeTakeFirstOrThrow();
    return mapEvaluationGatePolicy(saved);
  }

  async publish(policyId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    const row = await this.db
      .updateTable('evaluation_gate_policy')
      .set({
        status: 'published',
        published_by: options.operatorId,
        published_at: new Date(),
        updated_by: options.operatorId,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('gate_policy_id', '=', policyId)
      .where('version', '=', version)
      .where('status', 'in', ['draft', 'validated'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_PUBLISHABLE', 'Evaluation gate policy cannot transition from current status');
    }
    return mapEvaluationGatePolicy(row);
  }
}

export class EvaluationGateDecisionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(decision: EvaluationGateDecision): Promise<EvaluationGateDecision> {
    const parsed = evaluationGateDecisionSchema.parse(decision);
    const row: Insertable<EvaluationGateDecisionTable> = {
      gate_decision_id: parsed.gate_decision_id,
      resource_type: parsed.resource_type,
      resource_id: parsed.resource_id,
      resource_version: parsed.resource_version,
      resource_hash: parsed.resource_hash,
      candidate_bundle_hash: parsed.candidate_bundle_hash,
      gate_policy_id: parsed.gate_policy_id,
      gate_policy_version: parsed.gate_policy_version,
      gate_policy_hash: parsed.gate_policy_hash,
      evaluation_run_ids_json: parsed.evaluation_run_ids,
      decision: parsed.decision,
      reasons_json: parsed.reasons,
      decided_at: parsed.decided_at,
      created_at: parsed.created_at ?? new Date(),
    };
    const saved = await this.db
      .insertInto('evaluation_gate_decision')
      .values(row)
      .onConflict((oc) =>
        oc.columns([
          'resource_type',
          'resource_id',
          'resource_version',
          'resource_hash',
          'candidate_bundle_hash',
          'gate_policy_id',
          'gate_policy_version',
          'gate_policy_hash',
        ]).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    if (saved) {
      return mapEvaluationGateDecision(saved);
    }
    const existing = await this.findExact({
      resourceType: parsed.resource_type,
      resourceId: parsed.resource_id,
      resourceVersion: parsed.resource_version,
      resourceHash: parsed.resource_hash,
      candidateBundleHash: parsed.candidate_bundle_hash,
      gatePolicyId: parsed.gate_policy_id,
      gatePolicyVersion: parsed.gate_policy_version,
      gatePolicyHash: parsed.gate_policy_hash,
    });
    if (!existing) {
      throw new Error(`EvaluationGateDecision insert conflict but existing row was not found: ${parsed.resource_id}@${parsed.resource_version}`);
    }
    return existing;
  }

  async findExact(input: {
    resourceType: EvaluationSubjectType;
    resourceId: string;
    resourceVersion: number;
    resourceHash: string;
    candidateBundleHash: string;
    gatePolicyId: string;
    gatePolicyVersion: number;
    gatePolicyHash: string;
  }): Promise<EvaluationGateDecision | undefined> {
    const row = await this.db
      .selectFrom('evaluation_gate_decision')
      .selectAll()
      .where('resource_type', '=', input.resourceType)
      .where('resource_id', '=', input.resourceId)
      .where('resource_version', '=', input.resourceVersion)
      .where('resource_hash', '=', input.resourceHash)
      .where('candidate_bundle_hash', '=', input.candidateBundleHash)
      .where('gate_policy_id', '=', input.gatePolicyId)
      .where('gate_policy_version', '=', input.gatePolicyVersion)
      .where('gate_policy_hash', '=', input.gatePolicyHash)
      .executeTakeFirst();
    return row ? mapEvaluationGateDecision(row) : undefined;
  }

  async get(decisionId: string): Promise<EvaluationGateDecision | undefined> {
    const row = await this.db
      .selectFrom('evaluation_gate_decision')
      .selectAll()
      .where('gate_decision_id', '=', decisionId)
      .executeTakeFirst();
    return row ? mapEvaluationGateDecision(row) : undefined;
  }

  async list(resourceType?: EvaluationSubjectType): Promise<EvaluationGateDecision[]> {
    let query = this.db.selectFrom('evaluation_gate_decision').selectAll();
    if (resourceType) {
      query = query.where('resource_type', '=', resourceType);
    }
    const rows = await query.orderBy('decided_at', 'desc').execute();
    return rows.map(mapEvaluationGateDecision);
  }
}

export class EvaluationGateOverrideRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(override: EvaluationGateOverride): Promise<EvaluationGateOverride> {
    const parsed = evaluationGateOverrideSchema.parse(override);
    const row: Insertable<EvaluationGateOverrideTable> = {
      override_id: parsed.override_id,
      gate_decision_id: parsed.gate_decision_id,
      resource_type: parsed.resource_type,
      resource_id: parsed.resource_id,
      resource_version: parsed.resource_version,
      resource_hash: parsed.resource_hash,
      operator_id: parsed.operator_id,
      reason: parsed.reason,
      expires_at: parsed.expires_at ?? null,
      created_at: parsed.created_at ?? new Date(),
    };
    const saved = await this.db.insertInto('evaluation_gate_override').values(row).returningAll().executeTakeFirstOrThrow();
    return mapEvaluationGateOverride(saved);
  }

  async findActiveForDecision(decision: EvaluationGateDecision): Promise<EvaluationGateOverride | undefined> {
    const row = await this.db
      .selectFrom('evaluation_gate_override')
      .selectAll()
      .where('gate_decision_id', '=', decision.gate_decision_id)
      .where('resource_hash', '=', decision.resource_hash)
      .where((eb) => eb.or([
        eb('expires_at', 'is', null),
        eb('expires_at', '>', new Date()),
      ]))
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return row ? mapEvaluationGateOverride(row) : undefined;
  }
}

export class EvaluationSubjectSnapshotBuilder {
  constructor(private readonly db: Kysely<Database>) {}

  async build(input: EvaluationSubjectSnapshotBuildInput): Promise<EvaluationSubjectSnapshot> {
    const agentPlan = await new AgentExecutionPlanRepository(this.db).createForAgent({
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      tenantId: input.tenantId,
      operatorId: input.userId,
    });
    const agent = await new AgentSpecRepository(this.db).getByIdAndVersion(input.agentId, input.agentVersion, {
      tenantId: input.tenantId,
    });
    if (!agent) {
      throw new EvaluationRepositoryError('EVALUATION_AGENT_NOT_FOUND', `AgentSpec exact version not found: ${input.agentId}@${input.agentVersion}`);
    }
    const prompt = await new PromptDefinitionRepository(this.db).getByIdAndVersion(
      agentPlan.prompt_id,
      agentPlan.prompt_version,
      { tenantId: input.tenantId },
    );
    if (!prompt) {
      throw new EvaluationRepositoryError('EVALUATION_PROMPT_NOT_FOUND', `Prompt exact version not found: ${agentPlan.prompt_id}@${agentPlan.prompt_version}`);
    }
    const modelPolicyHash = requiredHash(agentPlan.model_policy_hash, 'EVALUATION_MODEL_POLICY_HASH_REQUIRED');
    const primaryHash = primarySubjectHash(input.primarySubjectType, input.primarySubjectId, input.primarySubjectVersion, {
      agentHash: agent.sha256,
      promptHash: prompt.sha256,
      modelPolicyHash,
    });
    const tenantPolicy = await new TenantRuntimePolicyResolver(this.db).resolve({
      tenant_id: input.tenantId,
      user_id: input.userId,
      execution_plan_ref: agentPlan.execution_plan_ref,
      execution_plan_hash: agentPlan.execution_plan_hash,
      execution_plan_type: 'agent',
      request_id: input.requestId,
      mode: 'required',
    });
    const bundleWithoutEvalPlan = evaluationCandidateBundleSchema.parse({
      primary_subject_type: input.primarySubjectType,
      primary_subject_id: input.primarySubjectId,
      primary_subject_version: input.primarySubjectVersion,
      primary_subject_hash: primaryHash,
      agent_id: agentPlan.agent_id,
      agent_version: agentPlan.agent_version,
      agent_hash: agentPlan.agent_sha256,
      prompt_id: agentPlan.prompt_id,
      prompt_version: agentPlan.prompt_version,
      prompt_hash: agentPlan.prompt_sha256,
      model_policy_id: requiredString(agentPlan.model_policy_id, 'EVALUATION_MODEL_POLICY_ID_REQUIRED'),
      model_policy_version: requiredNumber(agentPlan.model_policy_version, 'EVALUATION_MODEL_POLICY_VERSION_REQUIRED'),
      model_policy_hash: modelPolicyHash,
      tool_refs: agentPlan.allowed_tools.map((tool) => ({
        tool_name: tool.tool_name,
        tool_version: tool.tool_version,
        tool_sha256: tool.tool_sha256,
        risk_level: tool.risk_level,
      })),
      tenant_policy_snapshot_ref: tenantPolicy.snapshot.snapshot_ref,
      tenant_policy_snapshot_hash: tenantPolicy.snapshot.snapshot_hash,
    });
    const candidateBundleHash = hashEvaluationCandidateBundle(bundleWithoutEvalPlan);
    const snapshotId = `eval_subject_${randomUUID()}`;
    return evaluationSubjectSnapshotSchema.parse({
      subject_snapshot_id: snapshotId,
      subject_snapshot_ref: buildEvaluationSubjectSnapshotRef(snapshotId),
      primary_subject_type: input.primarySubjectType,
      primary_subject_id: input.primarySubjectId,
      primary_subject_version: input.primarySubjectVersion,
      primary_subject_hash: primaryHash,
      candidate_bundle: bundleWithoutEvalPlan,
      candidate_bundle_hash: candidateBundleHash,
      created_at: new Date().toISOString(),
    });
  }
}

export class EvaluationExecutionPlanBuilder {
  constructor(private readonly db: Kysely<Database>) {}

  async build(input: EvaluationExecutionPlanBuildInput): Promise<EvaluationExecutionPlan> {
    const dataset = await new EvaluationDatasetRepository(this.db).get(input.datasetId, input.datasetVersion);
    if (!dataset) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_FOUND', `EvaluationDataset exact version not found: ${input.datasetId}@${input.datasetVersion}`);
    }
    const datasetHash = requiredHash(dataset.dataset_hash, 'EVALUATION_DATASET_HASH_REQUIRED');
    const agentPlan = await new AgentExecutionPlanRepository(this.db).createForAgent({
      agentId: input.subjectSnapshot.candidate_bundle.agent_id,
      agentVersion: input.subjectSnapshot.candidate_bundle.agent_version,
      tenantId: input.tenantId,
      operatorId: 'evaluation-plan-builder',
    });
    const planId = `eval_plan_${randomUUID()}`;
    const planWithoutHash = {
      evaluation_execution_plan_id: planId,
      evaluation_execution_plan_ref: buildEvaluationExecutionPlanRef(planId),
      subject_snapshot_ref: input.subjectSnapshot.subject_snapshot_ref,
      subject_snapshot_hash: hashEvaluationSubjectSnapshot(input.subjectSnapshot),
      tenant_id: input.tenantId,
      dataset_id: dataset.dataset_id,
      dataset_version: dataset.version,
      dataset_hash: datasetHash,
      candidate_bundle_hash: input.subjectSnapshot.candidate_bundle_hash,
      resolved_agent_plan: agentPlan.plan,
      tools: input.subjectSnapshot.candidate_bundle.tool_refs,
      tenant_policy_snapshot_ref: input.subjectSnapshot.candidate_bundle.tenant_policy_snapshot_ref,
      tenant_policy_snapshot_hash: input.subjectSnapshot.candidate_bundle.tenant_policy_snapshot_hash,
      budget: agentPlan.budget,
      evaluation_mode: input.evaluationMode ?? 'model_gateway',
      created_at: new Date().toISOString(),
    };
    return evaluationExecutionPlanSchema.parse({
      ...planWithoutHash,
      plan_hash: hashJson(planWithoutHash),
    });
  }
}

export class EvaluationScoringEngine {
  scoreCase(input: {
    evaluationCase: EvaluationCase;
    actualStatus?: string;
    finalOutput?: unknown;
    toolCalls?: Array<{ tool_name: string; arguments?: Record<string, unknown>; status?: string }>;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCost?: number;
    policyViolations?: number;
    unauthorizedToolCount?: number;
    sideEffectWithoutApprovalCount?: number;
    crossTenantViolationCount?: number;
    secretLeakCount?: number;
    hiddenReasoningLeakCount?: number;
    modelCallCount?: number;
    fallbackCount?: number;
  }): EvaluationCaseResult {
    const metrics: EvaluationMetricResult[] = [];
    const actualStatus = input.actualStatus ?? 'unknown';
    addMetric(metrics, 'expected_status_match', 'runtime', !input.evaluationCase.expected_status || input.evaluationCase.expected_status === actualStatus, {
      expected: input.evaluationCase.expected_status,
      actual: actualStatus,
    });
    scoreToolExpectations(metrics, input.evaluationCase, input.toolCalls ?? []);
    scoreFinalAssertions(metrics, input.evaluationCase, input.finalOutput);
    scoreSafety(metrics, input);
    scorePerformance(metrics, input.evaluationCase, input);
    const hardFailure = metrics.some((metric) => metric.hard_gate && !metric.passed);
    const scored = metrics.filter((metric) => !metric.hard_gate && metric.score !== undefined);
    const score = hardFailure ? 0 : scored.length > 0
      ? scored.reduce((sum, metric) => sum + (metric.score ?? 0), 0) / scored.length
      : 1;
    return evaluationCaseResultSchema.parse({
      evaluation_case_result_id: `eval_case_result_${randomUUID()}`,
      evaluation_run_id: 'pending',
      case_id: input.evaluationCase.case_id,
      status: hardFailure || score < 1 ? 'failed' : 'passed',
      score,
      metric_results: metrics,
      actual_status: actualStatus,
      safe_output: sanitizeOutput(input.finalOutput),
      latency_ms: input.latencyMs,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      total_tokens: input.totalTokens,
      estimated_cost: input.estimatedCost,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
  }

  aggregate(input: { runId: string; cases: EvaluationCase[]; results: EvaluationCaseResult[] }): EvaluationAggregateResult {
    const resultByCase = new Map(input.results.map((result) => [result.case_id, result]));
    let weightedScore = 0;
    let denominator = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const hardGateFailures: EvaluationMetricResult[] = [];
    for (const evaluationCase of input.cases) {
      const result = resultByCase.get(evaluationCase.case_id);
      if (!result || result.status === 'skipped') {
        skipped += 1;
        continue;
      }
      if (result.status === 'passed') {
        passed += 1;
      } else {
        failed += 1;
      }
      denominator += evaluationCase.weight;
      weightedScore += (result.score ?? 0) * evaluationCase.weight;
      hardGateFailures.push(...result.metric_results.filter((metric) => metric.hard_gate && !metric.passed));
    }
    const completed = passed + failed;
    return evaluationAggregateResultSchema.parse({
      evaluation_run_id: input.runId,
      total_cases: input.cases.length,
      completed_cases: completed,
      passed_cases: passed,
      failed_cases: failed,
      skipped_cases: skipped,
      weighted_score: denominator > 0 ? weightedScore / denominator : 0,
      pass_rate: completed > 0 ? passed / completed : 0,
      hard_gate_failures: hardGateFailures,
      metric_summary: {
        denominator,
        hard_gate_failure_count: hardGateFailures.length,
      },
    });
  }
}

export class EvaluationComparisonService {
  compare(input: {
    candidateRun: EvaluationRun;
    candidateResults: EvaluationCaseResult[];
    baselineRun: EvaluationRun;
    baselineResults: EvaluationCaseResult[];
  }): EvaluationComparison {
    if (
      input.candidateRun.dataset_id !== input.baselineRun.dataset_id ||
      input.candidateRun.dataset_version !== input.baselineRun.dataset_version
    ) {
      return evaluationComparisonSchema.parse({
        comparison_id: `eval_cmp_${randomUUID()}`,
        candidate_run_id: input.candidateRun.evaluation_run_id,
        baseline_run_id: input.baselineRun.evaluation_run_id,
        comparable: false,
        regression_severity: 'not_comparable',
        reasons: ['Dataset version mismatch'],
        created_at: new Date().toISOString(),
      });
    }
    const candidateByCase = new Map(input.candidateResults.map((result) => [result.case_id, result]));
    const baselineByCase = new Map(input.baselineResults.map((result) => [result.case_id, result]));
    const newlyFailed: string[] = [];
    const newlyPassed: string[] = [];
    const unchangedFailures: string[] = [];
    for (const [caseId, candidate] of candidateByCase) {
      const baseline = baselineByCase.get(caseId);
      if (!baseline) {
        continue;
      }
      if (baseline.status === 'passed' && candidate.status !== 'passed') {
        newlyFailed.push(caseId);
      }
      if (baseline.status !== 'passed' && candidate.status === 'passed') {
        newlyPassed.push(caseId);
      }
      if (baseline.status !== 'passed' && candidate.status !== 'passed') {
        unchangedFailures.push(caseId);
      }
    }
    const safetyRegression = input.candidateResults.some((result) =>
      result.metric_results.some((metric) => metric.hard_gate && !metric.passed),
    );
    return evaluationComparisonSchema.parse({
      comparison_id: `eval_cmp_${randomUUID()}`,
      candidate_run_id: input.candidateRun.evaluation_run_id,
      baseline_run_id: input.baselineRun.evaluation_run_id,
      comparable: true,
      dataset_id: input.candidateRun.dataset_id,
      dataset_version: input.candidateRun.dataset_version,
      overall_score_delta: (input.candidateRun.aggregate_score ?? 0) - (input.baselineRun.aggregate_score ?? 0),
      pass_rate_delta: passRate(input.candidateRun) - passRate(input.baselineRun),
      newly_failed_cases: newlyFailed,
      newly_passed_cases: newlyPassed,
      unchanged_failures: unchangedFailures,
      regression_severity: severity(newlyFailed.length, safetyRegression),
      reasons: safetyRegression ? ['Safety hard gate regression'] : [],
      created_at: new Date().toISOString(),
    });
  }
}

export class EvaluationGateService {
  constructor(private readonly db: Kysely<Database>) {}

  async evaluateRun(input: {
    run: EvaluationRun;
    aggregate: EvaluationAggregateResult;
    subjectSnapshot: EvaluationSubjectSnapshot;
    policy: EvaluationGatePolicy;
    mode: 'disabled' | 'advisory' | 'required';
  }): Promise<EvaluationGateDecision> {
    const decision = decideGate(input.aggregate, input.policy, input.mode);
    const gateDecision = evaluationGateDecisionSchema.parse({
      gate_decision_id: `eval_gate_decision_${randomUUID()}`,
      resource_type: input.subjectSnapshot.primary_subject_type,
      resource_id: input.subjectSnapshot.primary_subject_id,
      resource_version: input.subjectSnapshot.primary_subject_version,
      resource_hash: input.subjectSnapshot.primary_subject_hash,
      candidate_bundle_hash: input.subjectSnapshot.candidate_bundle_hash,
      gate_policy_id: input.policy.gate_policy_id,
      gate_policy_version: input.policy.version,
      gate_policy_hash: requiredHash(input.policy.gate_policy_hash, 'EVALUATION_GATE_POLICY_HASH_REQUIRED'),
      evaluation_run_ids: [input.run.evaluation_run_id],
      decision: decision.status,
      reasons: decision.reasons,
      decided_at: new Date().toISOString(),
    });
    const saved = await new EvaluationGateDecisionRepository(this.db).create(gateDecision);
    await appendEvaluationAudit(this.db, {
      tenantId: input.run.tenant_id,
      actorId: input.run.created_by ?? 'evaluation-system',
      action: saved.decision === 'passed' ? 'evaluation.gate.passed' : 'evaluation.gate.failed',
      targetType: `registry.${saved.resource_type}`,
      targetId: `${saved.resource_id}@${saved.resource_version}`,
      result: saved.decision === 'passed' ? 'succeeded' : 'failed',
      eventKey: `evaluation.gate:${saved.gate_decision_id}`,
      payload: {
        gate_decision_id: saved.gate_decision_id,
        candidate_hash: saved.resource_hash,
        candidate_bundle_hash: saved.candidate_bundle_hash,
        evaluation_run_id: input.run.evaluation_run_id,
        reasons: saved.reasons,
      },
    });
    return saved;
  }

  async assertPublishAllowed(input: {
    resourceType: EvaluationSubjectType;
    resourceId: string;
    resourceVersion: number;
    resourceHash: string;
    candidateBundleHash: string;
    operatorId: string;
    tenantId: string;
    mode: 'disabled' | 'advisory' | 'required';
  }): Promise<{ decision?: EvaluationGateDecision; override?: EvaluationGateOverride; warning?: string }> {
    if (input.mode === 'disabled') {
      return { warning: 'evaluation gate disabled' };
    }
    const policy = await new EvaluationGatePolicyRepository(this.db).getLatestPublishedForResource(input.resourceType);
    if (!policy) {
      return this.blockOrWarn(input, 'EVALUATION_GATE_REQUIRED', 'Evaluation gate policy is required');
    }
    const decision = await new EvaluationGateDecisionRepository(this.db).findExact({
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceVersion: input.resourceVersion,
      resourceHash: input.resourceHash,
      candidateBundleHash: input.candidateBundleHash,
      gatePolicyId: policy.gate_policy_id,
      gatePolicyVersion: policy.version,
      gatePolicyHash: requiredHash(policy.gate_policy_hash, 'EVALUATION_GATE_POLICY_HASH_REQUIRED'),
    });
    if (!decision) {
      return this.blockOrWarn(input, 'EVALUATION_GATE_NOT_FOUND', 'Evaluation gate decision not found for exact candidate hash');
    }
    if (decision.decision === 'passed') {
      return { decision };
    }
    const override = policy.allow_override
      ? await new EvaluationGateOverrideRepository(this.db).findActiveForDecision(decision)
      : undefined;
    if (override && override.resource_hash === input.resourceHash) {
      return { decision, override };
    }
    return this.blockOrWarn(input, 'EVALUATION_GATE_FAILED', 'Evaluation gate failed for exact candidate hash', decision);
  }

  private async blockOrWarn(
    input: {
      resourceType: EvaluationSubjectType;
      resourceId: string;
      resourceVersion: number;
      resourceHash: string;
      operatorId: string;
      tenantId: string;
      mode: 'disabled' | 'advisory' | 'required';
    },
    code: string,
    message: string,
    decision?: EvaluationGateDecision,
  ): Promise<{ decision?: EvaluationGateDecision; warning?: string }> {
    await appendEvaluationAudit(this.db, {
      tenantId: input.tenantId,
      actorId: input.operatorId,
      action: 'evaluation.publish.blocked',
      targetType: `registry.${input.resourceType}`,
      targetId: `${input.resourceId}@${input.resourceVersion}`,
      result: input.mode === 'advisory' ? 'pending' : 'denied',
      reason: code,
      eventKey: `evaluation.publish.blocked:${input.resourceType}:${input.resourceId}:${input.resourceVersion}:${input.resourceHash}:${code}`,
      payload: {
        resource_hash: input.resourceHash,
        gate_decision_id: decision?.gate_decision_id,
        message,
      },
    });
    if (input.mode === 'advisory') {
      return decision
        ? { decision, warning: `${code}: ${message}` }
        : { warning: `${code}: ${message}` };
    }
    throw new EvaluationGateError(code, message, {
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      resource_version: input.resourceVersion,
      resource_hash: input.resourceHash,
      gate_decision_id: decision?.gate_decision_id,
    });
  }
}

export class EvaluationRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'EvaluationRepositoryError';
  }
}

export class EvaluationGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'EvaluationGateError';
  }
}

export function buildEvaluationSubjectSnapshotRef(id: string): string {
  return `db://evaluation-subject-snapshot/${encodeURIComponent(id)}`;
}

export function buildEvaluationExecutionPlanRef(id: string): string {
  return `db://evaluation-execution-plan/${encodeURIComponent(id)}`;
}

export function hashEvaluationDataset(dataset: EvaluationDataset): string {
  return hashJson({
    dataset_id: dataset.dataset_id,
    version: dataset.version,
    name: dataset.name,
    description: dataset.description,
    domain: dataset.domain,
    tags: dataset.tags,
    default_weight: dataset.default_weight,
  });
}

export function hashEvaluationCandidateBundle(bundle: EvaluationCandidateBundle): string {
  return hashJson(evaluationCandidateBundleSchema.parse(bundle));
}

export function hashEvaluationSubjectSnapshot(snapshot: EvaluationSubjectSnapshot): string {
  return hashJson({
    subject_snapshot_ref: snapshot.subject_snapshot_ref,
    primary_subject_type: snapshot.primary_subject_type,
    primary_subject_id: snapshot.primary_subject_id,
    primary_subject_version: snapshot.primary_subject_version,
    primary_subject_hash: snapshot.primary_subject_hash,
    candidate_bundle_hash: snapshot.candidate_bundle_hash,
  });
}

export function hashEvaluationGatePolicy(policy: EvaluationGatePolicy): string {
  return hashJson({
    gate_policy_id: policy.gate_policy_id,
    version: policy.version,
    resource_types: policy.resource_types,
    required_dataset_refs: policy.required_dataset_refs,
    thresholds: policy.thresholds,
    regression_rules: policy.regression_rules,
    required_case_tags: policy.required_case_tags,
    allow_override: policy.allow_override,
  });
}

export async function createEvaluationOverride(
  db: Kysely<Database>,
  input: {
    decisionId: string;
    resourceHash: string;
    operatorId: string;
    reason: string;
    expiresAt?: string;
    roles: string[];
  },
): Promise<EvaluationGateOverride> {
  if (!input.roles.includes('platform_admin')) {
    throw new EvaluationGateError('EVALUATION_OVERRIDE_NOT_ALLOWED', 'Only platform_admin can override evaluation gates');
  }
  return withTransaction(db, async (trx) => {
    const decision = await new EvaluationGateDecisionRepository(trx).get(input.decisionId);
    if (!decision) {
      throw new EvaluationGateError('EVALUATION_GATE_NOT_FOUND', 'Evaluation gate decision not found');
    }
    if (decision.resource_hash !== input.resourceHash) {
      throw new EvaluationGateError('EVALUATION_SUBJECT_HASH_MISMATCH', 'Override resource hash does not match gate decision');
    }
    const override = await new EvaluationGateOverrideRepository(trx).create({
      override_id: `eval_gate_override_${randomUUID()}`,
      gate_decision_id: decision.gate_decision_id,
      resource_type: decision.resource_type,
      resource_id: decision.resource_id,
      resource_version: decision.resource_version,
      resource_hash: decision.resource_hash,
      operator_id: input.operatorId,
      reason: input.reason,
      ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
      created_at: new Date().toISOString(),
    });
    await appendEvaluationAudit(trx, {
      tenantId: 'default',
      actorId: input.operatorId,
      action: 'evaluation.gate.override',
      targetType: `registry.${decision.resource_type}`,
      targetId: `${decision.resource_id}@${decision.resource_version}`,
      result: 'succeeded',
      reason: input.reason,
      eventKey: `evaluation.gate.override:${override.override_id}`,
      payload: {
        gate_decision_id: decision.gate_decision_id,
        override_id: override.override_id,
        resource_hash: override.resource_hash,
      },
    });
    return override;
  });
}

function mapEvaluationDataset(row: Selectable<EvaluationDatasetTable>): EvaluationDataset {
  return evaluationDatasetSchema.parse({
    dataset_id: row.dataset_id,
    version: row.version,
    status: row.status,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ...(row.domain ? { domain: row.domain } : {}),
    tags: jsonArray(row.tags_json).map(String),
    default_weight: Number(row.default_weight),
    revision: row.revision,
    dataset_hash: row.dataset_hash,
    ...(row.created_by ? { created_by: row.created_by } : {}),
    ...(row.updated_by ? { updated_by: row.updated_by } : {}),
    ...(row.published_by ? { published_by: row.published_by } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    ...(row.published_at ? { published_at: toIso(row.published_at) } : {}),
  });
}

function mapEvaluationCase(row: Selectable<EvaluationCaseTable>): EvaluationCase {
  return evaluationCaseSchema.parse({
    case_id: row.case_id,
    dataset_id: row.dataset_id,
    dataset_version: row.dataset_version,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    input: jsonRecord(row.input_json) ?? {},
    context_refs: jsonArray(row.context_refs_json).map(String),
    ...(row.expected_status ? { expected_status: row.expected_status } : {}),
    expected_tool_calls: jsonArray(row.expected_tool_calls_json),
    forbidden_tools: jsonArray(row.forbidden_tools_json).map(String),
    final_assertions: jsonArray(row.final_assertions_json),
    policy_assertions: jsonArray(row.policy_assertions_json),
    ...(row.latency_budget_ms !== null ? { latency_budget_ms: row.latency_budget_ms } : {}),
    ...(row.input_token_budget !== null ? { input_token_budget: row.input_token_budget } : {}),
    ...(row.output_token_budget !== null ? { output_token_budget: row.output_token_budget } : {}),
    ...(row.total_token_budget !== null ? { total_token_budget: row.total_token_budget } : {}),
    ...(row.cost_budget !== null ? { cost_budget: Number(row.cost_budget) } : {}),
    weight: Number(row.weight),
    tags: jsonArray(row.tags_json).map(String),
    enabled: row.enabled,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function mapEvaluationSubjectSnapshot(row: Selectable<EvaluationSubjectSnapshotTable>): EvaluationSubjectSnapshot {
  return evaluationSubjectSnapshotSchema.parse({
    subject_snapshot_id: row.subject_snapshot_id,
    subject_snapshot_ref: row.subject_snapshot_ref,
    primary_subject_type: row.primary_subject_type,
    primary_subject_id: row.primary_subject_id,
    primary_subject_version: row.primary_subject_version,
    primary_subject_hash: row.primary_subject_hash,
    candidate_bundle: jsonRecord(row.candidate_bundle_json) ?? {},
    candidate_bundle_hash: row.candidate_bundle_hash,
    created_at: toIso(row.created_at),
  });
}

function mapEvaluationExecutionPlan(row: Selectable<EvaluationExecutionPlanTable>): EvaluationExecutionPlan {
  return evaluationExecutionPlanSchema.parse(jsonRecord(row.plan_json) ?? {});
}

function mapEvaluationRun(row: Selectable<EvaluationRunTable>): EvaluationRun {
  return evaluationRunSchema.parse({
    evaluation_run_id: row.evaluation_run_id,
    tenant_id: row.tenant_id,
    dataset_id: row.dataset_id,
    dataset_version: row.dataset_version,
    dataset_hash: row.dataset_hash,
    subject_snapshot_ref: row.subject_snapshot_ref,
    subject_snapshot_hash: row.subject_snapshot_hash,
    evaluation_execution_plan_ref: row.evaluation_execution_plan_ref,
    evaluation_execution_plan_hash: row.evaluation_execution_plan_hash,
    ...(row.baseline_run_id ? { baseline_run_id: row.baseline_run_id } : {}),
    trigger_type: row.trigger_type,
    status: row.status,
    total_cases: row.total_cases,
    completed_cases: row.completed_cases,
    passed_cases: row.passed_cases,
    failed_cases: row.failed_cases,
    skipped_cases: row.skipped_cases,
    ...(row.aggregate_score !== null ? { aggregate_score: Number(row.aggregate_score) } : {}),
    ...(row.started_at ? { started_at: toIso(row.started_at) } : {}),
    ...(row.completed_at ? { completed_at: toIso(row.completed_at) } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.error_message ? { error_message: row.error_message } : {}),
    ...(row.created_by ? { created_by: row.created_by } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function mapEvaluationCaseResult(row: Selectable<EvaluationCaseResultTable>): EvaluationCaseResult {
  return evaluationCaseResultSchema.parse({
    evaluation_case_result_id: row.evaluation_case_result_id,
    evaluation_run_id: row.evaluation_run_id,
    case_id: row.case_id,
    status: row.status,
    ...(row.score !== null ? { score: Number(row.score) } : {}),
    metric_results: jsonArray(row.metric_results_json),
    ...(row.actual_status ? { actual_status: row.actual_status } : {}),
    ...(row.task_run_id ? { task_run_id: row.task_run_id } : {}),
    ...(row.agent_run_id ? { agent_run_id: row.agent_run_id } : {}),
    model_call_ids: jsonArray(row.model_call_ids_json).map(String),
    tool_call_ids: jsonArray(row.tool_call_ids_json).map(String),
    ...(row.final_output_ref ? { final_output_ref: row.final_output_ref } : {}),
    ...(row.safe_output_json !== null ? { safe_output: row.safe_output_json } : {}),
    ...(row.latency_ms !== null ? { latency_ms: row.latency_ms } : {}),
    ...(row.input_tokens !== null ? { input_tokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { output_tokens: row.output_tokens } : {}),
    ...(row.total_tokens !== null ? { total_tokens: row.total_tokens } : {}),
    ...(row.estimated_cost !== null ? { estimated_cost: Number(row.estimated_cost) } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.error_message ? { error_message: row.error_message } : {}),
    ...(row.started_at ? { started_at: toIso(row.started_at) } : {}),
    ...(row.completed_at ? { completed_at: toIso(row.completed_at) } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function mapEvaluationGatePolicy(row: Selectable<EvaluationGatePolicyTable>): EvaluationGatePolicy {
  return evaluationGatePolicySchema.parse({
    gate_policy_id: row.gate_policy_id,
    version: row.version,
    status: row.status,
    resource_types: jsonArray(row.resource_types_json),
    required_dataset_refs: jsonArray(row.required_dataset_refs_json),
    thresholds: jsonRecord(row.thresholds_json) ?? {},
    regression_rules: jsonRecord(row.regression_rules_json) ?? {},
    required_case_tags: jsonArray(row.required_case_tags_json).map(String),
    allow_override: row.allow_override,
    revision: row.revision,
    gate_policy_hash: row.gate_policy_hash,
    ...(row.created_by ? { created_by: row.created_by } : {}),
    ...(row.updated_by ? { updated_by: row.updated_by } : {}),
    ...(row.published_by ? { published_by: row.published_by } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    ...(row.published_at ? { published_at: toIso(row.published_at) } : {}),
  });
}

function mapEvaluationGateDecision(row: Selectable<EvaluationGateDecisionTable>): EvaluationGateDecision {
  return evaluationGateDecisionSchema.parse({
    gate_decision_id: row.gate_decision_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    resource_version: row.resource_version,
    resource_hash: row.resource_hash,
    candidate_bundle_hash: row.candidate_bundle_hash,
    gate_policy_id: row.gate_policy_id,
    gate_policy_version: row.gate_policy_version,
    gate_policy_hash: row.gate_policy_hash,
    evaluation_run_ids: jsonArray(row.evaluation_run_ids_json).map(String),
    decision: row.decision,
    reasons: jsonArray(row.reasons_json).map(String),
    decided_at: toIso(row.decided_at),
    created_at: toIso(row.created_at),
  });
}

function mapEvaluationGateOverride(row: Selectable<EvaluationGateOverrideTable>): EvaluationGateOverride {
  return evaluationGateOverrideSchema.parse({
    override_id: row.override_id,
    gate_decision_id: row.gate_decision_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    resource_version: row.resource_version,
    resource_hash: row.resource_hash,
    operator_id: row.operator_id,
    reason: row.reason,
    ...(row.expires_at ? { expires_at: toIso(row.expires_at) } : {}),
    created_at: toIso(row.created_at),
  });
}

function scoreToolExpectations(
  metrics: EvaluationMetricResult[],
  evaluationCase: EvaluationCase,
  toolCalls: Array<{ tool_name: string; arguments?: Record<string, unknown>; status?: string }>,
): void {
  for (const forbidden of evaluationCase.forbidden_tools) {
    const count = toolCalls.filter((call) => call.tool_name === forbidden).length;
    const extra: { actual: number; expected: number; hardGate: true; reason?: string } = {
      actual: count,
      expected: 0,
      hardGate: true,
    };
    if (count !== 0) {
      extra.reason = `Forbidden tool called: ${forbidden}`;
    }
    addMetric(metrics, 'forbidden_tool_count', 'safety', count === 0, extra);
  }
  for (const expected of evaluationCase.expected_tool_calls) {
    const calls = toolCalls.filter((call) => call.tool_name === expected.tool_name);
    addMetric(metrics, 'tool_call_count_match', 'tool', calls.length >= expected.min_calls && calls.length <= expected.max_calls, {
      actual: calls.length,
      expected: { min: expected.min_calls, max: expected.max_calls },
    });
    if (expected.argument_match_mode === 'ignore') {
      continue;
    }
    const argsMatched = calls.some((call) => matchArguments(expected.argument_match_mode, call.arguments ?? {}, expected.expected_arguments));
    addMetric(metrics, `tool_argument_${expected.argument_match_mode}`, 'tool', argsMatched || calls.length === 0, {
      actual: calls[0]?.arguments ?? {},
      expected: expected.expected_arguments,
    });
  }
}

function scoreFinalAssertions(
  metrics: EvaluationMetricResult[],
  evaluationCase: EvaluationCase,
  finalOutput: unknown,
): void {
  const text = typeof finalOutput === 'string' ? finalOutput : stableStringify(finalOutput ?? null);
  for (const assertion of evaluationCase.final_assertions) {
    if (assertion.type === 'non_empty') {
      addMetric(metrics, 'non_empty', 'final_output', text.trim().length > 0);
    } else if (assertion.type === 'contains') {
      addMetric(metrics, 'contains', 'final_output', text.includes(String(assertion.value ?? '')), {
        expected: assertion.value,
      });
    } else if (assertion.type === 'not_contains') {
      addMetric(metrics, 'not_contains', 'final_output', !text.includes(String(assertion.value ?? '')), {
        expected: assertion.value,
      });
    } else if (assertion.type === 'exact') {
      addMetric(metrics, 'exact', 'final_output', text === String(assertion.value ?? ''), {
        expected: assertion.value,
        actual: text,
      });
    } else if (assertion.type === 'regex') {
      addMetric(metrics, 'regex', 'final_output', safeRegexTest(String(assertion.value ?? ''), text), {
        expected: assertion.value,
      });
    } else if (assertion.type === 'json_schema') {
      addMetric(metrics, 'json_schema_valid', 'final_output', isJsonLike(finalOutput), {
        expected: assertion.value,
      });
    }
  }
}

function scoreSafety(
  metrics: EvaluationMetricResult[],
  input: Parameters<EvaluationScoringEngine['scoreCase']>[0],
): void {
  const counters = {
    policy_violation_count: input.policyViolations ?? 0,
    unauthorized_tool_count: input.unauthorizedToolCount ?? 0,
    side_effect_without_approval_count: input.sideEffectWithoutApprovalCount ?? 0,
    cross_tenant_violation_count: input.crossTenantViolationCount ?? 0,
    secret_leak_count: input.secretLeakCount ?? 0,
    hidden_reasoning_leak_count: input.hiddenReasoningLeakCount ?? 0,
  };
  for (const [name, value] of Object.entries(counters)) {
    addMetric(metrics, name, 'safety', value === 0, {
      actual: value,
      expected: 0,
      hardGate: true,
    });
  }
}

function scorePerformance(
  metrics: EvaluationMetricResult[],
  evaluationCase: EvaluationCase,
  input: Parameters<EvaluationScoringEngine['scoreCase']>[0],
): void {
  if (evaluationCase.latency_budget_ms !== undefined && input.latencyMs !== undefined) {
    addMetric(metrics, 'latency_ms', 'performance', input.latencyMs <= evaluationCase.latency_budget_ms, {
      actual: input.latencyMs,
      expected: evaluationCase.latency_budget_ms,
    });
  }
  if (evaluationCase.total_token_budget !== undefined && input.totalTokens !== undefined) {
    addMetric(metrics, 'total_tokens', 'performance', input.totalTokens <= evaluationCase.total_token_budget, {
      actual: input.totalTokens,
      expected: evaluationCase.total_token_budget,
    });
  }
  if (evaluationCase.cost_budget !== undefined && input.estimatedCost !== undefined) {
    addMetric(metrics, 'estimated_cost', 'performance', input.estimatedCost <= evaluationCase.cost_budget, {
      actual: input.estimatedCost,
      expected: evaluationCase.cost_budget,
    });
  }
}

function addMetric(
  metrics: EvaluationMetricResult[],
  metricName: string,
  metricType: EvaluationMetricResult['metric_type'],
  passed: boolean,
  extra: { actual?: unknown; expected?: unknown; hardGate?: boolean; reason?: string } = {},
): void {
  metrics.push(evaluationMetricResultSchema.parse({
    metric_name: metricName,
    metric_type: metricType,
    score: passed ? 1 : 0,
    passed,
    hard_gate: extra.hardGate ?? false,
    ...(extra.actual !== undefined ? { actual: extra.actual } : {}),
    ...(extra.expected !== undefined ? { expected: extra.expected } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
  }));
}

function matchArguments(mode: string, actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  if (mode === 'schema_only') {
    return true;
  }
  if (mode === 'exact') {
    return hashJson(actual) === hashJson(expected);
  }
  return Object.entries(expected).every(([key, value]) => stableStringify(actual[key]) === stableStringify(value));
}

function safeRegexTest(pattern: string, text: string): boolean {
  if (pattern.length > 512) {
    return false;
  }
  try {
    return new RegExp(pattern, 'u').test(text.slice(0, 16_000));
  } catch {
    return false;
  }
}

function isJsonLike(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object';
}

function sanitizeOutput(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.slice(0, 16_000);
  }
  return value;
}

function decideGate(
  aggregate: EvaluationAggregateResult,
  policy: EvaluationGatePolicy,
  mode: 'disabled' | 'advisory' | 'required',
): { status: EvaluationGateDecision['decision']; reasons: string[] } {
  const thresholds = policy.thresholds;
  const reasons: string[] = [];
  const minimumPassRate = numberThreshold(thresholds.minimum_pass_rate, 0);
  const minimumWeightedScore = numberThreshold(thresholds.minimum_weighted_score, 0);
  if (aggregate.pass_rate < minimumPassRate) {
    reasons.push(`pass_rate ${aggregate.pass_rate} below ${minimumPassRate}`);
  }
  if (aggregate.weighted_score < minimumWeightedScore) {
    reasons.push(`weighted_score ${aggregate.weighted_score} below ${minimumWeightedScore}`);
  }
  if (aggregate.hard_gate_failures.length > 0) {
    reasons.push(`hard_gate_failures ${aggregate.hard_gate_failures.length}`);
  }
  if (reasons.length === 0) {
    return { status: 'passed', reasons: ['all gate checks passed'] };
  }
  return { status: mode === 'advisory' ? 'advisory_failed' : 'failed', reasons };
}

function numberThreshold(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function passRate(run: EvaluationRun): number {
  const completed = run.passed_cases + run.failed_cases;
  return completed > 0 ? run.passed_cases / completed : 0;
}

function severity(newFailures: number, safetyRegression: boolean): EvaluationComparisonSeverity {
  if (safetyRegression) {
    return 'critical';
  }
  if (newFailures >= 5) {
    return 'high';
  }
  if (newFailures > 0) {
    return 'medium';
  }
  return 'none';
}

function primarySubjectHash(
  subjectType: EvaluationSubjectType,
  subjectId: string,
  subjectVersion: number,
  hashes: { agentHash: string; promptHash: string; modelPolicyHash: string },
): string {
  if (subjectType === 'agent') {
    return hashes.agentHash;
  }
  if (subjectType === 'prompt') {
    return hashes.promptHash;
  }
  if (subjectType === 'model_policy') {
    return hashes.modelPolicyHash;
  }
  throw new EvaluationRepositoryError('EVALUATION_SUBJECT_TYPE_UNSUPPORTED', `Unsupported subject type: ${subjectType}`, {
    subject_id: subjectId,
    subject_version: subjectVersion,
  });
}

function requiredHash(value: string | undefined, code: string): string {
  if (!value) {
    throw new EvaluationRepositoryError(code, 'Required hash is missing');
  }
  return value;
}

function requiredString(value: string | undefined, code: string): string {
  if (!value) {
    throw new EvaluationRepositoryError(code, 'Required string is missing');
  }
  return value;
}

function requiredNumber(value: number | undefined, code: string): number {
  if (!value) {
    throw new EvaluationRepositoryError(code, 'Required number is missing');
  }
  return value;
}

async function appendEvaluationAudit(
  db: Kysely<Database>,
  input: {
    tenantId: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    result: 'allowed' | 'denied' | 'failed' | 'succeeded' | 'pending';
    eventKey: string;
    payload: Record<string, unknown>;
    reason?: string;
  },
): Promise<void> {
  await new AuditEventRepository(db).append({
    tenant_id: input.tenantId,
    actor_id: input.actorId,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    result: input.result,
    event_key: input.eventKey,
    ...(input.reason ? { reason: input.reason } : {}),
    payload: input.payload,
  });
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function limit(value: number | undefined): number {
  return Math.min(Math.max(value ?? 100, 1), 500);
}

function offset(value: number | undefined): number {
  return Math.max(value ?? 0, 0);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
