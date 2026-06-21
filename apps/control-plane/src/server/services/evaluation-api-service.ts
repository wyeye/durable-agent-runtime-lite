import { z } from 'zod';
import {
  evaluationCaseSchema,
  evaluationComparisonRequestSchema,
  evaluationDatasetQuerySchema,
  evaluationDatasetSchema,
  evaluationGatePolicyCreateRequestSchema,
  evaluationGatePolicySchema,
  evaluationOverrideRequestSchema,
  type EvaluationCase,
  type EvaluationComparison,
  type EvaluationDataset,
  type EvaluationGateDecision,
  type EvaluationGateDecisionWithFreshness,
  type EvaluationGateOverride,
  type EvaluationGatePolicy,
  type PaginatedResponse,
} from '@dar/contracts';
import {
  createEvaluationOverride,
  EvaluationCaseResultRepository,
  EvaluationCaseService,
  EvaluationComparisonRepository,
  EvaluationComparisonService,
  EvaluationDatasetService,
  EvaluationGateDecisionRepository,
  EvaluationGateFreshnessService,
  EvaluationGatePolicyService,
  EvaluationRepositoryError,
  EvaluationRunRepository,
  type Database,
} from '@dar/db';
import type { Kysely } from 'kysely';
import { ControlPlaneHttpError } from '../utils/http.js';
import type { ActorOptions } from './registry-api-service.js';

const updateDatasetRequestSchema = z.object({
  dataset: evaluationDatasetSchema.partial().omit({
    dataset_id: true,
    version: true,
    revision: true,
    dataset_hash: true,
    created_at: true,
    updated_at: true,
    published_at: true,
  }),
  expected_revision: z.number().int().positive().optional(),
});

const updateCaseRequestSchema = z.object({
  case: evaluationCaseSchema,
});

const createCaseRequestSchema = updateCaseRequestSchema;

const updateGatePolicyRequestSchema = z.object({
  policy: evaluationGatePolicySchema.pick({
    resource_types: true,
    required_dataset_refs: true,
    thresholds: true,
    regression_rules: true,
    required_case_tags: true,
    allow_override: true,
  }).partial(),
  expected_revision: z.number().int().positive().optional(),
});

const cloneVersionSchema = z.object({
  version: z.number().int().positive().optional(),
});

const rollbackSchema = z.object({
  target_version: z.number().int().positive(),
});

const gateDecisionQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
  resource_type: z.enum(['prompt', 'agent', 'model_policy']).optional(),
  resource_id: z.string().min(1).optional(),
  resource_version: z.coerce.number().int().positive().optional(),
  current_resource_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  current_candidate_bundle_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  current_dataset_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  current_gate_policy_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});

const gatePolicyQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
  status: z.enum(['draft', 'validated', 'published', 'deprecated', 'disabled']).optional(),
});

