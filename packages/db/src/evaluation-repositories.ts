import { randomUUID } from 'node:crypto';
import type {
  AgentExecutionPlan,
  AgentStepRecord,
  AgentSpec,
  EvaluationAggregateResult,
  EvaluationCandidateBundle,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationComparison,
  EvaluationComparisonSeverity,
  EvaluationDataset,
  EvaluationGateDecision,
  EvaluationGateDecisionFreshness,
  EvaluationGateOverride,
  EvaluationGatePolicy,
  EvaluationGateFreshnessReason,
  EvaluationMetricResult,
  EvaluationRun,
  EvaluationSubjectSnapshot,
  EvaluationSubjectType,
  ModelCallRecord,
  ModelPolicy,
  PromptDefinition,
  ResolvedAgentPlan,
  ResolvedModelPolicy,
} from '@dar/contracts';
import {
  agentBudgetSchema,
  agentExecutionPlanSchema,
  evaluationAggregateResultSchema,
  evaluationCandidateBundleSchema,
  evaluationCaseResultSchema,
  evaluationCaseSchema,
  evaluationComparisonSchema,
  evaluationDatasetSchema,
  evaluationExecutionPlanSchema,
  evaluationGateThresholdsSchema,
  evaluationGateDecisionSchema,
  evaluationGateOverrideSchema,
  evaluationGatePolicySchema,
  evaluationMetricResultSchema,
  modelPolicyRefSchema,
  resolvedAgentPlanSchema,
  resolvedModelPolicySchema,
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
  EvaluationComparisonTable,
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
  AgentRunRepository,
  AgentSpecRepository,
  AgentStepRepository,
  AuditEventRepository,
  hashJson,
  HumanTaskRepository,
  hashModelPolicy,
  IdempotencyRecordRepository,
  ModelCallAttemptRepository,
  ModelCallLogRepository,
  ModelPolicyRepository,
  parseAgentOutputSchema,
  PromptDefinitionRepository,
  resolveModelPolicyRecord,
  stableStringify,
  TaskRunRepository,
  ToolCallLogRepository,
  ToolManifestRepository,
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

export interface EvaluationDatasetUpdateDraftInput {
  name?: string;
  description?: string | null;
  domain?: string | null;
  tags?: string[];
  defaultWeight?: number;
  expectedRevision?: number;
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
  workflowId?: string;
  workflowRunId?: string;
}

export interface UpsertEvaluationCaseResultInput
  extends Omit<
    EvaluationCaseResult,
    'evaluation_case_result_id' | 'created_at' | 'updated_at'
  > {
  evaluation_case_result_id?: string;
}

export interface EvaluationEvidenceSnapshot {
  actual_status: string;
  final_output_safe?: unknown;
  final_output_ref?: string;
  tool_calls: Array<{
    tool_call_id: string;
    tool_name: string;
    tool_version: string;
    status: string;
    policy_decision: string;
    arguments_hash?: string;
    result_ref?: string;
    mode?: string;
  }>;
  tool_call_order: string[];
  tool_order: string[];
  tool_arguments: Array<{ tool_name: string; input_hash?: string }>;
  tool_results_refs: string[];
  tool_result_refs: string[];
  unauthorized_tool_count: number;
  forbidden_tool_count: number;
  side_effect_without_approval_count: number;
  duplicate_tool_call_count: number;
  duplicate_commit_count: number;
  policy_violation_count: number;
  cross_tenant_violation_count: number;
  secret_leak_count: number;
  hidden_reasoning_leak_count: number;
  model_call_count: number;
  fallback_count: number;
  latency: { ms?: number };
  tokens: { input?: number; output?: number; total?: number };
  cost: { estimated?: number };
  system_error?: { code?: string; class?: string };
  completeness_status: 'complete' | 'incomplete';
  completeness_reasons: string[];
  error_code?: 'EVALUATION_EVIDENCE_INCOMPLETE';
  refs: {
    task_run_id?: string;
    agent_run_id?: string;
    agent_step_ids: string[];
    model_call_ids: string[];
    model_call_attempt_ids: string[];
    tool_call_ids: string[];
    human_task_ids: string[];
    audit_event_ids: string[];
    idempotency_record_ids: string[];
  };
}

export interface EvaluationEvidenceCollectorOptions {
  outputMaxBytes?: number;
  evidenceMaxBytes?: number;
}

export interface EvaluationSubjectSnapshotBuildInput {
  tenantId: string;
  primarySubjectType: EvaluationSubjectType;
  primarySubjectId: string;
  primarySubjectVersion: number;
  primarySubjectHash: string;
  agentId: string;
  agentVersion: number;
  agentHash?: string;
  promptId?: string;
  promptVersion?: number;
  promptHash?: string;
  modelPolicyId?: string;
  modelPolicyVersion?: number;
  modelPolicyHash?: string;
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

  async listVersions(datasetId: string): Promise<EvaluationDataset[]> {
    const rows = await this.db
      .selectFrom('evaluation_dataset')
      .selectAll()
      .where('dataset_id', '=', datasetId)
      .orderBy('version', 'desc')
      .execute();
    return rows.map(mapEvaluationDataset);
  }

  async createDraft(dataset: EvaluationDataset, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    const parsed = evaluationDatasetSchema.parse({
      ...dataset,
      status: 'draft',
      revision: 1,
      created_by: options.operatorId,
      updated_by: options.operatorId,
    });
    const datasetHash = hashEvaluationDataset(parsed, []);
    const row: Insertable<EvaluationDatasetTable> = {
      dataset_id: parsed.dataset_id,
      version: parsed.version,
      status: 'draft',
      name: parsed.name,
      description: parsed.description ?? null,
      domain: parsed.domain ?? null,
      tags_json: toDbJson(parsed.tags),
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

  async updateDraft(
    datasetId: string,
    version: number,
    input: EvaluationDatasetUpdateDraftInput,
    options: EvaluationWriteOptions,
  ): Promise<EvaluationDataset> {
    const existing = await this.getMutableDataset(datasetId, version);
    if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_REVISION_CONFLICT', 'Evaluation dataset revision conflict', {
        dataset_id: datasetId,
        version,
        expected_revision: input.expectedRevision,
        actual_revision: existing.revision,
      });
    }
    const update = evaluationDatasetSchema.parse({
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? input.description === null ? { description: undefined } : { description: input.description }
        : {}),
      ...(input.domain !== undefined ? input.domain === null ? { domain: undefined } : { domain: input.domain } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.defaultWeight !== undefined ? { default_weight: input.defaultWeight } : {}),
      updated_by: options.operatorId,
    });
    const cases = await new EvaluationCaseRepository(this.db).list(datasetId, version, false);
    const datasetHash = hashEvaluationDataset(update, cases);
    const row = await this.db
      .updateTable('evaluation_dataset')
      .set({
        ...(input.name !== undefined ? { name: update.name } : {}),
        ...(input.description !== undefined ? { description: update.description ?? null } : {}),
        ...(input.domain !== undefined ? { domain: update.domain ?? null } : {}),
        ...(input.tags !== undefined ? { tags_json: toDbJson(update.tags) } : {}),
        ...(input.defaultWeight !== undefined ? { default_weight: update.default_weight } : {}),
        status: 'draft',
        dataset_hash: datasetHash,
        updated_by: options.operatorId,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('dataset_id', '=', datasetId)
      .where('version', '=', version)
      .where('status', 'in', ['draft', 'validated'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_MUTABLE', 'Evaluation dataset draft cannot be updated', {
        dataset_id: datasetId,
        version,
      });
    }
    return mapEvaluationDataset(row);
  }

  async clone(
    datasetId: string,
    version: number,
    input: { version?: number; datasetId?: string },
    options: EvaluationWriteOptions,
  ): Promise<EvaluationDataset> {
    return withTransaction(this.db, async (trx) => {
      const source = await new EvaluationDatasetRepository(trx).get(datasetId, version);
      if (!source) {
        throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_FOUND', 'Evaluation dataset not found', {
          dataset_id: datasetId,
          version,
        });
      }
      const targetDatasetId = input.datasetId ?? source.dataset_id;
      const targetVersion = input.version ?? ((await new EvaluationDatasetRepository(trx).listVersions(targetDatasetId))[0]?.version ?? 0) + 1;
      const draft = await new EvaluationDatasetRepository(trx).createDraft({
        ...source,
        dataset_id: targetDatasetId,
        version: targetVersion,
        status: 'draft',
        dataset_hash: undefined,
        published_by: undefined,
        published_at: undefined,
      }, options);
      const cases = await new EvaluationCaseRepository(trx).list(datasetId, version, false);
      for (const evaluationCase of cases) {
        await new EvaluationCaseRepository(trx).upsert({
          ...evaluationCase,
          dataset_id: targetDatasetId,
          dataset_version: targetVersion,
          case_id: `${targetDatasetId}_v${targetVersion}_${evaluationCase.case_id}`,
          created_at: undefined,
          updated_at: undefined,
        }, options);
      }
      const refreshed = await new EvaluationDatasetRepository(trx).refreshContentHash(targetDatasetId, targetVersion, options);
      return refreshed ?? draft;
    });
  }

  async validate(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    await this.assertPublishableContent(datasetId, version);
    await this.refreshContentHash(datasetId, version, options);
    return this.updateStatus(datasetId, version, 'validated', options);
  }

  async markValidated(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return this.validate(datasetId, version, options);
  }

  async publish(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    await this.assertPublishableContent(datasetId, version);
    await this.refreshContentHash(datasetId, version, options);
    return this.updateStatus(datasetId, version, 'published', options);
  }

  async deprecate(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return this.updateTerminalStatus(datasetId, version, 'deprecated', options);
  }

  async disable(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return this.updateTerminalStatus(datasetId, version, 'disabled', options);
  }

  async rollback(datasetId: string, targetVersion: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    const target = await this.get(datasetId, targetVersion);
    if (!target || (target.status !== 'published' && target.status !== 'deprecated')) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_ROLLBACK_TARGET_INVALID', 'Evaluation dataset rollback target must be a published or deprecated version', {
        dataset_id: datasetId,
        version: targetVersion,
      });
    }
    return this.updateTerminalStatus(datasetId, targetVersion, 'published', options);
  }

  async refreshContentHash(
    datasetId: string,
    version: number,
    options?: EvaluationWriteOptions,
  ): Promise<EvaluationDataset | undefined> {
    const dataset = await this.get(datasetId, version);
    if (!dataset) {
      return undefined;
    }
    const cases = await new EvaluationCaseRepository(this.db).list(datasetId, version, false);
    const datasetHash = hashEvaluationDataset(dataset, cases);
    if (dataset.status !== 'draft' && dataset.status !== 'validated') {
      if (dataset.dataset_hash === datasetHash) {
        return dataset;
      }
      throw new EvaluationRepositoryError('EVALUATION_DATASET_IMMUTABLE', 'Published evaluation dataset content hash cannot be rewritten', {
        dataset_id: datasetId,
        version,
        status: dataset.status,
      });
    }
    const row = await this.db
      .updateTable('evaluation_dataset')
      .set({
        status: 'draft',
        dataset_hash: datasetHash,
        ...(options ? { updated_by: options.operatorId } : {}),
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('dataset_id', '=', datasetId)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst();
    return row ? mapEvaluationDataset(row) : undefined;
  }

  async assertContentHash(datasetId: string, version: number, expectedHash: string): Promise<EvaluationDataset> {
    const dataset = await this.get(datasetId, version);
    if (!dataset) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_FOUND', 'Evaluation dataset not found', {
        dataset_id: datasetId,
        version,
      });
    }
    const cases = await new EvaluationCaseRepository(this.db).list(datasetId, version, false);
    const actualHash = hashEvaluationDataset(dataset, cases);
    if (actualHash !== expectedHash || dataset.dataset_hash !== expectedHash) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_HASH_MISMATCH', 'Evaluation dataset content hash mismatch', {
        dataset_id: datasetId,
        version,
        expected_hash: expectedHash,
        stored_hash: dataset.dataset_hash,
        actual_hash: actualHash,
      });
    }
    return dataset;
  }

  private async getMutableDataset(datasetId: string, version: number): Promise<EvaluationDataset> {
    const dataset = await this.get(datasetId, version);
    if (!dataset) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_FOUND', 'Evaluation dataset not found', {
        dataset_id: datasetId,
        version,
      });
    }
    if (dataset.status !== 'draft' && dataset.status !== 'validated') {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_IMMUTABLE', 'Only draft evaluation datasets can be modified', {
        dataset_id: datasetId,
        version,
        status: dataset.status,
      });
    }
    return dataset;
  }

  private async assertPublishableContent(datasetId: string, version: number): Promise<void> {
    const dataset = await this.get(datasetId, version);
    if (!dataset) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_FOUND', 'Evaluation dataset not found', {
        dataset_id: datasetId,
        version,
      });
    }
    if (dataset.status !== 'draft' && dataset.status !== 'validated') {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_PUBLISHABLE', 'Only draft or validated evaluation datasets can be validated or published', {
        dataset_id: datasetId,
        version,
        status: dataset.status,
      });
    }
    const cases = await new EvaluationCaseRepository(this.db).list(datasetId, version, false);
    if (!cases.some((evaluationCase) => evaluationCase.enabled)) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_EMPTY', 'Evaluation dataset requires at least one enabled case', {
        dataset_id: datasetId,
        version,
      });
    }
    for (const evaluationCase of cases) {
      evaluationCaseSchema.parse(evaluationCase);
    }
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

  private async updateTerminalStatus(
    datasetId: string,
    version: number,
    status: 'deprecated' | 'disabled' | 'published',
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
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_FOUND', 'Evaluation dataset not found', {
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

  async upsert(evaluationCase: EvaluationCase, options?: EvaluationWriteOptions): Promise<EvaluationCase> {
    const parsed = evaluationCaseSchema.parse(evaluationCase);
    await this.assertDatasetMutable(parsed.dataset_id, parsed.dataset_version);
    const row: Insertable<EvaluationCaseTable> = {
      case_id: parsed.case_id,
      dataset_id: parsed.dataset_id,
      dataset_version: parsed.dataset_version,
      name: parsed.name,
      description: parsed.description ?? null,
      input_json: toDbJson(parsed.input),
      context_refs_json: toDbJson(parsed.context_refs),
      expected_status: parsed.expected_status ?? null,
      expected_tool_calls_json: toDbJson(parsed.expected_tool_calls),
      forbidden_tools_json: toDbJson(parsed.forbidden_tools),
      final_assertions_json: toDbJson(parsed.final_assertions),
      policy_assertions_json: toDbJson(parsed.policy_assertions),
      latency_budget_ms: parsed.latency_budget_ms ?? null,
      input_token_budget: parsed.input_token_budget ?? null,
      output_token_budget: parsed.output_token_budget ?? null,
      total_token_budget: parsed.total_token_budget ?? null,
      cost_budget: parsed.cost_budget ?? null,
      minimum_case_score: parsed.minimum_case_score ?? null,
      weight: parsed.weight,
      tags_json: toDbJson(parsed.tags),
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
          minimum_case_score: row.minimum_case_score,
          weight: row.weight,
          tags_json: row.tags_json,
          enabled: row.enabled,
          updated_at: row.updated_at,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    const savedCase = mapEvaluationCase(saved);
    await new EvaluationDatasetRepository(this.db).refreshContentHash(
      parsed.dataset_id,
      parsed.dataset_version,
      options,
    );
    return savedCase;
  }

  async delete(caseId: string, options?: EvaluationWriteOptions): Promise<EvaluationCase> {
    const existing = await this.get(caseId);
    if (!existing) {
      throw new EvaluationRepositoryError('EVALUATION_CASE_NOT_FOUND', 'Evaluation case not found', { case_id: caseId });
    }
    await this.assertDatasetMutable(existing.dataset_id, existing.dataset_version);
    const row = await this.db
      .deleteFrom('evaluation_case')
      .where('case_id', '=', caseId)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new EvaluationRepositoryError('EVALUATION_CASE_NOT_FOUND', 'Evaluation case not found', { case_id: caseId });
    }
    await new EvaluationDatasetRepository(this.db).refreshContentHash(
      existing.dataset_id,
      existing.dataset_version,
      options,
    );
    return mapEvaluationCase(row);
  }

  private async assertDatasetMutable(datasetId: string, version: number): Promise<void> {
    const dataset = await new EvaluationDatasetRepository(this.db).get(datasetId, version);
    if (!dataset) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_FOUND', 'Evaluation dataset not found', {
        dataset_id: datasetId,
        version,
      });
    }
    if (dataset.status !== 'draft' && dataset.status !== 'validated') {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_IMMUTABLE', 'Only draft evaluation datasets can be modified', {
        dataset_id: datasetId,
        version,
        status: dataset.status,
      });
    }
  }
}

