import type {
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationComparison,
  EvaluationComparisonRequest,
  EvaluationDataset,
  EvaluationDatasetStatus,
  EvaluationGateDecisionWithFreshness,
  EvaluationGateOverride,
  EvaluationGatePolicy,
  EvaluationGatePolicyCreateRequest,
  EvaluationGateDecisionStatus,
  EvaluationOverrideRequest,
  EvaluationRun,
  EvaluationRunCreateRequest,
  EvaluationRunStatus,
  EvaluationSubjectType,
  PaginatedResponse,
} from '@dar/contracts';
import type { ApiClient } from './client.js';

export type EvaluationTriggerType = EvaluationRunCreateRequest['trigger_type'];

export interface PageParams {
  page?: number;
  page_size?: number;
}

export interface EvaluationRequestOptions {
  signal?: AbortSignal;
}

export interface DatasetListParams extends PageParams {
  dataset_id?: string;
  status?: EvaluationDatasetStatus;
  tag?: string;
  keyword?: string;
}

export interface RunListParams extends PageParams {
  dataset_id?: string;
  status?: EvaluationRunStatus;
  trigger_type?: EvaluationTriggerType;
  resource_id?: string;
  subject?: string;
}

export interface GatePolicyListParams extends PageParams {
  status?: EvaluationDatasetStatus;
}

export interface GateDecisionListParams extends PageParams {
  resource_type?: EvaluationSubjectType;
  resource_id?: string;
  resource_version?: number;
  decision?: EvaluationGateDecisionStatus;
  current_resource_hash?: string;
  current_candidate_bundle_hash?: string;
  current_dataset_hash?: string;
  current_gate_policy_hash?: string;
}

export interface UpdateDatasetInput {
  dataset: Partial<Omit<EvaluationDataset, 'dataset_id' | 'version' | 'revision' | 'dataset_hash'>>;
  expected_revision?: number;
}

export interface UpdateGatePolicyInput {
  policy: Partial<Pick<
    EvaluationGatePolicy,
    'resource_types' | 'required_dataset_refs' | 'thresholds' | 'regression_rules' | 'required_case_tags' | 'allow_override'
  >>;
  expected_revision?: number;
}

export interface CloneInput {
  version?: number;
}

export interface RollbackInput {
  target_version: number;
}

export function listDatasets(
  client: ApiClient,
  params: DatasetListParams,
  options: EvaluationRequestOptions = {},
): Promise<PaginatedResponse<EvaluationDataset>> {
  return client.request('/api/v1/evaluation-datasets', { query: compactParams(params), signal: options.signal });
}

export function createDataset(
  client: ApiClient,
  dataset: EvaluationDataset,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationDataset> {
  return client.request('/api/v1/evaluation-datasets', { method: 'POST', body: dataset, signal: options.signal });
}

export function listDatasetVersions(
  client: ApiClient,
  datasetId: string,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationDataset[]> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions`, { signal: options.signal });
}

export function getDataset(
  client: ApiClient,
  datasetId: string,
  version: number,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationDataset> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/${version}`, { signal: options.signal });
}

export function updateDataset(
  client: ApiClient,
  datasetId: string,
  version: number,
  input: UpdateDatasetInput,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationDataset> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/${version}`, {
    method: 'PUT',
    body: input,
    signal: options.signal,
  });
}

export function cloneDataset(
  client: ApiClient,
  datasetId: string,
  version: number,
  input: CloneInput = {},
  options: EvaluationRequestOptions = {},
): Promise<EvaluationDataset> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/${version}/clone`, {
    method: 'POST',
    body: input,
    signal: options.signal,
  });
}

export function validateDataset(
  client: ApiClient,
  datasetId: string,
  version: number,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationDataset> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/${version}/validate`, {
    method: 'POST',
    body: {},
    signal: options.signal,
  });
}

export function publishDataset(
  client: ApiClient,
  datasetId: string,
  version: number,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationDataset> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/${version}/publish`, {
    method: 'POST',
    body: {},
    signal: options.signal,
  });
}

export function rollbackDataset(
  client: ApiClient,
  datasetId: string,
  input: RollbackInput,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationDataset> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/rollback`, {
    method: 'POST',
    body: input,
    signal: options.signal,
  });
}

export function listCases(
  client: ApiClient,
  datasetId: string,
  version: number,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationCase[]> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/${version}/cases`, {
    signal: options.signal,
  });
}