export interface EvaluationApi {
  listDatasets(input: unknown): Promise<PaginatedResponse<EvaluationDataset>>;
  getDataset(datasetId: string, version: number): Promise<EvaluationDataset>;
  listDatasetVersions(datasetId: string): Promise<EvaluationDataset[]>;
  createDataset(input: unknown, actor: ActorOptions): Promise<EvaluationDataset>;
  updateDataset(datasetId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationDataset>;
  cloneDataset(datasetId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationDataset>;
  validateDataset(datasetId: string, version: number, actor: ActorOptions): Promise<EvaluationDataset>;
  publishDataset(datasetId: string, version: number, actor: ActorOptions): Promise<EvaluationDataset>;
  rollbackDataset(datasetId: string, input: unknown, actor: ActorOptions): Promise<EvaluationDataset>;
  listCases(datasetId: string, version: number): Promise<EvaluationCase[]>;
  getCase(caseId: string): Promise<EvaluationCase>;
  createCase(datasetId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationCase>;
  updateCase(caseId: string, input: unknown, actor: ActorOptions): Promise<EvaluationCase>;
  deleteCase(caseId: string, actor: ActorOptions): Promise<EvaluationCase>;
  listGatePolicies(input: unknown): Promise<PaginatedResponse<EvaluationGatePolicy>>;
  getGatePolicy(policyId: string, version: number): Promise<EvaluationGatePolicy>;
  listGatePolicyVersions(policyId: string): Promise<EvaluationGatePolicy[]>;
  createGatePolicy(input: unknown, actor: ActorOptions): Promise<EvaluationGatePolicy>;
  updateGatePolicy(policyId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationGatePolicy>;
  cloneGatePolicy(policyId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationGatePolicy>;
  validateGatePolicy(policyId: string, version: number, actor: ActorOptions): Promise<EvaluationGatePolicy>;
  publishGatePolicy(policyId: string, version: number, actor: ActorOptions): Promise<EvaluationGatePolicy>;
  listGateDecisions(input: unknown): Promise<PaginatedResponse<EvaluationGateDecisionWithFreshness>>;
  getGateDecision(decisionId: string): Promise<EvaluationGateDecisionWithFreshness>;
  createOverride(decisionId: string, input: unknown, actor: ActorOptions & { roles: string[] }): Promise<EvaluationGateOverride>;
  createComparison(input: unknown, actor: ActorOptions): Promise<EvaluationComparison>;
  getComparison(comparisonId: string): Promise<EvaluationComparison>;
}

export class EvaluationApiService implements EvaluationApi {
  constructor(private readonly db: Kysely<Database>) {}

  async listDatasets(input: unknown): Promise<PaginatedResponse<EvaluationDataset>> {
    const query = evaluationDatasetQuerySchema.parse(input ?? {});
    const items = await new EvaluationDatasetService(this.db).list({
      ...(query.dataset_id ? { datasetId: query.dataset_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.tag ? { tag: query.tag } : {}),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    return { items, page: query.page, page_size: query.page_size };
  }

  async getDataset(datasetId: string, version: number): Promise<EvaluationDataset> {
    return found(await new EvaluationDatasetService(this.db).get(datasetId, version), 'EVALUATION_DATASET_NOT_FOUND');
  }

  listDatasetVersions(datasetId: string): Promise<EvaluationDataset[]> {
    return new EvaluationDatasetService(this.db).listVersions(datasetId);
  }

  createDataset(input: unknown, actor: ActorOptions): Promise<EvaluationDataset> {
    return new EvaluationDatasetService(this.db).createDraft(evaluationDatasetSchema.parse(input), writeOptions(actor));
  }

  async updateDataset(datasetId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationDataset> {
    const body = updateDatasetRequestSchema.parse(input);
    return new EvaluationDatasetService(this.db).updateDraft(datasetId, version, {
      ...(body.dataset.name !== undefined ? { name: body.dataset.name } : {}),
      ...(body.dataset.description !== undefined ? { description: body.dataset.description ?? null } : {}),
      ...(body.dataset.domain !== undefined ? { domain: body.dataset.domain ?? null } : {}),
      ...(body.dataset.tags !== undefined ? { tags: body.dataset.tags } : {}),
      ...(body.dataset.default_weight !== undefined ? { defaultWeight: body.dataset.default_weight } : {}),
      ...(body.expected_revision !== undefined ? { expectedRevision: body.expected_revision } : {}),
    }, writeOptions(actor));
  }

  cloneDataset(datasetId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationDataset> {
    return new EvaluationDatasetService(this.db).clone(datasetId, version, cloneInput(input), writeOptions(actor));
  }

  validateDataset(datasetId: string, version: number, actor: ActorOptions): Promise<EvaluationDataset> {
    return new EvaluationDatasetService(this.db).validate(datasetId, version, writeOptions(actor));
  }

  publishDataset(datasetId: string, version: number, actor: ActorOptions): Promise<EvaluationDataset> {
    return new EvaluationDatasetService(this.db).publish(datasetId, version, writeOptions(actor));
  }

  rollbackDataset(datasetId: string, input: unknown, actor: ActorOptions): Promise<EvaluationDataset> {
    const body = rollbackSchema.parse(input);
    return new EvaluationDatasetService(this.db).rollback(datasetId, body.target_version, writeOptions(actor));
  }

  listCases(datasetId: string, version: number): Promise<EvaluationCase[]> {
    return new EvaluationCaseService(this.db).list(datasetId, version, false);
  }

  async getCase(caseId: string): Promise<EvaluationCase> {
    return found(await new EvaluationCaseService(this.db).get(caseId), 'EVALUATION_CASE_NOT_FOUND');
  }

  createCase(datasetId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationCase> {
    const body = createCaseRequestSchema.parse(input);
    if (body.case.dataset_id !== datasetId || body.case.dataset_version !== version) {
      throw new EvaluationRepositoryError('EVALUATION_CASE_DATASET_MISMATCH', 'Evaluation case must match route dataset exact version');
    }
    return new EvaluationCaseService(this.db).create(body.case, writeOptions(actor));
  }

  updateCase(caseId: string, input: unknown, actor: ActorOptions): Promise<EvaluationCase> {
    const body = updateCaseRequestSchema.parse(input);
    return new EvaluationCaseService(this.db).update(caseId, body.case, writeOptions(actor));
  }

  deleteCase(caseId: string, actor: ActorOptions): Promise<EvaluationCase> {
    return new EvaluationCaseService(this.db).delete(caseId, writeOptions(actor));
  }

  async listGatePolicies(input: unknown): Promise<PaginatedResponse<EvaluationGatePolicy>> {
    const query = gatePolicyQuerySchema.parse(input ?? {});
    const all = await new EvaluationGatePolicyService(this.db).list(query.status);
    const offset = (query.page - 1) * query.page_size;
    return {
      items: all.slice(offset, offset + query.page_size),
      page: query.page,
      page_size: query.page_size,
      total: all.length,
    };
  }

  async getGatePolicy(policyId: string, version: number): Promise<EvaluationGatePolicy> {
    return found(await new EvaluationGatePolicyService(this.db).get(policyId, version), 'EVALUATION_GATE_POLICY_NOT_FOUND');
  }

  listGatePolicyVersions(policyId: string): Promise<EvaluationGatePolicy[]> {
    return new EvaluationGatePolicyService(this.db).listVersions(policyId);
  }

  createGatePolicy(input: unknown, actor: ActorOptions): Promise<EvaluationGatePolicy> {
    const body = evaluationGatePolicyCreateRequestSchema.parse(input);
    return new EvaluationGatePolicyService(this.db).createDraft(
      evaluationGatePolicySchema.parse(body.policy),
      writeOptions(actor),
    );
  }

  updateGatePolicy(policyId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationGatePolicy> {
    const body = updateGatePolicyRequestSchema.parse(input);
    return new EvaluationGatePolicyService(this.db).updateDraft(policyId, version, {
      policy: gatePolicyPatch(body.policy),
      ...(body.expected_revision !== undefined ? { expectedRevision: body.expected_revision } : {}),
    }, writeOptions(actor));
  }

  cloneGatePolicy(policyId: string, version: number, input: unknown, actor: ActorOptions): Promise<EvaluationGatePolicy> {
    return new EvaluationGatePolicyService(this.db).clone(policyId, version, cloneInput(input), writeOptions(actor));
  }

  validateGatePolicy(policyId: string, version: number, actor: ActorOptions): Promise<EvaluationGatePolicy> {
    return new EvaluationGatePolicyService(this.db).validate(policyId, version, writeOptions(actor));
  }

  publishGatePolicy(policyId: string, version: number, actor: ActorOptions): Promise<EvaluationGatePolicy> {
    return new EvaluationGatePolicyService(this.db).publish(policyId, version, writeOptions(actor));
  }

  async listGateDecisions(input: unknown): Promise<PaginatedResponse<EvaluationGateDecisionWithFreshness>> {
    const query = gateDecisionQuerySchema.parse(input ?? {});
    const decisions = await new EvaluationGateDecisionRepository(this.db).listForResource({
      ...(query.resource_type ? { resourceType: query.resource_type } : {}),
      ...(query.resource_id ? { resourceId: query.resource_id } : {}),
      ...(query.resource_version ? { resourceVersion: query.resource_version } : {}),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    const items = await Promise.all(decisions.map((decision) => this.withFreshness(decision, {
      ...(query.current_resource_hash ? { currentResourceHash: query.current_resource_hash } : {}),
      ...(query.current_candidate_bundle_hash ? { currentCandidateBundleHash: query.current_candidate_bundle_hash } : {}),
      ...(query.current_dataset_hash ? { currentDatasetHash: query.current_dataset_hash } : {}),
      ...(query.current_gate_policy_hash ? { currentGatePolicyHash: query.current_gate_policy_hash } : {}),
    })));
    return { items, page: query.page, page_size: query.page_size };
  }

  async getGateDecision(decisionId: string): Promise<EvaluationGateDecisionWithFreshness> {
    const decision = await new EvaluationGateDecisionRepository(this.db).get(decisionId);
    return this.withFreshness(found(decision, 'EVALUATION_GATE_DECISION_NOT_FOUND'));
  }

  createOverride(decisionId: string, input: unknown, actor: ActorOptions & { roles: string[] }): Promise<EvaluationGateOverride> {
    const body = evaluationOverrideRequestSchema.parse({ ...asRecord(input), gate_decision_id: decisionId });
    return createEvaluationOverride(this.db, {
      decisionId: body.gate_decision_id,
      resourceHash: body.resource_hash,
      operatorId: actor.operatorId,
      tenantId: actor.tenantId,
      reason: body.reason,
      ...(body.expires_at ? { expiresAt: body.expires_at } : {}),
      roles: actor.roles,
    });
  }

  async createComparison(input: unknown, actor: ActorOptions): Promise<EvaluationComparison> {
    const body = evaluationComparisonRequestSchema.parse(input);
    const runs = new EvaluationRunRepository(this.db);
    const candidateRun = await runs.get(body.candidate_run_id);
    const baselineRun = await runs.get(body.baseline_run_id);
    if (!candidateRun || !baselineRun) {
      throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'Candidate and baseline runs are required for comparison');
    }
    if (candidateRun.tenant_id !== actor.tenantId || baselineRun.tenant_id !== actor.tenantId) {
      throw new EvaluationRepositoryError('EVALUATION_RUN_NOT_FOUND', 'Candidate and baseline runs are required for comparison');
    }
    if (candidateRun.status !== 'completed' || baselineRun.status !== 'completed') {
      throw new EvaluationRepositoryError('EVALUATION_COMPARISON_RUN_NOT_COMPLETED', 'Candidate and baseline runs must be completed');
    }
    const results = new EvaluationCaseResultRepository(this.db);
    const comparison = new EvaluationComparisonService().compare({
      candidateRun,
      candidateResults: await results.listByRun(candidateRun.evaluation_run_id),
      baselineRun,
      baselineResults: await results.listByRun(baselineRun.evaluation_run_id),
    });
    return new EvaluationComparisonRepository(this.db).create(comparison, actor.operatorId);
  }

  async getComparison(comparisonId: string): Promise<EvaluationComparison> {
    return found(await new EvaluationComparisonRepository(this.db).get(comparisonId), 'EVALUATION_COMPARISON_NOT_FOUND');
  }

  private async withFreshness(
    decision: EvaluationGateDecision,
    current: {
      currentResourceHash?: string;
      currentCandidateBundleHash?: string;
      currentDatasetHash?: string;
      currentGatePolicyHash?: string;
    } = {},
  ): Promise<EvaluationGateDecisionWithFreshness> {
    return {
      decision,
      freshness: await new EvaluationGateFreshnessService(this.db).check({ decision, ...current }),
    };
  }
}

function writeOptions(actor: ActorOptions) {
  return {
    tenantId: actor.tenantId,
    operatorId: actor.operatorId,
  };
}

function cloneInput(input: unknown): { version?: number } {
  const body = cloneVersionSchema.parse(input ?? {});
  return body.version !== undefined ? { version: body.version } : {};
}

function gatePolicyPatch(input: z.infer<typeof updateGatePolicyRequestSchema>['policy']): Partial<EvaluationGatePolicy> {
  const patch: Partial<EvaluationGatePolicy> = {};
  if (input.resource_types !== undefined) {
    patch.resource_types = input.resource_types;
  }
  if (input.required_dataset_refs !== undefined) {
    patch.required_dataset_refs = input.required_dataset_refs;
  }
  if (input.thresholds !== undefined) {
    patch.thresholds = input.thresholds;
  }
  if (input.regression_rules !== undefined) {
    patch.regression_rules = input.regression_rules;
  }
  if (input.required_case_tags !== undefined) {
    patch.required_case_tags = input.required_case_tags;
  }
  if (input.allow_override !== undefined) {
    patch.allow_override = input.allow_override;
  }
  return patch;
}

function found<T>(value: T | undefined, code: string): T {
  if (!value) {
    throw new ControlPlaneHttpError(404, code, code);
  }
  return value;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