export class EvaluationDatasetService {
  constructor(private readonly db: Kysely<Database>) {}

  list(options: EvaluationDatasetListOptions = {}): Promise<EvaluationDataset[]> {
    return new EvaluationDatasetRepository(this.db).list(options);
  }

  get(datasetId: string, version: number): Promise<EvaluationDataset | undefined> {
    return new EvaluationDatasetRepository(this.db).get(datasetId, version);
  }

  listVersions(datasetId: string): Promise<EvaluationDataset[]> {
    return new EvaluationDatasetRepository(this.db).listVersions(datasetId);
  }

  async createDraft(dataset: EvaluationDataset, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationDatasetRepository(trx).createDraft(dataset, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.dataset.created',
        targetType: 'evaluation.dataset',
        targetId: `${saved.dataset_id}@${saved.version}`,
        result: 'succeeded',
        eventKey: `evaluation.dataset.created:${saved.dataset_id}:${saved.version}`,
        payload: {
          dataset_id: saved.dataset_id,
          version: saved.version,
          dataset_hash: saved.dataset_hash,
        },
      });
      return saved;
    });
  }

  async updateDraft(
    datasetId: string,
    version: number,
    input: EvaluationDatasetUpdateDraftInput,
    options: EvaluationWriteOptions,
  ): Promise<EvaluationDataset> {
    return new EvaluationDatasetRepository(this.db).updateDraft(datasetId, version, input, options);
  }

  clone(
    datasetId: string,
    version: number,
    input: { version?: number; datasetId?: string },
    options: EvaluationWriteOptions,
  ): Promise<EvaluationDataset> {
    return new EvaluationDatasetRepository(this.db).clone(datasetId, version, input, options);
  }

  async validate(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationDatasetRepository(trx).validate(datasetId, version, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.dataset.validated',
        targetType: 'evaluation.dataset',
        targetId: `${saved.dataset_id}@${saved.version}`,
        result: 'succeeded',
        eventKey: `evaluation.dataset.validated:${saved.dataset_id}:${saved.version}:${saved.dataset_hash}`,
        payload: {
          dataset_id: saved.dataset_id,
          version: saved.version,
          dataset_hash: saved.dataset_hash,
        },
      });
      return saved;
    });
  }

  async publish(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationDatasetRepository(trx).publish(datasetId, version, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.dataset.published',
        targetType: 'evaluation.dataset',
        targetId: `${saved.dataset_id}@${saved.version}`,
        result: 'succeeded',
        eventKey: `evaluation.dataset.published:${saved.dataset_id}:${saved.version}:${saved.dataset_hash}`,
        payload: {
          dataset_id: saved.dataset_id,
          version: saved.version,
          dataset_hash: saved.dataset_hash,
        },
      });
      return saved;
    });
  }

  deprecate(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return new EvaluationDatasetRepository(this.db).deprecate(datasetId, version, options);
  }

  disable(datasetId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return new EvaluationDatasetRepository(this.db).disable(datasetId, version, options);
  }

  async rollback(datasetId: string, targetVersion: number, options: EvaluationWriteOptions): Promise<EvaluationDataset> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationDatasetRepository(trx).rollback(datasetId, targetVersion, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.dataset.rolled_back',
        targetType: 'evaluation.dataset',
        targetId: `${saved.dataset_id}@${saved.version}`,
        result: 'succeeded',
        eventKey: `evaluation.dataset.rolled_back:${saved.dataset_id}:${saved.version}:${saved.dataset_hash}`,
        payload: {
          dataset_id: saved.dataset_id,
          version: saved.version,
          dataset_hash: saved.dataset_hash,
        },
      });
      return saved;
    });
  }
}

export class EvaluationCaseService {
  constructor(private readonly db: Kysely<Database>) {}

  list(datasetId: string, version: number, enabledOnly = false): Promise<EvaluationCase[]> {
    return new EvaluationCaseRepository(this.db).list(datasetId, version, enabledOnly);
  }

  get(caseId: string): Promise<EvaluationCase | undefined> {
    return new EvaluationCaseRepository(this.db).get(caseId);
  }

  async create(input: EvaluationCase, options: EvaluationWriteOptions): Promise<EvaluationCase> {
    return this.upsert(input, options);
  }

  async update(caseId: string, input: EvaluationCase, options: EvaluationWriteOptions): Promise<EvaluationCase> {
    if (caseId !== input.case_id) {
      throw new EvaluationRepositoryError('EVALUATION_CASE_ID_MISMATCH', 'Evaluation case route id does not match request body', {
        case_id: caseId,
        body_case_id: input.case_id,
      });
    }
    return this.upsert(input, options);
  }