export function createCase(
  client: ApiClient,
  datasetId: string,
  version: number,
  evaluationCase: EvaluationCase,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationCase> {
  return client.request(`/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/${version}/cases`, {
    method: 'POST',
    body: evaluationCase,
    signal: options.signal,
  });
}

export function getCase(client: ApiClient, caseId: string, options: EvaluationRequestOptions = {}): Promise<EvaluationCase> {
  return client.request(`/api/v1/evaluation-cases/${encodeURIComponent(caseId)}`, { signal: options.signal });
}

export function updateCase(
  client: ApiClient,
  caseId: string,
  evaluationCase: EvaluationCase,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationCase> {
  return client.request(`/api/v1/evaluation-cases/${encodeURIComponent(caseId)}`, {
    method: 'PUT',
    body: evaluationCase,
    signal: options.signal,
  });
}

export function deleteCase(client: ApiClient, caseId: string, options: EvaluationRequestOptions = {}): Promise<EvaluationCase> {
  return client.request(`/api/v1/evaluation-cases/${encodeURIComponent(caseId)}`, {
    method: 'DELETE',
    signal: options.signal,
  });
}

export function listRuns(
  client: ApiClient,
  params: RunListParams,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationRun[]> {
  const query = compactParams({
    ...params,
    resource_id: params.resource_id ?? params.subject,
  });
  return client.request('/api/v1/evaluation-runs', { query, signal: options.signal });
}

export function createRun(
  client: ApiClient,
  input: EvaluationRunCreateRequest,
  options: EvaluationRequestOptions = {},
): Promise<{ evaluation_run: EvaluationRun; workflow_start: Record<string, unknown> }> {
  return client.request('/api/v1/evaluation-runs', { method: 'POST', body: input, signal: options.signal });
}

export function getRun(client: ApiClient, runId: string, options: EvaluationRequestOptions = {}): Promise<EvaluationRun> {
  return client.request(`/api/v1/evaluation-runs/${encodeURIComponent(runId)}`, { signal: options.signal });
}

export function listRunResults(
  client: ApiClient,
  runId: string,
  options: EvaluationRequestOptions = {},
): Promise<{ evaluation_run_id: string; results: EvaluationCaseResult[] }> {
  return client.request(`/api/v1/evaluation-runs/${encodeURIComponent(runId)}/results`, { signal: options.signal });
}

export function cancelRun(
  client: ApiClient,
  runId: string,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationRun> {
  return client.request(`/api/v1/evaluation-runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    body: {},
    signal: options.signal,
  });
}

export function createComparison(
  client: ApiClient,
  input: EvaluationComparisonRequest,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationComparison> {
  return client.request('/api/v1/evaluation-comparisons', { method: 'POST', body: input, signal: options.signal });
}

export function getComparison(
  client: ApiClient,
  comparisonId: string,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationComparison> {
  return client.request(`/api/v1/evaluation-comparisons/${encodeURIComponent(comparisonId)}`, { signal: options.signal });
}

export function listGatePolicies(
  client: ApiClient,
  params: GatePolicyListParams,
  options: EvaluationRequestOptions = {},
): Promise<PaginatedResponse<EvaluationGatePolicy>> {
  return client.request('/api/v1/evaluation-gate-policies', { query: compactParams(params), signal: options.signal });
}

export function createGatePolicy(
  client: ApiClient,
  input: EvaluationGatePolicyCreateRequest,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGatePolicy> {
  return client.request('/api/v1/evaluation-gate-policies', { method: 'POST', body: input, signal: options.signal });
}

export function listGatePolicyVersions(
  client: ApiClient,
  gatePolicyId: string,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGatePolicy[]> {
  return client.request(`/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions`, {
    signal: options.signal,
  });
}

export function getGatePolicy(
  client: ApiClient,
  gatePolicyId: string,
  version: number,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGatePolicy> {
  return client.request(`/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/${version}`, {
    signal: options.signal,
  });
}

export function updateGatePolicy(
  client: ApiClient,
  gatePolicyId: string,
  version: number,
  input: UpdateGatePolicyInput,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGatePolicy> {
  return client.request(`/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/${version}`, {
    method: 'PUT',
    body: input,
    signal: options.signal,
  });
}

export function cloneGatePolicy(
  client: ApiClient,
  gatePolicyId: string,
  version: number,
  input: CloneInput = {},
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGatePolicy> {
  return client.request(`/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/${version}/clone`, {
    method: 'POST',
    body: input,
    signal: options.signal,
  });
}

export function validateGatePolicy(
  client: ApiClient,
  gatePolicyId: string,
  version: number,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGatePolicy> {
  return client.request(`/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/${version}/validate`, {
    method: 'POST',
    body: {},
    signal: options.signal,
  });
}

export function publishGatePolicy(
  client: ApiClient,
  gatePolicyId: string,
  version: number,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGatePolicy> {
  return client.request(`/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/${version}/publish`, {
    method: 'POST',
    body: {},
    signal: options.signal,
  });
}

export function listGateDecisions(
  client: ApiClient,
  params: GateDecisionListParams,
  options: EvaluationRequestOptions = {},
): Promise<PaginatedResponse<EvaluationGateDecisionWithFreshness>> {
  return client.request('/api/v1/evaluation-gate-decisions', { query: compactParams(params), signal: options.signal });
}

export function getGateDecision(
  client: ApiClient,
  decisionId: string,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGateDecisionWithFreshness> {
  return client.request(`/api/v1/evaluation-gate-decisions/${encodeURIComponent(decisionId)}`, { signal: options.signal });
}

export function createOverride(
  client: ApiClient,
  decisionId: string,
  input: Omit<EvaluationOverrideRequest, 'gate_decision_id'>,
  options: EvaluationRequestOptions = {},
): Promise<EvaluationGateOverride> {
  return client.request(`/api/v1/evaluation-gate-decisions/${encodeURIComponent(decisionId)}/override`, {
    method: 'POST',
    body: input,
    signal: options.signal,
  });
}

function compactParams(params: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}