  async delete(caseId: string, options: EvaluationWriteOptions): Promise<EvaluationCase> {
    return withTransaction(this.db, async (trx) => {
      const deleted = await new EvaluationCaseRepository(trx).delete(caseId, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.case.deleted',
        targetType: 'evaluation.case',
        targetId: deleted.case_id,
        result: 'succeeded',
        eventKey: `evaluation.case.deleted:${deleted.case_id}:${deleted.dataset_id}:${deleted.dataset_version}`,
        payload: {
          case_id: deleted.case_id,
          dataset_id: deleted.dataset_id,
          dataset_version: deleted.dataset_version,
        },
      });
      return deleted;
    });
  }

  private async upsert(input: EvaluationCase, options: EvaluationWriteOptions): Promise<EvaluationCase> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationCaseRepository(trx).upsert(input, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.case.upserted',
        targetType: 'evaluation.case',
        targetId: saved.case_id,
        result: 'succeeded',
        eventKey: `evaluation.case.upserted:${saved.case_id}:${saved.dataset_id}:${saved.dataset_version}`,
        payload: {
          case_id: saved.case_id,
          dataset_id: saved.dataset_id,
          dataset_version: saved.dataset_version,
          enabled: saved.enabled,
        },
      });
      return saved;
    });
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
      candidate_bundle_json: toDbJson(snapshot.candidate_bundle),
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
      plan_json: toDbJson(parsed),
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
      workflow_id: input.workflowId ?? null,
      workflow_run_id: input.workflowRunId ?? null,
      cancellation_requested_at: null,
      system_error_cases: 0,
      execution_started_at: null,
      evidence_collection_status: 'not_started',
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
    const existing = await this.get(runId);
    if (!existing) {
      throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'EvaluationRun not found', {
        evaluation_run_id: runId,
      });
    }
    if (existing.status === 'cancelling' || existing.status === 'cancelled') {
      return existing;
    }
    const row = await this.db
      .updateTable('evaluation_run')
      .set({
        status: 'running',
        started_at: new Date(),
        execution_started_at: new Date(),
        evidence_collection_status: 'partial',
        updated_at: new Date(),
      })
      .where('evaluation_run_id', '=', runId)
      .where('status', 'in', ['queued', 'running'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      const existing = await this.get(runId);
      if (!existing) {
        throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'EvaluationRun not found', {
          evaluation_run_id: runId,
        });
      }
      return existing;
    }
    return mapEvaluationRun(row);
  }

  async attachWorkflow(runId: string, workflowId: string, workflowRunId?: string): Promise<EvaluationRun> {
    const row = await this.db
      .updateTable('evaluation_run')
      .set({
        workflow_id: workflowId,
        workflow_run_id: workflowRunId ?? null,
        updated_at: new Date(),
      })
      .where('evaluation_run_id', '=', runId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapEvaluationRun(row);
  }

  async markCancellationRequested(runId: string): Promise<EvaluationRun> {
    const existing = await this.get(runId);
    if (!existing) {
      throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'EvaluationRun not found', {
        evaluation_run_id: runId,
      });
    }
    if (['completed', 'failed', 'cancelled'].includes(existing.status)) {
      return existing;
    }
    const row = await this.db
      .updateTable('evaluation_run')
      .set({
        status: 'cancelling',
        cancellation_requested_at: existing.cancellation_requested_at
          ? new Date(existing.cancellation_requested_at)
          : new Date(),
        updated_at: new Date(),
      })
      .where('evaluation_run_id', '=', runId)
      .where('status', 'in', ['queued', 'running', 'cancelling'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      const current = await this.get(runId);
      if (!current) {
        throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'EvaluationRun not found', {
          evaluation_run_id: runId,
        });
      }
      return current;
    }
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
        system_error_cases: Number(aggregate.metric_summary.system_error_cases ?? 0),
        aggregate_score: aggregate.weighted_score,
        evidence_collection_status: 'completed',
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('evaluation_run_id', '=', runId)
      .where('status', 'in', ['running', 'completed'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      const existing = await this.get(runId);
      if (!existing) {
        throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'EvaluationRun not found', {
          evaluation_run_id: runId,
        });
      }
      return existing;
    }
    return mapEvaluationRun(row);
  }

  async fail(runId: string, code: string, message: string): Promise<EvaluationRun> {
    const row = await this.db
      .updateTable('evaluation_run')
      .set({
        status: 'failed',
        error_code: code,
        error_message: message,
        evidence_collection_status: 'failed',
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('evaluation_run_id', '=', runId)
      .where('status', 'not in', ['completed', 'cancelled'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      const existing = await this.get(runId);
      if (!existing) {
        throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'EvaluationRun not found', {
          evaluation_run_id: runId,
        });
      }
      return existing;
    }
    return mapEvaluationRun(row);
  }

  async cancel(runId: string, aggregate?: EvaluationAggregateResult): Promise<EvaluationRun> {
    const existing = await this.get(runId);
    if (!existing) {
      throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'EvaluationRun not found', {
        evaluation_run_id: runId,
      });
    }
    if (existing.status === 'cancelled') {
      return existing;
    }
    const row = await this.db
      .updateTable('evaluation_run')
      .set({
        status: 'cancelled',
        ...(aggregate
          ? {
              completed_cases: aggregate.completed_cases,
              passed_cases: aggregate.passed_cases,
              failed_cases: aggregate.failed_cases,
              skipped_cases: aggregate.skipped_cases,
              system_error_cases: Number(aggregate.metric_summary.system_error_cases ?? 0),
              aggregate_score: aggregate.weighted_score,
              evidence_collection_status: 'completed',
            }
          : { evidence_collection_status: 'partial' }),
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('evaluation_run_id', '=', runId)
      .where('status', 'in', ['queued', 'running', 'cancelling'])
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      const current = await this.get(runId);
      return current ?? existing;
    }
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
      workflow_id: parsed.workflow_id ?? null,
      workflow_run_id: parsed.workflow_run_id ?? null,
      status: parsed.status,
      score: parsed.score ?? null,
      metric_results_json: toDbJson(parsed.metric_results),
      evidence_snapshot_json: parsed.evidence_snapshot ? toDbJson(parsed.evidence_snapshot) : null,
      evidence_hash: parsed.evidence_hash ?? null,
      candidate_fidelity_verified: parsed.candidate_fidelity_verified,
      assertion_failure_count: parsed.assertion_failure_count,
      hard_gate_failure_count: parsed.hard_gate_failure_count,
      system_error_class: parsed.system_error_class ?? null,
      actual_status: parsed.actual_status ?? null,
      task_run_id: parsed.task_run_id ?? null,
      agent_run_id: parsed.agent_run_id ?? null,
      model_call_ids_json: toDbJson(parsed.model_call_ids),
      tool_call_ids_json: toDbJson(parsed.tool_call_ids),
      final_output_ref: parsed.final_output_ref ?? null,
      safe_output_json: parsed.safe_output ? toDbJson(parsed.safe_output) : null,
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
          workflow_id: row.workflow_id,
          workflow_run_id: row.workflow_run_id,
          evidence_snapshot_json: row.evidence_snapshot_json,
          evidence_hash: row.evidence_hash,
          candidate_fidelity_verified: row.candidate_fidelity_verified,
          assertion_failure_count: row.assertion_failure_count,
          hard_gate_failure_count: row.hard_gate_failure_count,
          system_error_class: row.system_error_class,
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

export class EvaluationComparisonRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(comparison: EvaluationComparison, createdBy?: string): Promise<EvaluationComparison> {
    const parsed = evaluationComparisonSchema.parse(comparison);
    const row: Insertable<EvaluationComparisonTable> = {
      comparison_id: parsed.comparison_id,
      candidate_run_id: parsed.candidate_run_id,
      baseline_run_id: parsed.baseline_run_id,
      dataset_id: parsed.dataset_id ?? '',
      dataset_version: parsed.dataset_version ?? 1,
      dataset_hash: parsed.dataset_hash ?? '0'.repeat(64),
      comparable: parsed.comparable,
      result_json: toDbJson(parsed),
      created_by: createdBy ?? parsed.created_by ?? null,
      created_at: parsed.created_at ?? new Date(),
    };
    const saved = await this.db
      .insertInto('evaluation_comparison')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['candidate_run_id', 'baseline_run_id']).doUpdateSet({
          comparable: row.comparable,
          result_json: row.result_json,
          created_by: row.created_by,
          created_at: row.created_at,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapEvaluationComparison(saved);
  }

  async get(comparisonId: string): Promise<EvaluationComparison | undefined> {
    const row = await this.db
      .selectFrom('evaluation_comparison')
      .selectAll()
      .where('comparison_id', '=', comparisonId)
      .executeTakeFirst();
    return row ? mapEvaluationComparison(row) : undefined;
  }

  async findByRuns(candidateRunId: string, baselineRunId: string): Promise<EvaluationComparison | undefined> {
    const row = await this.db
      .selectFrom('evaluation_comparison')
      .selectAll()
      .where('candidate_run_id', '=', candidateRunId)
      .where('baseline_run_id', '=', baselineRunId)
      .executeTakeFirst();
    return row ? mapEvaluationComparison(row) : undefined;
  }

  async list(options: { limit?: number; offset?: number } = {}): Promise<EvaluationComparison[]> {
    const rows = await this.db
      .selectFrom('evaluation_comparison')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapEvaluationComparison);
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

  async listVersions(policyId: string): Promise<EvaluationGatePolicy[]> {
    const rows = await this.db
      .selectFrom('evaluation_gate_policy')
      .selectAll()
      .where('gate_policy_id', '=', policyId)
      .orderBy('version', 'desc')
      .execute();
    return rows.map(mapEvaluationGatePolicy);
  }

  async getLatestPublishedForResource(resourceType: EvaluationSubjectType): Promise<EvaluationGatePolicy | undefined> {
    const rows = await this.db
      .selectFrom('evaluation_gate_policy')
      .selectAll()
      .where('status', '=', 'published')
      .orderBy('published_at', 'desc')
      .orderBy('updated_at', 'desc')
      .orderBy('gate_policy_id', 'desc')
      .execute();
    return rows.map(mapEvaluationGatePolicy).find((policy) => policy.resource_types.includes(resourceType));
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
      resource_types_json: toDbJson(parsed.resource_types),
      required_dataset_refs_json: toDbJson(parsed.required_dataset_refs),
      thresholds_json: toDbJson(parsed.thresholds),
      regression_rules_json: toDbJson(parsed.regression_rules),
      required_case_tags_json: toDbJson(parsed.required_case_tags),
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
    await this.validateRequiredDatasetRefs(policyId, version);
    const policy = await this.get(policyId, version);
    if (!policy) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_FOUND', 'Evaluation gate policy not found', {
        gate_policy_id: policyId,
        version,
      });
    }
    const policyHash = hashEvaluationGatePolicy(policy);
    const row = await this.db
      .updateTable('evaluation_gate_policy')
      .set({
        status: 'published',
        gate_policy_hash: policyHash,
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

  async validate(policyId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    await this.validateRequiredDatasetRefs(policyId, version);
    const policy = await this.get(policyId, version);
    if (!policy) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_FOUND', 'Evaluation gate policy not found', {
        gate_policy_id: policyId,
        version,
      });
    }
    const policyHash = hashEvaluationGatePolicy(policy);
    const row = await this.db
      .updateTable('evaluation_gate_policy')
      .set({
        status: 'validated',
        gate_policy_hash: policyHash,
        updated_by: options.operatorId,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('gate_policy_id', '=', policyId)
      .where('version', '=', version)
      .where('status', '=', 'draft')
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_VALIDATABLE', 'Evaluation gate policy cannot be validated from current status', {
        gate_policy_id: policyId,
        version,
      });
    }
    return mapEvaluationGatePolicy(row);
  }

  async updateDraft(
    policyId: string,
    version: number,
    input: {
      policy: Partial<EvaluationGatePolicy>;
      expectedRevision?: number;
    },
    options: EvaluationWriteOptions,
  ): Promise<EvaluationGatePolicy> {
    const existing = await this.getMutablePolicy(policyId, version);
    if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_REVISION_CONFLICT', 'Evaluation gate policy revision conflict', {
        gate_policy_id: policyId,
        version,
        expected_revision: input.expectedRevision,
        actual_revision: existing.revision,
      });
    }
    const parsed = evaluationGatePolicySchema.parse({
      ...existing,
      ...input.policy,
      gate_policy_id: policyId,
      version,
      status: 'draft',
      updated_by: options.operatorId,
    });
    const policyHash = hashEvaluationGatePolicy(parsed);
    const row = await this.db
      .updateTable('evaluation_gate_policy')
      .set({
        resource_types_json: toDbJson(parsed.resource_types),
        required_dataset_refs_json: toDbJson(parsed.required_dataset_refs),
        thresholds_json: toDbJson(parsed.thresholds),
        regression_rules_json: toDbJson(parsed.regression_rules),
        required_case_tags_json: toDbJson(parsed.required_case_tags),
        allow_override: parsed.allow_override,
        status: 'draft',
        gate_policy_hash: policyHash,
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
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_MUTABLE', 'Only draft evaluation gate policies can be modified', {
        gate_policy_id: policyId,
        version,
      });
    }
    return mapEvaluationGatePolicy(row);
  }

  async clone(
    policyId: string,
    version: number,
    input: { version?: number; policyId?: string },
    options: EvaluationWriteOptions,
  ): Promise<EvaluationGatePolicy> {
    return withTransaction(this.db, async (trx) => {
      const repository = new EvaluationGatePolicyRepository(trx);
      const source = await repository.get(policyId, version);
      if (!source) {
        throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_FOUND', 'Evaluation gate policy not found', {
          gate_policy_id: policyId,
          version,
        });
      }
      const targetPolicyId = input.policyId ?? source.gate_policy_id;
      const latestVersion = (await repository.listVersions(targetPolicyId))[0]?.version ?? 0;
      const targetVersion = input.version ?? latestVersion + 1;
      return repository.createDraft({
        ...source,
        gate_policy_id: targetPolicyId,
        version: targetVersion,
        status: 'draft',
        gate_policy_hash: undefined,
        published_by: undefined,
        published_at: undefined,
      }, options);
    });
  }

  async deprecate(policyId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    return this.updateTerminalStatus(policyId, version, 'deprecated', options);
  }

  async disable(policyId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    return this.updateTerminalStatus(policyId, version, 'disabled', options);
  }

  async rollback(policyId: string, targetVersion: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    const target = await this.get(policyId, targetVersion);
    if (!target || (target.status !== 'published' && target.status !== 'deprecated')) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_ROLLBACK_TARGET_INVALID', 'Evaluation gate policy rollback target must be a published or deprecated version', {
        gate_policy_id: policyId,
        version: targetVersion,
      });
    }
    return this.updateTerminalStatus(policyId, targetVersion, 'published', options);
  }

  private async validateRequiredDatasetRefs(policyId: string, version: number): Promise<void> {
    const policy = await this.get(policyId, version);
    if (!policy) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_FOUND', 'Evaluation gate policy not found', {
        gate_policy_id: policyId,
        version,
      });
    }
    for (const datasetRef of policy.required_dataset_refs) {
      const dataset = await new EvaluationDatasetRepository(this.db).get(datasetRef.dataset_id, datasetRef.version);
      if (!dataset) {
        throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_DATASET_NOT_FOUND', 'Required evaluation dataset not found', {
          gate_policy_id: policyId,
          version,
          dataset_id: datasetRef.dataset_id,
          dataset_version: datasetRef.version,
        });
      }
      if (dataset.status !== 'published') {
        throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_DATASET_NOT_PUBLISHED', 'Required evaluation dataset must be published', {
          gate_policy_id: policyId,
          version,
          dataset_id: dataset.dataset_id,
          dataset_version: dataset.version,
          status: dataset.status,
        });
      }
      await new EvaluationDatasetRepository(this.db).assertContentHash(
        datasetRef.dataset_id,
        datasetRef.version,
        datasetRef.dataset_hash,
      );
    }
  }

  private async getMutablePolicy(policyId: string, version: number): Promise<EvaluationGatePolicy> {
    const policy = await this.get(policyId, version);
    if (!policy) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_FOUND', 'Evaluation gate policy not found', {
        gate_policy_id: policyId,
        version,
      });
    }
    if (policy.status !== 'draft' && policy.status !== 'validated') {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_IMMUTABLE', 'Only draft evaluation gate policies can be modified', {
        gate_policy_id: policyId,
        version,
        status: policy.status,
      });
    }
    return policy;
  }

  private async updateTerminalStatus(
    policyId: string,
    version: number,
    status: 'deprecated' | 'disabled' | 'published',
    options: EvaluationWriteOptions,
  ): Promise<EvaluationGatePolicy> {
    const row = await this.db
      .updateTable('evaluation_gate_policy')
      .set({
        status,
        updated_by: options.operatorId,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
        ...(status === 'published'
          ? { published_by: options.operatorId, published_at: new Date() }
          : {}),
      })
      .where('gate_policy_id', '=', policyId)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new EvaluationRepositoryError('EVALUATION_GATE_POLICY_NOT_FOUND', 'Evaluation gate policy not found', {
        gate_policy_id: policyId,
        version,
      });
    }
    return mapEvaluationGatePolicy(row);
  }
}

export class EvaluationGatePolicyService {
  constructor(private readonly db: Kysely<Database>) {}

  list(status?: EvaluationGatePolicy['status']): Promise<EvaluationGatePolicy[]> {
    return new EvaluationGatePolicyRepository(this.db).list(status);
  }

  get(policyId: string, version: number): Promise<EvaluationGatePolicy | undefined> {
    return new EvaluationGatePolicyRepository(this.db).get(policyId, version);
  }

  listVersions(policyId: string): Promise<EvaluationGatePolicy[]> {
    return new EvaluationGatePolicyRepository(this.db).listVersions(policyId);
  }

  async createDraft(policy: EvaluationGatePolicy, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationGatePolicyRepository(trx).createDraft(policy, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.gate_policy.created',
        targetType: 'evaluation.gate_policy',
        targetId: `${saved.gate_policy_id}@${saved.version}`,
        result: 'succeeded',
        eventKey: `evaluation.gate_policy.created:${saved.gate_policy_id}:${saved.version}`,
        payload: {
          gate_policy_id: saved.gate_policy_id,
          version: saved.version,
          gate_policy_hash: saved.gate_policy_hash,
        },
      });
      return saved;
    });
  }

  updateDraft(
    policyId: string,
    version: number,
    input: { policy: Partial<EvaluationGatePolicy>; expectedRevision?: number },
    options: EvaluationWriteOptions,
  ): Promise<EvaluationGatePolicy> {
    return new EvaluationGatePolicyRepository(this.db).updateDraft(policyId, version, input, options);
  }

  clone(
    policyId: string,
    version: number,
    input: { version?: number; policyId?: string },
    options: EvaluationWriteOptions,
  ): Promise<EvaluationGatePolicy> {
    return new EvaluationGatePolicyRepository(this.db).clone(policyId, version, input, options);
  }

  async validate(policyId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationGatePolicyRepository(trx).validate(policyId, version, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.gate_policy.validated',
        targetType: 'evaluation.gate_policy',
        targetId: `${saved.gate_policy_id}@${saved.version}`,
        result: 'succeeded',
        eventKey: `evaluation.gate_policy.validated:${saved.gate_policy_id}:${saved.version}:${saved.gate_policy_hash}`,
        payload: {
          gate_policy_id: saved.gate_policy_id,
          version: saved.version,
          gate_policy_hash: saved.gate_policy_hash,
        },
      });
      return saved;
    });
  }

  async publish(policyId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationGatePolicyRepository(trx).publish(policyId, version, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.gate_policy.published',
        targetType: 'evaluation.gate_policy',
        targetId: `${saved.gate_policy_id}@${saved.version}`,
        result: 'succeeded',
        eventKey: `evaluation.gate_policy.published:${saved.gate_policy_id}:${saved.version}:${saved.gate_policy_hash}`,
        payload: {
          gate_policy_id: saved.gate_policy_id,
          version: saved.version,
          gate_policy_hash: saved.gate_policy_hash,
        },
      });
      return saved;
    });
  }

  deprecate(policyId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    return new EvaluationGatePolicyRepository(this.db).deprecate(policyId, version, options);
  }

  disable(policyId: string, version: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    return new EvaluationGatePolicyRepository(this.db).disable(policyId, version, options);
  }

  async rollback(policyId: string, targetVersion: number, options: EvaluationWriteOptions): Promise<EvaluationGatePolicy> {
    return withTransaction(this.db, async (trx) => {
      const saved = await new EvaluationGatePolicyRepository(trx).rollback(policyId, targetVersion, options);
      await appendEvaluationAudit(trx, {
        tenantId: tenantOf(options),
        actorId: options.operatorId,
        action: 'evaluation.gate_policy.rolled_back',
        targetType: 'evaluation.gate_policy',
        targetId: `${saved.gate_policy_id}@${saved.version}`,
        result: 'succeeded',
        eventKey: `evaluation.gate_policy.rolled_back:${saved.gate_policy_id}:${saved.version}:${saved.gate_policy_hash}`,
        payload: {
          gate_policy_id: saved.gate_policy_id,
          version: saved.version,
          gate_policy_hash: saved.gate_policy_hash,
        },
      });
      return saved;
    });
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
      evaluation_run_ids_json: toDbJson(parsed.evaluation_run_ids),
      decision: parsed.decision,
      reasons_json: toDbJson(parsed.reasons),
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

  async listForResource(input: {
    resourceType?: EvaluationSubjectType;
    resourceId?: string;
    resourceVersion?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<EvaluationGateDecision[]> {
    let query = this.db.selectFrom('evaluation_gate_decision').selectAll();
    if (input.resourceType) {
      query = query.where('resource_type', '=', input.resourceType);
    }
    if (input.resourceId) {
      query = query.where('resource_id', '=', input.resourceId);
    }
    if (input.resourceVersion) {
      query = query.where('resource_version', '=', input.resourceVersion);
    }
    const rows = await query
      .orderBy('decided_at', 'desc')
      .limit(limit(input.limit))
      .offset(offset(input.offset))
      .execute();
    return rows.map(mapEvaluationGateDecision);
  }
}

export class EvaluationGateOverrideRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(override: EvaluationGateOverride): Promise<EvaluationGateOverride> {
    if (!override.expires_at) {
      throw new EvaluationGateError('EVALUATION_OVERRIDE_NOT_ALLOWED', 'Evaluation gate override expires_at is required');
    }
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
      expires_at: parsed.expires_at,
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
      .where('expires_at', '>', new Date())
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return row ? mapEvaluationGateOverride(row) : undefined;
  }
}

export class EvaluationGateFreshnessService {
  constructor(private readonly db: Kysely<Database>) {}

  async check(input: {
    decision: EvaluationGateDecision;
    currentResourceHash?: string;
    currentCandidateBundleHash?: string;
    currentDatasetHash?: string;
    currentGatePolicyHash?: string;
  }): Promise<EvaluationGateDecisionFreshness> {
    const reasons: EvaluationGateFreshnessReason[] = [];
    const decision = input.decision;
    if (input.currentResourceHash && input.currentResourceHash !== decision.resource_hash) {
      reasons.push('RESOURCE_HASH_CHANGED');
    }
    if (input.currentCandidateBundleHash && input.currentCandidateBundleHash !== decision.candidate_bundle_hash) {
      reasons.push('CANDIDATE_BUNDLE_CHANGED');
    }
    if (input.currentGatePolicyHash && input.currentGatePolicyHash !== decision.gate_policy_hash) {
      reasons.push('GATE_POLICY_HASH_CHANGED');
    }

    const policy = await new EvaluationGatePolicyRepository(this.db).get(
      decision.gate_policy_id,
      decision.gate_policy_version,
    );
    if (!policy || policy.gate_policy_hash !== decision.gate_policy_hash) {
      reasons.push('GATE_POLICY_HASH_CHANGED');
    }

    const runs = await Promise.all(
      decision.evaluation_run_ids.map((runId) => new EvaluationRunRepository(this.db).get(runId)),
    );
    if (runs.some((run) => !run)) {
      reasons.push('RUN_MISSING');
    }
    if (runs.some((run) => run && run.status !== 'completed')) {
      reasons.push('RUN_NOT_COMPLETED');
    }
    const firstRun = runs.find((run): run is EvaluationRun => Boolean(run));
    if (firstRun) {
      if (input.currentDatasetHash && firstRun.dataset_hash !== input.currentDatasetHash) {
        reasons.push('DATASET_HASH_CHANGED');
      }
      const policyDatasetHash = decisionDatasetHash(policy, firstRun.dataset_id, firstRun.dataset_version);
      if (policyDatasetHash && firstRun.dataset_hash !== policyDatasetHash) {
        reasons.push('DATASET_HASH_CHANGED');
      }
      if (input.currentDatasetHash && policyDatasetHash && input.currentDatasetHash !== policyDatasetHash) {
        reasons.push('DATASET_HASH_CHANGED');
      }
      const plan = await new EvaluationExecutionPlanRepository(this.db).getByRef(firstRun.evaluation_execution_plan_ref);
      if (!plan) {
        reasons.push('RUN_MISSING');
      } else {
        if (plan.candidate_bundle_hash !== decision.candidate_bundle_hash) {
          reasons.push('CANDIDATE_BUNDLE_CHANGED');
        }
        if (plan.dataset_hash !== firstRun.dataset_hash) {
          reasons.push('DATASET_HASH_CHANGED');
        }
      }
      const snapshot = await new EvaluationSubjectSnapshotRepository(this.db).getByRef(firstRun.subject_snapshot_ref);
      if (!snapshot) {
        reasons.push('DECISION_MISMATCH');
      } else if (
        snapshot.primary_subject_type !== decision.resource_type ||
        snapshot.primary_subject_id !== decision.resource_id ||
        snapshot.primary_subject_version !== decision.resource_version ||
        snapshot.primary_subject_hash !== decision.resource_hash ||
        snapshot.candidate_bundle_hash !== decision.candidate_bundle_hash
      ) {
        reasons.push('DECISION_MISMATCH');
      }
    }

    return {
      status: reasons.length > 0 ? 'stale' : 'fresh',
      reasons: [...new Set(reasons)],
      checked_at: new Date().toISOString(),
    };
  }
}

export class EvaluationSubjectSnapshotBuilder {
  constructor(private readonly db: Kysely<Database>) {}

  async build(input: EvaluationSubjectSnapshotBuildInput): Promise<EvaluationSubjectSnapshot> {
    const resolved = await new EvaluationCandidateResolver(this.db).resolve(input);
    const tenantPolicy = await new TenantRuntimePolicyResolver(this.db).resolve({
      tenant_id: input.tenantId,
      user_id: input.userId,
      execution_plan_ref: resolved.agentExecutionPlan.execution_plan_ref,
      execution_plan_hash: resolved.agentExecutionPlan.execution_plan_hash,
      execution_plan_type: 'agent',
      request_id: input.requestId,
      mode: 'required',
    });
    const bundleWithoutEvalPlan = evaluationCandidateBundleSchema.parse({
      primary_subject_type: input.primarySubjectType,
      primary_subject_id: input.primarySubjectId,
      primary_subject_version: input.primarySubjectVersion,
      primary_subject_hash: resolved.primarySubjectHash,
      agent_id: resolved.agentExecutionPlan.agent_id,
      agent_version: resolved.agentExecutionPlan.agent_version,
      agent_hash: resolved.agentExecutionPlan.agent_sha256,
      prompt_id: resolved.agentExecutionPlan.prompt_id,
      prompt_version: resolved.agentExecutionPlan.prompt_version,
      prompt_hash: resolved.agentExecutionPlan.prompt_sha256,
      model_policy_id: resolved.agentExecutionPlan.model_policy_id,
      model_policy_version: resolved.agentExecutionPlan.model_policy_version,
      model_policy_hash: resolved.agentExecutionPlan.model_policy_hash,
      agent_execution_plan_ref: resolved.agentExecutionPlan.execution_plan_ref,
      agent_execution_plan_hash: resolved.agentExecutionPlan.execution_plan_hash,
      tool_refs: resolved.agentExecutionPlan.allowed_tools.map((tool) => ({
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
      primary_subject_hash: resolved.primarySubjectHash,
      candidate_bundle: bundleWithoutEvalPlan,
      candidate_bundle_hash: candidateBundleHash,
      created_at: new Date().toISOString(),
    });
  }
}

export class EvaluationExecutionPlanBuilder {
  constructor(private readonly db: Kysely<Database>) {}

  async build(input: EvaluationExecutionPlanBuildInput): Promise<EvaluationExecutionPlan> {
    const datasetRepository = new EvaluationDatasetRepository(this.db);
    const dataset = await datasetRepository.get(input.datasetId, input.datasetVersion);
    if (!dataset) {
      throw new EvaluationRepositoryError('EVALUATION_DATASET_NOT_FOUND', `EvaluationDataset exact version not found: ${input.datasetId}@${input.datasetVersion}`);
    }
    const datasetHash = requiredHash(dataset.dataset_hash, 'EVALUATION_DATASET_HASH_REQUIRED');
    await datasetRepository.assertContentHash(dataset.dataset_id, dataset.version, datasetHash);
    const agentPlan = await new AgentExecutionPlanRepository(this.db).getByRef(
      input.subjectSnapshot.candidate_bundle.agent_execution_plan_ref,
      { tenantId: input.tenantId },
    );
    if (!agentPlan) {
      throw new EvaluationRepositoryError(
        'EVALUATION_AGENT_EXECUTION_PLAN_NOT_FOUND',
        `AgentExecutionPlan exact ref not found: ${input.subjectSnapshot.candidate_bundle.agent_execution_plan_ref}`,
      );
    }
    assertCandidateFidelity({
      subjectSnapshot: input.subjectSnapshot,
      agentExecutionPlan: agentPlan,
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
      agent_execution_plan_ref: agentPlan.execution_plan_ref,
      agent_execution_plan_hash: agentPlan.execution_plan_hash,
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

export interface ResolvedEvaluationCandidate {
  primarySubjectHash: string;
  agentExecutionPlan: AgentExecutionPlan;
}

interface CandidateRecords {
  agent: { spec: AgentSpec; sha256: string };
  prompt: { spec: PromptDefinition; sha256: string };
  modelPolicy: ModelPolicy;
  modelPolicyHash: string;
}

export class EvaluationCandidateResolver {
  constructor(private readonly db: Kysely<Database>) {}

  async resolve(input: EvaluationSubjectSnapshotBuildInput): Promise<ResolvedEvaluationCandidate> {
    const records = await this.loadRecords(input);
    const primaryHash = primarySubjectHash(input.primarySubjectType, input.primarySubjectId, input.primarySubjectVersion, {
      agentHash: records.agent.sha256,
      promptHash: records.prompt.sha256,
      modelPolicyHash: records.modelPolicyHash,
    });
    assertHashEquals(input.primarySubjectHash, primaryHash, 'EVALUATION_SUBJECT_HASH_MISMATCH', {
      subject_type: input.primarySubjectType,
      subject_id: input.primarySubjectId,
      subject_version: input.primarySubjectVersion,
    });

    const allowedTools = await this.resolveAllowedTools(records.agent.spec, input.tenantId);
    const resolvedModelPolicy = await resolveModelPolicyRecord(this.db, records.modelPolicy, records.modelPolicyHash, {
      // Publish-gate candidates must be able to evaluate an exact draft model policy
      // before the eventual release path marks it validated/published.
      allowValidated: input.primarySubjectType === 'model_policy',
      allowDraft: input.primarySubjectType === 'model_policy',
    });
    const plan = buildCandidateAgentExecutionPlan({
      tenantId: input.tenantId,
      agent: records.agent,
      prompt: records.prompt,
      modelPolicy: records.modelPolicy,
      modelPolicyHash: records.modelPolicyHash,
      resolvedModelPolicy,
      allowedTools,
    });
    const savedPlan = await new AgentExecutionPlanRepository(this.db).create(plan);
    return { primarySubjectHash: primaryHash, agentExecutionPlan: savedPlan };
  }

  private async loadRecords(input: EvaluationSubjectSnapshotBuildInput): Promise<CandidateRecords> {
    assertCandidateIdentity(input);
    const tenantOptions = { tenantId: input.tenantId };
    const agentRecord = await new AgentSpecRepository(this.db).getByIdAndVersion(
      input.primarySubjectType === 'agent' ? input.primarySubjectId : input.agentId,
      input.primarySubjectType === 'agent' ? input.primarySubjectVersion : input.agentVersion,
      tenantOptions,
    );
    if (!agentRecord) {
      throw new EvaluationRepositoryError('EVALUATION_AGENT_NOT_FOUND', `AgentSpec exact version not found: ${input.agentId}@${input.agentVersion}`);
    }
    const expectedAgentHash = input.primarySubjectType === 'agent' ? input.primarySubjectHash : requiredHash(input.agentHash, 'EVALUATION_AGENT_HASH_REQUIRED');
    assertHashEquals(expectedAgentHash, agentRecord.sha256, 'EVALUATION_AGENT_HASH_MISMATCH', {
      agent_id: agentRecord.spec.agent_id,
      agent_version: agentRecord.spec.version,
    });

    const agentPromptRef = parseExactVersionRef(agentRecord.spec.prompt_ref, 'AgentSpec.prompt_ref');
    const promptId = input.primarySubjectType === 'prompt' ? input.primarySubjectId : (input.promptId ?? agentPromptRef.id);
    const promptVersion = input.primarySubjectType === 'prompt' ? input.primarySubjectVersion : (input.promptVersion ?? agentPromptRef.version);
    const promptRecord = await new PromptDefinitionRepository(this.db).getByIdAndVersion(promptId, promptVersion, tenantOptions);
    if (!promptRecord) {
      throw new EvaluationRepositoryError('EVALUATION_PROMPT_NOT_FOUND', `Prompt exact version not found: ${promptId}@${promptVersion}`);
    }
    const expectedPromptHash = input.primarySubjectType === 'prompt' ? input.primarySubjectHash : (input.promptHash ?? promptRecord.sha256);
    assertHashEquals(expectedPromptHash, promptRecord.sha256, 'EVALUATION_PROMPT_HASH_MISMATCH', {
      prompt_id: promptRecord.spec.prompt_id,
      prompt_version: promptRecord.spec.version,
    });
    if (input.primarySubjectType !== 'prompt' && `${promptRecord.spec.prompt_id}@${promptRecord.spec.version}` !== agentRecord.spec.prompt_ref) {
      throw new EvaluationRepositoryError('EVALUATION_PROMPT_REF_MISMATCH', 'Context prompt does not match candidate agent prompt_ref', {
        agent_prompt_ref: agentRecord.spec.prompt_ref,
        prompt_id: promptRecord.spec.prompt_id,
        prompt_version: promptRecord.spec.version,
      });
    }

    const agentModelPolicyRef = modelPolicyRefSchema.parse(agentRecord.spec.model_policy_ref);
    const modelPolicyId = input.primarySubjectType === 'model_policy'
      ? input.primarySubjectId
      : (input.modelPolicyId ?? agentModelPolicyRef.model_policy_id);
    const modelPolicyVersion = input.primarySubjectType === 'model_policy'
      ? input.primarySubjectVersion
      : (input.modelPolicyVersion ?? agentModelPolicyRef.model_policy_version);
    const modelPolicy = await new ModelPolicyRepository(this.db).getByIdAndVersion(modelPolicyId, modelPolicyVersion, tenantOptions);
    if (!modelPolicy) {
      throw new EvaluationRepositoryError('EVALUATION_MODEL_POLICY_NOT_FOUND', `ModelPolicy exact version not found: ${modelPolicyId}@${modelPolicyVersion}`);
    }
    const modelPolicyHash = hashModelPolicy(modelPolicy);
    const expectedModelPolicyHash = input.primarySubjectType === 'model_policy'
      ? input.primarySubjectHash
      : (input.modelPolicyHash ?? agentModelPolicyRef.model_policy_hash);
    assertHashEquals(requiredHash(expectedModelPolicyHash, 'EVALUATION_MODEL_POLICY_HASH_REQUIRED'), modelPolicyHash, 'EVALUATION_MODEL_POLICY_HASH_MISMATCH', {
      model_policy_id: modelPolicy.model_policy_id,
      model_policy_version: modelPolicy.version,
    });
    if (input.primarySubjectType !== 'model_policy' && agentModelPolicyRef.model_policy_hash && agentModelPolicyRef.model_policy_hash !== modelPolicyHash) {
      throw new EvaluationRepositoryError('EVALUATION_MODEL_POLICY_REF_HASH_MISMATCH', 'Agent model_policy_ref hash does not match resolved ModelPolicy', {
        model_policy_id: agentModelPolicyRef.model_policy_id,
        model_policy_version: agentModelPolicyRef.model_policy_version,
      });
    }

    return {
      agent: { spec: agentRecord.spec, sha256: agentRecord.sha256 },
      prompt: { spec: promptRecord.spec, sha256: promptRecord.sha256 },
      modelPolicy,
      modelPolicyHash,
    };
  }

  private async resolveAllowedTools(agent: AgentSpec, tenantId: string): Promise<AgentExecutionPlan['allowed_tools']> {
    const repository = new ToolManifestRepository(this.db);
    const tools: AgentExecutionPlan['allowed_tools'] = [];
    for (const toolRefValue of agent.allowed_tools) {
      const toolRef = parseExactToolVersionRef(toolRefValue, 'AgentSpec.allowed_tools');
      const toolRecord = await repository.getByIdAndVersion(
        toolRef.name,
        toolRegistryVersionFromManifestVersion(toolRef.version),
        { tenantId },
      );
      if (!toolRecord) {
        throw new EvaluationRepositoryError('EVALUATION_TOOL_NOT_FOUND', `ToolManifest exact version not found: ${toolRef.name}@${toolRef.version}`);
      }
      if (toolRecord.spec.version !== toolRef.version) {
        throw new EvaluationRepositoryError('EVALUATION_TOOL_VERSION_MISMATCH', `ToolManifest version mismatch: ${toolRef.name}@${toolRef.version}`);
      }
      if (toolRecord.status !== 'published' && toolRecord.status !== 'gray') {
        throw new EvaluationRepositoryError('EVALUATION_TOOL_NOT_EXECUTABLE', `ToolManifest is not executable: ${toolRef.name}@${toolRef.version}`);
      }
      tools.push({
        tool_name: toolRecord.spec.tool_name,
        tool_version: toolRecord.spec.version,
        tool_sha256: toolRecord.sha256,
        ...(toolRecord.spec.description ? { description: toolRecord.spec.description } : {}),
        risk_level: toolRecord.spec.risk_level,
        input_schema: toolRecord.spec.input_schema ?? {},
      });
    }
    return tools;
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
    systemError?: boolean;
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
    const minimumCaseScore = input.evaluationCase.minimum_case_score;
    const belowMinimumCaseScore = minimumCaseScore !== undefined && score < minimumCaseScore;
    const requiredFailure = minimumCaseScore === undefined
      && metrics.some((metric) => !metric.hard_gate && !metric.passed);
    const systemError = input.systemError === true || input.actualStatus === 'system_error';
    const status: EvaluationCaseResult['status'] = systemError
      ? 'system_error'
      : hardFailure || requiredFailure || belowMinimumCaseScore
        ? 'failed'
        : 'passed';
    return evaluationCaseResultSchema.parse({
      evaluation_case_result_id: `eval_case_result_${randomUUID()}`,
      evaluation_run_id: 'pending',
      case_id: input.evaluationCase.case_id,
      status,
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
      } else if (result.status === 'failed') {
        failed += 1;
      } else if (result.status === 'system_error') {
        failed += 1;
      } else if (result.status === 'cancelled') {
        skipped += 1;
      }
      if (result.status === 'cancelled') {
        continue;
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
        system_error_cases: input.results.filter((result) => result.status === 'system_error').length,
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
      input.candidateRun.dataset_version !== input.baselineRun.dataset_version ||
      input.candidateRun.dataset_hash !== input.baselineRun.dataset_hash
    ) {
      return evaluationComparisonSchema.parse({
        comparison_id: `eval_cmp_${randomUUID()}`,
        candidate_run_id: input.candidateRun.evaluation_run_id,
        baseline_run_id: input.baselineRun.evaluation_run_id,
        comparable: false,
        dataset_id: input.candidateRun.dataset_id,
        dataset_version: input.candidateRun.dataset_version,
        dataset_hash: input.candidateRun.dataset_hash,
        regression_severity: 'not_comparable',
        reasons: ['Dataset id/version/hash mismatch'],
        result: {
          candidate_dataset: `${input.candidateRun.dataset_id}@${input.candidateRun.dataset_version}#${input.candidateRun.dataset_hash}`,
          baseline_dataset: `${input.baselineRun.dataset_id}@${input.baselineRun.dataset_version}#${input.baselineRun.dataset_hash}`,
        },
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
      dataset_hash: input.candidateRun.dataset_hash,
      overall_score_delta: (input.candidateRun.aggregate_score ?? 0) - (input.baselineRun.aggregate_score ?? 0),
      pass_rate_delta: passRate(input.candidateRun) - passRate(input.baselineRun),
      newly_failed_cases: newlyFailed,
      newly_passed_cases: newlyPassed,
      unchanged_failures: unchangedFailures,
      regression_severity: severity(newlyFailed.length, safetyRegression),
      reasons: safetyRegression ? ['Safety hard gate regression'] : [],
      result: {
        newly_failed_cases: newlyFailed,
        newly_passed_cases: newlyPassed,
        unchanged_failures: unchangedFailures,
      },
      created_at: new Date().toISOString(),
    });
  }
}

export class EvaluationEvidenceCollector {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: EvaluationEvidenceCollectorOptions = {},
  ) {}

  async collect(input: {
    tenantId: string;
    evaluationRunId: string;
    caseId: string;
    taskRunId?: string;
    agentRunId?: string;
    startedAtMs?: number;
  }): Promise<EvaluationEvidenceSnapshot> {
    const taskRun = input.taskRunId ? await new TaskRunRepository(this.db).get(input.taskRunId) : undefined;
    const agentRuns = input.agentRunId
      ? [await new AgentRunRepository(this.db).get(input.agentRunId, { tenantId: input.tenantId })].filter((run): run is NonNullable<typeof run> => Boolean(run))
      : input.taskRunId
        ? await new AgentRunRepository(this.db).list({ tenantId: input.tenantId, taskRunId: input.taskRunId, limit: 10 })
        : [];
    const agentRun = agentRuns[0];
    const agentSteps = agentRun
      ? await new AgentStepRepository(this.db).listByRun(agentRun.agent_run_id, { limit: 100 })
      : [];
    const toolCallsByEvaluation = await new ToolCallLogRepository(this.db).list({
      tenantId: input.tenantId,
      evaluationRunId: input.evaluationRunId,
      evaluationCaseId: input.caseId,
      limit: 100,
    });
    const toolCalls = toolCallsByEvaluation.length > 0 || !input.taskRunId
      ? toolCallsByEvaluation
      : await new ToolCallLogRepository(this.db).list({ tenantId: input.tenantId, taskRunId: input.taskRunId, limit: 100 });
    const modelCalls = input.taskRunId
      ? await new ModelCallLogRepository(this.db).list({
          tenantId: input.tenantId,
          taskRunId: input.taskRunId,
          ...(agentRun ? { agentRunId: agentRun.agent_run_id } : {}),
          limit: 100,
        })
      : [];
    const modelCallAttempts = (await Promise.all(
      modelCalls.map((call) => new ModelCallAttemptRepository(this.db).listByModelCall(call.model_call_id)),
    )).flat();
    const humanTasks = input.taskRunId
      ? await new HumanTaskRepository(this.db).list({
          tenantId: input.tenantId,
          taskRunId: input.taskRunId,
          limit: 100,
        })
      : [];
    const auditEvents = input.taskRunId
      ? await new AuditEventRepository(this.db).list({
          tenantId: input.tenantId,
          taskRunId: input.taskRunId,
          limit: 200,
        })
      : [];
    const idempotencyRecords = (await Promise.all(
      toolCalls
        .map((call) => call.idempotency_key)
        .filter((key): key is string => Boolean(key))
        .map((key) => new IdempotencyRecordRepository(this.db).get(key)),
    )).filter((record): record is NonNullable<typeof record> => Boolean(record));
    const idempotencyRecordIds = [...new Set(idempotencyRecords.map((record) => record.idempotency_key))];
    const duplicateToolCallCount = countDuplicates(toolCalls.map((call) => `${call.tool_name}:${call.input_hash ?? ''}`));
    const duplicateCommitCount = countDuplicates(
      toolCalls
        .filter((call) => call.status === 'committed')
        .map((call) => `${call.tool_name}:${call.idempotency_key ?? call.input_hash ?? ''}`),
    );
    const policyViolationCount = auditEvents.filter((event) =>
      event.result === 'denied' || String(event.reason ?? '').includes('POLICY'),
    ).length;
    const sideEffectWithoutApprovalCount = toolCalls.filter((call) =>
      call.risk_level === 'L3' &&
      call.status === 'committed' &&
      !humanTasks.some((task) => task.status === 'approved' && task.payload.tool_call_id === call.tool_call_id),
    ).length;
    const latencyMs = agentRun?.completed_at && agentRun.started_at
      ? Math.max(0, new Date(agentRun.completed_at).getTime() - new Date(agentRun.started_at).getTime())
      : input.startedAtMs
        ? Math.max(0, Date.now() - input.startedAtMs)
        : undefined;
    const finalOutput = selectSafeFinalOutput(agentSteps, modelCalls);
    const finalOutputRef = selectFinalOutputRef(agentSteps, modelCalls, finalOutput);
    const finalOutputTooLarge = finalOutput !== undefined && exceedsJsonBytes(finalOutput, this.options.outputMaxBytes);
    const toolOrder = toolCalls.map((call) => call.tool_name);
    const toolResultRefs = toolCalls.flatMap((call) => call.output_hash ? [`sha256:${call.output_hash}`] : []);
    const completenessReasons = [
      ...(taskRun ? [] : ['task_run_missing']),
      ...(taskRun && taskRun.tenant_id !== input.tenantId ? ['task_run_tenant_mismatch'] : []),
      ...(input.agentRunId && !agentRun ? ['agent_run_missing'] : []),
      ...(finalOutputTooLarge && !finalOutputRef ? ['final_output_size_limit_exceeded'] : []),
    ];
    const safeFinalOutput = finalOutputTooLarge ? undefined : finalOutput;
    const completenessStatus = completenessReasons.length > 0 ? 'incomplete' : 'complete';
    const evidence = {
      actual_status: agentRun?.status ?? taskRun?.status ?? 'system_error',
      ...(safeFinalOutput !== undefined ? { final_output_safe: safeFinalOutput } : {}),
      ...(finalOutputRef ? { final_output_ref: finalOutputRef } : {}),
      tool_calls: toolCalls.map((call) => ({
        tool_call_id: call.tool_call_id,
        tool_name: call.tool_name,
        tool_version: call.tool_version,
        status: call.status,
        policy_decision: call.policy_decision,
        ...(call.input_hash ? { arguments_hash: call.input_hash } : {}),
        ...(call.output_hash ? { result_ref: `sha256:${call.output_hash}` } : {}),
        ...(call.mode ? { mode: call.mode } : {}),
      })),
      tool_call_order: toolOrder,
      tool_order: toolOrder,
      tool_arguments: toolCalls.map((call) => ({ tool_name: call.tool_name, ...(call.input_hash ? { input_hash: call.input_hash } : {}) })),
      tool_results_refs: toolResultRefs,
      tool_result_refs: toolResultRefs,
      unauthorized_tool_count: auditEvents.filter((event) => event.reason === 'TOOL_DENIED_BY_TENANT_POLICY').length,
      forbidden_tool_count: 0,
      side_effect_without_approval_count: sideEffectWithoutApprovalCount,
      duplicate_tool_call_count: duplicateToolCallCount,
      duplicate_commit_count: duplicateCommitCount,
      policy_violation_count: policyViolationCount,
      cross_tenant_violation_count: taskRun && taskRun.tenant_id !== input.tenantId ? 1 : 0,
      secret_leak_count: auditEvents.some((event) => stableStringify(event.payload).match(/secret|token|password/iu)) ? 1 : 0,
      hidden_reasoning_leak_count: auditEvents.some((event) => stableStringify(event.payload).match(/chain.of.thought|hidden_reasoning/iu)) ? 1 : 0,
      model_call_count: modelCalls.length || agentRun?.model_call_count || 0,
      fallback_count: agentRun?.fallback_count ?? modelCalls.reduce((sum, call) => sum + call.fallback_index, 0),
      latency: latencyMs !== undefined ? { ms: latencyMs } : {},
      tokens: {
        ...(agentRun?.input_tokens ? { input: agentRun.input_tokens } : {}),
        ...(agentRun?.output_tokens ? { output: agentRun.output_tokens } : {}),
        ...(agentRun?.total_tokens ? { total: agentRun.total_tokens } : {}),
      },
      cost: agentRun?.estimated_cost !== undefined ? { estimated: agentRun.estimated_cost } : {},
      ...(agentRun?.status === 'failed' || taskRun?.status === 'failed' || completenessStatus === 'incomplete'
        ? { system_error: { code: evidenceErrorCode(agentRun?.error_code, finalOutputTooLarge, completenessStatus), class: 'evaluation_evidence_error' } }
        : {}),
      completeness_status: completenessStatus,
      completeness_reasons: completenessReasons,
      ...(completenessReasons.length > 0 ? { error_code: 'EVALUATION_EVIDENCE_INCOMPLETE' as const } : {}),
      refs: {
        ...(taskRun ? { task_run_id: taskRun.task_run_id } : {}),
        ...(agentRun ? { agent_run_id: agentRun.agent_run_id } : {}),
        agent_step_ids: agentSteps.map((step) => step.agent_step_id),
        model_call_ids: modelCalls.map((call) => call.model_call_id),
        model_call_attempt_ids: modelCallAttempts.map((attempt) => attempt.attempt_id),
        tool_call_ids: toolCalls.map((call) => call.tool_call_id),
        human_task_ids: humanTasks.map((task) => task.human_task_id),
        audit_event_ids: auditEvents.map((event) => event.event_id),
        idempotency_record_ids: idempotencyRecordIds,
      },
    } satisfies EvaluationEvidenceSnapshot;
    if (exceedsJsonBytes(evidence, this.options.evidenceMaxBytes)) {
      return {
        actual_status: 'system_error',
        ...(evidence.final_output_ref ? { final_output_ref: evidence.final_output_ref } : {}),
        tool_calls: evidence.tool_calls,
        tool_call_order: evidence.tool_call_order,
        tool_order: evidence.tool_order,
        tool_arguments: evidence.tool_arguments,
        tool_results_refs: evidence.tool_results_refs,
        tool_result_refs: evidence.tool_result_refs,
        unauthorized_tool_count: evidence.unauthorized_tool_count,
        forbidden_tool_count: evidence.forbidden_tool_count,
        side_effect_without_approval_count: evidence.side_effect_without_approval_count,
        duplicate_tool_call_count: evidence.duplicate_tool_call_count,
        duplicate_commit_count: evidence.duplicate_commit_count,
        policy_violation_count: evidence.policy_violation_count,
        cross_tenant_violation_count: evidence.cross_tenant_violation_count,
        secret_leak_count: evidence.secret_leak_count,
        hidden_reasoning_leak_count: evidence.hidden_reasoning_leak_count,
        model_call_count: evidence.model_call_count,
        fallback_count: evidence.fallback_count,
        latency: evidence.latency,
        tokens: evidence.tokens,
        cost: evidence.cost,
        system_error: {
          code: 'EVALUATION_EVIDENCE_SIZE_LIMIT_EXCEEDED',
          class: 'evaluation_evidence_error',
        },
        completeness_status: 'incomplete',
        completeness_reasons: [
          ...new Set([...evidence.completeness_reasons, 'evidence_size_limit_exceeded']),
        ],
        error_code: 'EVALUATION_EVIDENCE_INCOMPLETE',
        refs: evidence.refs,
      };
    }
    return evidence;
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
    const freshness = await new EvaluationGateFreshnessService(this.db).check({
      decision,
      currentResourceHash: input.resourceHash,
      currentCandidateBundleHash: input.candidateBundleHash,
      currentGatePolicyHash: requiredHash(policy.gate_policy_hash, 'EVALUATION_GATE_POLICY_HASH_REQUIRED'),
    });
    if (freshness.status !== 'fresh') {
      await appendEvaluationAudit(this.db, {
        tenantId: input.tenantId,
        actorId: input.operatorId,
        action: 'evaluation.gate.stale',
        targetType: `registry.${input.resourceType}`,
        targetId: `${input.resourceId}@${input.resourceVersion}`,
        result: 'denied',
        reason: freshness.reasons.join(','),
        eventKey: `evaluation.gate.stale:${decision.gate_decision_id}:${freshness.reasons.join('.')}`,
        payload: {
          gate_decision_id: decision.gate_decision_id,
          resource_hash: input.resourceHash,
          candidate_bundle_hash: input.candidateBundleHash,
          freshness,
        },
      });
      return this.blockOrWarn(input, 'EVALUATION_GATE_STALE', 'Evaluation gate decision is stale', decision);
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

export class EvaluationDatasetContentHasher {
  static hash(dataset: EvaluationDataset, cases: EvaluationCase[]): string {
    return hashJson({
      dataset: canonicalEvaluationDataset(dataset),
      cases: cases
        .map(canonicalEvaluationCase)
        .sort((left, right) => String(left.case_id).localeCompare(String(right.case_id))),
    });
  }
}

export function hashEvaluationDataset(dataset: EvaluationDataset, cases: EvaluationCase[] = []): string {
  return EvaluationDatasetContentHasher.hash(dataset, cases);
}

function canonicalEvaluationDataset(dataset: EvaluationDataset): Record<string, unknown> {
  return {
    dataset_id: dataset.dataset_id,
    version: dataset.version,
    name: dataset.name,
    ...(dataset.description !== undefined ? { description: dataset.description } : {}),
    ...(dataset.domain !== undefined ? { domain: dataset.domain } : {}),
    tags: [...dataset.tags].sort(),
    default_weight: dataset.default_weight,
  };
}

function canonicalEvaluationCase(evaluationCase: EvaluationCase): Record<string, unknown> {
  return {
    case_id: evaluationCase.case_id,
    dataset_id: evaluationCase.dataset_id,
    dataset_version: evaluationCase.dataset_version,
    name: evaluationCase.name,
    ...(evaluationCase.description !== undefined ? { description: evaluationCase.description } : {}),
    input: evaluationCase.input,
    context_refs: [...evaluationCase.context_refs].sort(),
    ...(evaluationCase.expected_status !== undefined ? { expected_status: evaluationCase.expected_status } : {}),
    expected_tool_calls: evaluationCase.expected_tool_calls,
    forbidden_tools: [...evaluationCase.forbidden_tools].sort(),
    final_assertions: evaluationCase.final_assertions,
    policy_assertions: evaluationCase.policy_assertions,
    ...(evaluationCase.latency_budget_ms !== undefined ? { latency_budget_ms: evaluationCase.latency_budget_ms } : {}),
    ...(evaluationCase.input_token_budget !== undefined ? { input_token_budget: evaluationCase.input_token_budget } : {}),
    ...(evaluationCase.output_token_budget !== undefined ? { output_token_budget: evaluationCase.output_token_budget } : {}),
    ...(evaluationCase.total_token_budget !== undefined ? { total_token_budget: evaluationCase.total_token_budget } : {}),
    ...(evaluationCase.cost_budget !== undefined ? { cost_budget: evaluationCase.cost_budget } : {}),
    ...(evaluationCase.minimum_case_score !== undefined ? { minimum_case_score: evaluationCase.minimum_case_score } : {}),
    weight: evaluationCase.weight,
    tags: [...evaluationCase.tags].sort(),
    enabled: evaluationCase.enabled,
  };
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
    tenantId: string;
  },
): Promise<EvaluationGateOverride> {
  if (!input.roles.includes('platform_admin')) {
    throw new EvaluationGateError('EVALUATION_OVERRIDE_NOT_ALLOWED', 'Only platform_admin can override evaluation gates');
  }
  if (!input.expiresAt) {
    throw new EvaluationGateError('EVALUATION_OVERRIDE_NOT_ALLOWED', 'Evaluation gate override expires_at is required');
  }
  if (new Date(input.expiresAt).getTime() <= Date.now()) {
    throw new EvaluationGateError('EVALUATION_OVERRIDE_EXPIRED', 'Evaluation gate override expiry must be in the future');
  }
  const expiresAt = input.expiresAt;
  return withTransaction(db, async (trx) => {
    const decision = await new EvaluationGateDecisionRepository(trx).get(input.decisionId);
    if (!decision) {
      throw new EvaluationGateError('EVALUATION_GATE_NOT_FOUND', 'Evaluation gate decision not found');
    }
    if (decision.resource_hash !== input.resourceHash) {
      throw new EvaluationGateError('EVALUATION_SUBJECT_HASH_MISMATCH', 'Override resource hash does not match gate decision');
    }
    const policy = await new EvaluationGatePolicyRepository(trx).get(decision.gate_policy_id, decision.gate_policy_version);
    if (!policy || policy.gate_policy_hash !== decision.gate_policy_hash) {
      throw new EvaluationGateError('EVALUATION_GATE_POLICY_MISMATCH', 'Evaluation gate policy does not match gate decision');
    }
    if (!policy.allow_override) {
      throw new EvaluationGateError('EVALUATION_OVERRIDE_NOT_ALLOWED', 'Evaluation gate policy does not allow override');
    }
    const freshness = await new EvaluationGateFreshnessService(trx).check({
      decision,
      currentResourceHash: input.resourceHash,
      currentCandidateBundleHash: decision.candidate_bundle_hash,
      currentGatePolicyHash: policy.gate_policy_hash,
    });
    if (freshness.status !== 'fresh') {
      throw new EvaluationGateError('EVALUATION_GATE_STALE', 'Cannot override a stale evaluation gate decision', {
        gate_decision_id: decision.gate_decision_id,
        freshness,
      });
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
      expires_at: expiresAt,
      created_at: new Date().toISOString(),
    });
    await appendEvaluationAudit(trx, {
      tenantId: input.tenantId,
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
    ...(row.minimum_case_score !== null ? { minimum_case_score: Number(row.minimum_case_score) } : {}),
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
    ...(row.workflow_id ? { workflow_id: row.workflow_id } : {}),
    ...(row.workflow_run_id ? { workflow_run_id: row.workflow_run_id } : {}),
    ...(row.cancellation_requested_at ? { cancellation_requested_at: toIso(row.cancellation_requested_at) } : {}),
    system_error_cases: row.system_error_cases,
    ...(row.execution_started_at ? { execution_started_at: toIso(row.execution_started_at) } : {}),
    evidence_collection_status: row.evidence_collection_status,
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
    ...(row.workflow_id ? { workflow_id: row.workflow_id } : {}),
    ...(row.workflow_run_id ? { workflow_run_id: row.workflow_run_id } : {}),
    status: row.status,
    ...(row.score !== null ? { score: Number(row.score) } : {}),
    metric_results: jsonArray(row.metric_results_json),
    ...(row.evidence_snapshot_json !== null ? { evidence_snapshot: jsonRecord(row.evidence_snapshot_json) ?? {} } : {}),
    ...(row.evidence_hash ? { evidence_hash: row.evidence_hash } : {}),
    candidate_fidelity_verified: row.candidate_fidelity_verified,
    assertion_failure_count: row.assertion_failure_count,
    hard_gate_failure_count: row.hard_gate_failure_count,
    ...(row.system_error_class ? { system_error_class: row.system_error_class } : {}),
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

function mapEvaluationComparison(row: Selectable<EvaluationComparisonTable>): EvaluationComparison {
  return evaluationComparisonSchema.parse({
    ...(jsonRecord(row.result_json) ?? {}),
    comparison_id: row.comparison_id,
    candidate_run_id: row.candidate_run_id,
    baseline_run_id: row.baseline_run_id,
    dataset_id: row.dataset_id,
    dataset_version: row.dataset_version,
    dataset_hash: row.dataset_hash,
    comparable: row.comparable,
    ...(row.created_by ? { created_by: row.created_by } : {}),
    created_at: toIso(row.created_at),
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
  if (!row.expires_at) {
    throw new EvaluationGateError('EVALUATION_OVERRIDE_NOT_ALLOWED', 'Evaluation gate override expires_at is required');
  }
  return evaluationGateOverrideSchema.parse({
    override_id: row.override_id,
    gate_decision_id: row.gate_decision_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    resource_version: row.resource_version,
    resource_hash: row.resource_hash,
    operator_id: row.operator_id,
    reason: row.reason,
    expires_at: toIso(row.expires_at),
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
    const withinExpectedCount = calls.length >= expected.min_calls && calls.length <= expected.max_calls;
    const score = withinExpectedCount && expected.max_calls > expected.min_calls
      ? calls.length / expected.max_calls
      : undefined;
    addMetric(metrics, 'tool_call_count_match', 'tool', calls.length >= expected.min_calls && calls.length <= expected.max_calls, {
      actual: calls.length,
      expected: { min: expected.min_calls, max: expected.max_calls },
      ...(score !== undefined ? { score } : {}),
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
  extra: { actual?: unknown; expected?: unknown; hardGate?: boolean; reason?: string; score?: number } = {},
): void {
  metrics.push(evaluationMetricResultSchema.parse({
    metric_name: metricName,
    metric_type: metricType,
    score: extra.score ?? (passed ? 1 : 0),
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

function selectSafeFinalOutput(
  agentSteps: AgentStepRecord[],
  modelCalls: ModelCallRecord[],
): unknown | undefined {
  const latestSucceededModelCall = [...modelCalls]
    .reverse()
    .find((call) => call.status === 'succeeded' && call.safe_response_json !== undefined);
  if (latestSucceededModelCall?.safe_response_json !== undefined) {
    return latestSucceededModelCall.safe_response_json;
  }
  const finalStep = [...agentSteps].reverse().find((step) => step.output_ref);
  if (finalStep?.output_ref) {
    return { output_ref: finalStep.output_ref };
  }
  return undefined;
}

function selectFinalOutputRef(
  agentSteps: AgentStepRecord[],
  modelCalls: ModelCallRecord[],
  finalOutput: unknown | undefined,
): string | undefined {
  const finalStep = [...agentSteps].reverse().find((step) => step.output_ref);
  if (finalStep?.output_ref) {
    return finalStep.output_ref;
  }
  const latestSucceededModelCall = [...modelCalls]
    .reverse()
    .find((call) => call.status === 'succeeded' && call.response_hash);
  if (latestSucceededModelCall?.response_hash) {
    return `sha256:${latestSucceededModelCall.response_hash}`;
  }
  return finalOutput === undefined ? undefined : `sha256:${hashJson(finalOutput)}`;
}

function evidenceErrorCode(
  agentErrorCode: string | undefined,
  finalOutputTooLarge: boolean,
  completenessStatus: EvaluationEvidenceSnapshot['completeness_status'],
): string {
  if (finalOutputTooLarge) {
    return 'EVALUATION_EVIDENCE_SIZE_LIMIT_EXCEEDED';
  }
  if (agentErrorCode) {
    return agentErrorCode;
  }
  return completenessStatus === 'incomplete'
    ? 'EVALUATION_EVIDENCE_INCOMPLETE'
    : 'EVALUATION_CASE_SYSTEM_ERROR';
}

function exceedsJsonBytes(value: unknown, maxBytes: number | undefined): boolean {
  return maxBytes !== undefined && Buffer.byteLength(stableStringify(value), 'utf8') > maxBytes;
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
  const thresholds = evaluationGateThresholdsSchema.parse(policy.thresholds);
  const reasons: string[] = [];
  const minimumPassRate = thresholds.minimum_pass_rate;
  const minimumWeightedScore = thresholds.minimum_weighted_score;
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

function tenantOf(options: EvaluationWriteOptions): string {
  return options.tenantId ?? 'default';
}

function decisionDatasetHash(
  policy: EvaluationGatePolicy | undefined,
  datasetId: string,
  datasetVersion: number,
): string | undefined {
  return policy?.required_dataset_refs.find((ref) =>
    ref.dataset_id === datasetId && ref.version === datasetVersion,
  )?.dataset_hash;
}

function countDuplicates(values: string[]): number {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values.filter(Boolean)) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }
  return duplicates.size;
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

export function buildCandidateAgentExecutionPlan(input: {
  tenantId: string;
  agent: { spec: AgentSpec; sha256: string };
  prompt: { spec: PromptDefinition; sha256: string };
  modelPolicy: ModelPolicy;
  modelPolicyHash: string;
  resolvedModelPolicy?: ResolvedModelPolicy;
  allowedTools?: AgentExecutionPlan['allowed_tools'];
  generatedAt?: string;
}): AgentExecutionPlan {
  const resolvedModelPolicy = input.resolvedModelPolicy ?? resolveEvaluationModelPolicy(input.modelPolicy, input.modelPolicyHash);
  if (input.agent.spec.allowed_tools.length > 0 && !input.allowedTools) {
    throw new EvaluationRepositoryError(
      'EVALUATION_TOOL_RESOLUTION_REQUIRED',
      'Tool manifest resolution requires explicit allowedTools or DB-backed EvaluationCandidateResolver',
    );
  }
  return buildCandidateAgentExecutionPlanFromResolvedTools({
    ...input,
    resolvedModelPolicy,
    allowedTools: input.allowedTools ?? [],
  });
}

function buildCandidateAgentExecutionPlanFromResolvedTools(input: {
  tenantId: string;
  agent: { spec: AgentSpec; sha256: string };
  prompt: { spec: PromptDefinition; sha256: string };
  modelPolicy: ModelPolicy;
  modelPolicyHash: string;
  resolvedModelPolicy: ResolvedModelPolicy;
  allowedTools: AgentExecutionPlan['allowed_tools'];
  generatedAt?: string;
}): AgentExecutionPlan {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const executionPlanId = `agent_plan_${randomUUID()}`;
  const executionPlanRef = `db://agent-execution-plan/${encodeURIComponent(executionPlanId)}`;
  const budget = agentBudgetSchema.parse({
    max_segments: input.agent.spec.max_steps,
    max_model_turns: input.agent.spec.max_steps,
    max_tool_calls: input.agent.spec.allowed_tools.length,
    max_total_tokens: input.agent.spec.max_tokens,
  });
  const outputSchema = parseAgentOutputSchema(input.agent.spec.output_schema);
  const plan: ResolvedAgentPlan = resolvedAgentPlanSchema.parse({
    agent_id: input.agent.spec.agent_id,
    agent_version: input.agent.spec.version,
    agent_sha256: input.agent.sha256,
    prompt_id: input.prompt.spec.prompt_id,
    prompt_version: input.prompt.spec.version,
    prompt_sha256: input.prompt.sha256,
    system_prompt: input.prompt.spec.content,
    model_policy: input.agent.spec.model_policy,
    model_policy_id: input.resolvedModelPolicy.model_policy_id,
    model_policy_version: input.resolvedModelPolicy.model_policy_version,
    model_policy_hash: input.resolvedModelPolicy.model_policy_hash,
    resolved_model_policy: input.resolvedModelPolicy,
    allowed_tools: input.allowedTools,
    allowed_handoffs: input.agent.spec.allowed_handoffs,
    ...(outputSchema ? { output_schema: outputSchema } : {}),
    budget,
  });
  const planWithoutHash = {
    execution_plan_id: executionPlanId,
    execution_plan_ref: executionPlanRef,
    tenant_id: input.tenantId,
    agent_id: input.agent.spec.agent_id,
    agent_version: input.agent.spec.version,
    agent_sha256: input.agent.sha256,
    prompt_id: input.prompt.spec.prompt_id,
    prompt_version: input.prompt.spec.version,
    prompt_sha256: input.prompt.sha256,
    model_policy: input.agent.spec.model_policy,
    model_policy_id: input.resolvedModelPolicy.model_policy_id,
    model_policy_version: input.resolvedModelPolicy.model_policy_version,
    model_policy_hash: input.resolvedModelPolicy.model_policy_hash,
    resolved_model_policy: input.resolvedModelPolicy,
    allowed_tools: input.allowedTools,
    allowed_handoffs: input.agent.spec.allowed_handoffs,
    ...(outputSchema ? { output_schema: outputSchema } : {}),
    budget,
    plan,
    generated_at: generatedAt,
  };
  return agentExecutionPlanSchema.parse({
    ...planWithoutHash,
    execution_plan_hash: hashJson(planWithoutHash),
  });
}

function resolveEvaluationModelPolicy(policy: ModelPolicy, modelPolicyHash: string): ResolvedModelPolicy {
  const resolvedTargets = policy.targets
    .filter((target) => target.enabled)
    .sort((left, right) => left.priority === right.priority
      ? left.target_id.localeCompare(right.target_id)
      : left.priority - right.priority);
  if (resolvedTargets.length === 0) {
    throw new EvaluationRepositoryError(
      'EVALUATION_MODEL_POLICY_NO_TARGETS',
      `ModelPolicy has no enabled targets: ${policy.model_policy_id}@${policy.version}`,
    );
  }
  return resolvedModelPolicySchema.parse({
    model_policy_id: policy.model_policy_id,
    model_policy_version: policy.version,
    model_policy_hash: modelPolicyHash,
    protocol: policy.protocol,
    resolved_targets: resolvedTargets,
    retry_policy: policy.retry_policy,
    fallback_policy: policy.fallback_policy,
    request_policy: policy.request_policy,
  });
}

export function assertCandidateFidelity(input: {
  subjectSnapshot: EvaluationSubjectSnapshot;
  agentExecutionPlan: AgentExecutionPlan;
}): void {
  const bundle = input.subjectSnapshot.candidate_bundle;
  const plan = input.agentExecutionPlan;
  const mismatches: string[] = [];
  if (input.subjectSnapshot.primary_subject_hash !== bundle.primary_subject_hash) {
    mismatches.push('subject_snapshot.primary_subject_hash');
  }
  if (hashEvaluationCandidateBundle(bundle) !== input.subjectSnapshot.candidate_bundle_hash) {
    mismatches.push('candidate_bundle_hash');
  }
  if (bundle.agent_execution_plan_ref !== plan.execution_plan_ref) {
    mismatches.push('agent_execution_plan_ref');
  }
  if (bundle.agent_execution_plan_hash !== plan.execution_plan_hash) {
    mismatches.push('agent_execution_plan_hash');
  }
  if (bundle.agent_hash !== plan.agent_sha256 || bundle.agent_hash !== plan.plan.agent_sha256) {
    mismatches.push('agent_hash');
  }
  if (bundle.prompt_hash !== plan.prompt_sha256 || bundle.prompt_hash !== plan.plan.prompt_sha256) {
    mismatches.push('prompt_hash');
  }
  if (bundle.model_policy_hash !== plan.model_policy_hash || bundle.model_policy_hash !== plan.plan.model_policy_hash) {
    mismatches.push('model_policy_hash');
  }
  const primaryHash = primarySubjectHash(bundle.primary_subject_type, bundle.primary_subject_id, bundle.primary_subject_version, {
    agentHash: plan.agent_sha256,
    promptHash: plan.prompt_sha256,
    modelPolicyHash: plan.model_policy_hash,
  });
  if (primaryHash !== bundle.primary_subject_hash || primaryHash !== input.subjectSnapshot.primary_subject_hash) {
    mismatches.push('primary_subject_hash');
  }
  if (mismatches.length > 0) {
    throw new EvaluationRepositoryError(
      'EVALUATION_CANDIDATE_FIDELITY_MISMATCH',
      `Evaluation candidate fidelity mismatch: ${mismatches.join(', ')}`,
      { mismatches },
    );
  }
}

function assertCandidateIdentity(input: EvaluationSubjectSnapshotBuildInput): void {
  if (input.primarySubjectId !== subjectIdForInput(input) || input.primarySubjectVersion !== subjectVersionForInput(input)) {
    throw new EvaluationRepositoryError('EVALUATION_SUBJECT_IDENTITY_MISMATCH', 'Primary subject identity must match the selected candidate resource', {
      primary_subject_type: input.primarySubjectType,
      primary_subject_id: input.primarySubjectId,
      primary_subject_version: input.primarySubjectVersion,
    });
  }
}

function subjectIdForInput(input: EvaluationSubjectSnapshotBuildInput): string {
  if (input.primarySubjectType === 'agent') {
    return input.agentId;
  }
  if (input.primarySubjectType === 'prompt') {
    return requiredString(input.promptId ?? input.primarySubjectId, 'EVALUATION_PROMPT_ID_REQUIRED');
  }
  return requiredString(input.modelPolicyId ?? input.primarySubjectId, 'EVALUATION_MODEL_POLICY_ID_REQUIRED');
}

function subjectVersionForInput(input: EvaluationSubjectSnapshotBuildInput): number {
  if (input.primarySubjectType === 'agent') {
    return input.agentVersion;
  }
  if (input.primarySubjectType === 'prompt') {
    return input.promptVersion ?? input.primarySubjectVersion;
  }
  return input.modelPolicyVersion ?? input.primarySubjectVersion;
}

function parseExactVersionRef(ref: string, label: string): { id: string; version: number } {
  const match = /^(.+)@([1-9]\d*)$/u.exec(ref);
  if (!match) {
    throw new EvaluationRepositoryError('EVALUATION_EXACT_REF_REQUIRED', `${label} must use id@version exact ref`, { ref });
  }
  return { id: match[1] ?? '', version: Number(match[2]) };
}

function parseExactToolVersionRef(ref: string, label: string): { name: string; version: string } {
  const match = /^(.+)@([^@]+)$/u.exec(ref);
  if (!match) {
    throw new EvaluationRepositoryError('EVALUATION_EXACT_REF_REQUIRED', `${label} must use tool_name@tool_version exact ref`, { ref });
  }
  return { name: match[1] ?? '', version: match[2] ?? '' };
}

function toolRegistryVersionFromManifestVersion(toolVersion: string): number {
  const [major] = toolVersion.split('.');
  const parsed = Number(major);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new EvaluationRepositoryError(
      'EVALUATION_TOOL_VERSION_INVALID',
      `ToolManifest version must start with a positive numeric major: ${toolVersion}`,
    );
  }
  return parsed;
}

function assertHashEquals(expected: string, actual: string, code: string, details: Record<string, unknown>): void {
  if (expected !== actual) {
    throw new EvaluationRepositoryError(code, 'Evaluation candidate hash mismatch', {
      ...details,
      expected_hash: expected,
      actual_hash: actual,
    });
  }
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
  const parsed = parseDbJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseDbJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

function toDbJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseDbJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
