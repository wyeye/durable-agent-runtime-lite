import { Kysely, PostgresDialect, Transaction, type ColumnType, type Generated, sql } from 'kysely';
import { Pool } from 'pg';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, unknown, unknown>;

export interface VersionedSpecTable {
  id: Generated<number>;
  tenant_id: string;
  spec_id: string;
  version: number;
  status: string;
  spec_json: Json;
  sha256: string;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
  revision: number;
  gray_policy_json: Json;
}

export type ToolManifestTable = VersionedSpecTable;

export type AgentSpecTable = VersionedSpecTable;

export type PromptDefinitionTable = VersionedSpecTable;

export interface FlowDefinitionTable extends Omit<VersionedSpecTable, 'spec_id'> {
  flow_id: string;
}

export interface FlowRouteConfigTable {
  id: Generated<number>;
  tenant_id: string;
  route_id: string;
  flow_id: string;
  flow_version: number;
  status: string;
  route_spec_json: Json;
  priority: number;
  sha256: string;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
  revision: number;
  gray_policy_json: Json;
}

export interface FlowRouteEmbeddingTable {
  id: Generated<number>;
  tenant_id: string;
  route_id: string;
  flow_id: string;
  flow_version: number;
  route_config_sha256: string;
  source_type: string;
  source_index: number;
  source_text: string;
  source_text_hash: string;
  embedding: unknown | null;
  embedding_model_id: string;
  embedding_model_version: number;
  embedding_model_hash: string;
  embedding_dimensions: number;
  embedding_hash: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskRunTable {
  task_run_id: string;
  tenant_id: string;
  user_id: string;
  route_type: string;
  conversation_id: string | null;
  user_message_id: string | null;
  assistant_message_id: string | null;
  flow_id: string | null;
  flow_version: number | null;
  workflow_id: string | null;
  execution_plan_ref: string | null;
  tenant_policy_snapshot_ref: string | null;
  tenant_policy_hash: string | null;
  tenant_admission_id: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  input_json: Json;
  route_result_json: Json | null;
  workflow_start_json: Json | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ConversationTable {
  conversation_id: string;
  tenant_id: string;
  owner_user_id: string;
  title: string;
  status: string;
  revision: number;
  next_sequence_no: number;
  last_message_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  archived_at: Timestamp | null;
}

export interface ConversationMessageTable {
  message_id: string;
  conversation_id: string;
  tenant_id: string;
  sequence_no: number;
  role: string;
  status: string;
  content_text: string | null;
  client_message_id: string | null;
  reply_to_message_id: string | null;
  task_run_id: string | null;
  agent_run_id: string | null;
  clarify_candidates_json: Json;
  context_message_ids_json: Json;
  context_hash: string | null;
  error_code: string | null;
  error_message_key: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface HumanTaskTable {
  human_task_id: string;
  tenant_id: string;
  task_run_id: string;
  workflow_id: string | null;
  kind: string;
  status: string;
  assignee: string | null;
  candidate_groups: Json;
  payload: Json;
  requested_schema_json: Json | null;
  response_json: Json | null;
  responded_by: string | null;
  responded_at: Timestamp | null;
  response_idempotency_key: string | null;
  decision: Json | null;
  decided_by: string | null;
  decided_at: Timestamp | null;
  decision_reason: string | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface AuditEventTable {
  event_id: string;
  event_key: string | null;
  tenant_id: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  result: string;
  reason: string | null;
  payload: Json;
  trace_id: string | null;
  occurred_at: Timestamp;
}

export interface ToolCallLogTable {
  id: Generated<number>;
  tool_call_id: string;
  task_run_id: string | null;
  workflow_id: string | null;
  tenant_id: string;
  user_id: string | null;
  tool_name: string;
  tool_version: string;
  risk_level: string;
  policy_decision: string;
  status: string;
  duration_ms: number | null;
  idempotency_key: string | null;
  input_hash: string | null;
  output_hash: string | null;
  error_code: string | null;
  adapter_type: string | null;
  mode: string | null;
  execution_context_type: string | null;
  evaluation_run_id: string | null;
  evaluation_case_id: string | null;
  evaluation_execution_plan_ref: string | null;
  evaluation_execution_plan_hash: string | null;
  preview_json: Json | null;
  result_json: Json | null;
  tenant_policy_snapshot_ref: string | null;
  policy_decision_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EvaluationToolCallReservationTable {
  tenant_id: string;
  evaluation_run_id: string;
  evaluation_case_id: string;
  tool_name: string;
  logical_tool_call_id: string;
  tool_version: string;
  operation: string;
  idempotency_key: string | null;
  created_at: Timestamp;
}

export interface IdempotencyRecordTable {
  idempotency_key: string;
  tenant_id: string;
  target_type: string;
  target_id: string;
  request_hash: string;
  response_json: Json | null;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CapabilityReleaseTable {
  release_id: string;
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  resource_version: number;
  action: string;
  previous_version: number | null;
  target_status: string;
  operator_id: string;
  validation_result: Json | null;
  release_note: string | null;
  metadata_json: Json;
  evaluation_gate_decision_id: string | null;
  evaluation_gate_override_id: string | null;
  created_at: Timestamp;
}

export interface TenantRuntimePolicyTable {
  id: Generated<number>;
  tenant_id: string;
  version: number;
  status: string;
  allowed_tools_json: Json;
  denied_tools_json: Json;
  allowed_models_json: Json;
  denied_models_json: Json;
  allowed_handoffs_json: Json;
  denied_handoffs_json: Json;
  budget_cap_json: Json;
  max_concurrent_agent_runs: number;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
}

export interface TenantRuntimePolicySnapshotTable {
  snapshot_id: string;
  snapshot_ref: string;
  tenant_id: string;
  root_snapshot_ref: string;
  parent_snapshot_ref: string | null;
  derivation_type: string;
  lineage_depth: number;
  source_policy_version: number;
  source_policy_hash: string;
  execution_plan_ref: string;
  execution_plan_hash: string;
  execution_plan_type: string;
  policy_json: Json;
  resolved_policy_json: Json;
  snapshot_hash: string;
  created_at: Timestamp;
}

export interface TenantAgentAdmissionTable {
  admission_id: string;
  tenant_id: string;
  task_run_id: string;
  agent_run_id: string | null;
  workflow_id: string | null;
  workflow_run_id: string | null;
  policy_snapshot_ref: string;
  status: string;
  acquired_at: Timestamp;
  activated_at: Timestamp | null;
  released_at: Timestamp | null;
  updated_at: Timestamp;
  release_reason: string | null;
  revision: number;
}

export interface FlowExecutionPlanTable {
  execution_plan_id: string;
  execution_plan_ref: string;
  tenant_id: string;
  flow_id: string;
  flow_version: number;
  flow_sha256: string;
  plan_json: Json;
  execution_plan_hash: string;
  generated_at: Timestamp;
}

export interface AgentExecutionPlanTable {
  execution_plan_id: string;
  execution_plan_ref: string;
  tenant_id: string;
  agent_id: string;
  agent_version: number;
  agent_sha256: string;
  prompt_id: string;
  prompt_version: number;
  prompt_sha256: string;
  model_policy_json: Json;
  model_policy_id: string | null;
  model_policy_version: number | null;
  model_policy_hash: string | null;
  resolved_model_policy_json: Json | null;
  allowed_tools_json: Json;
  allowed_handoffs_json: Json;
  output_schema_json: Json | null;
  budget_json: Json;
  plan_json: Json;
  execution_plan_hash: string;
  generated_at: Timestamp;
  created_at: Timestamp;
}

export interface AgentRunTable {
  agent_run_id: string;
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id: string;
  workflow_run_id: string | null;
  parent_workflow_id: string | null;
  execution_plan_ref: string;
  execution_plan_hash: string;
  agent_id: string;
  agent_version: number;
  prompt_id: string;
  prompt_version: number;
  model: string;
  model_policy_id: string | null;
  model_policy_version: number | null;
  model_policy_hash: string | null;
  selected_model_id: string | null;
  selected_provider: string | null;
  fallback_count: number;
  model_call_count: number;
  execution_mode: string;
  tenant_policy_snapshot_ref: string | null;
  tenant_policy_version: number | null;
  tenant_policy_hash: string | null;
  tenant_admission_id: string | null;
  status: string;
  current_segment_index: number;
  model_turn_count: number;
  tool_call_count: number;
  handoff_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ModelPolicyTable {
  id: Generated<number>;
  tenant_id: string;
  model_policy_id: string;
  version: number;
  status: string;
  protocol: string;
  targets_json: Json;
  retry_policy_json: Json;
  fallback_policy_json: Json;
  request_policy_json: Json;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
}

export interface ModelGatewayProfileTable {
  profile_id: string;
  display_name: string;
  protocol: 'openai_chat_completions';
  base_url: string;
  auth_type: 'none' | 'bearer';
  status: string;
  config_hash: string;
  revision: number;
  credential_ciphertext: string | null;
  credential_iv: string | null;
  credential_auth_tag: string | null;
  credential_fingerprint: string | null;
  credential_revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
  disabled_at: Timestamp | null;
}

export interface ModelDefinitionTable {
  model_id: string;
  version: number;
  display_name: string;
  gateway_profile_id: string;
  gateway_profile_config_hash: string;
  upstream_model_id: string;
  provider: string;
  capabilities_json: Json;
  context_window: number;
  max_output_tokens: number;
  embedding_dimensions: number | null;
  input_cost_per_million: number;
  output_cost_per_million: number;
  currency: string;
  tags_json: Json;
  status: string;
  revision: number;
  model_hash: string;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
  disabled_at: Timestamp | null;
}

export interface ModelCallLogTable {
  model_call_id: string;
  model_request_key: string;
  tenant_id: string;
  user_id: string | null;
  task_run_id: string | null;
  workflow_id: string | null;
  workflow_run_id: string | null;
  agent_run_id: string | null;
  segment_index: number | null;
  model_turn_index: number | null;
  model_policy_id: string;
  model_policy_version: number;
  model_policy_hash: string;
  target_id: string | null;
  provider: string | null;
  model_id: string | null;
  model_version: number | null;
  model_hash: string | null;
  gateway_profile_id: string | null;
  gateway_profile_config_hash: string | null;
  credential_fingerprint: string | null;
  credential_revision: number | null;
  upstream_model_id: string | null;
  protocol: string;
  attempt_count: number;
  fallback_index: number;
  status: string;
  finish_reason: string | null;
  response_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  latency_ms: number | null;
  error_class: string | null;
  error_code: string | null;
  request_hash: string;
  response_hash: string | null;
  safe_response_json: Json | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ModelCallAttemptTable {
  attempt_id: string;
  model_call_id: string;
  global_attempt_index: number;
  target_attempt_index: number;
  fallback_index: number;
  attempt_index: number;
  target_id: string;
  provider: string | null;
  model_id: string;
  model_version: number | null;
  model_hash: string | null;
  gateway_profile_id: string | null;
  gateway_profile_config_hash: string | null;
  credential_fingerprint: string | null;
  credential_revision: number | null;
  upstream_model_id: string | null;
  status: string;
  http_status: number | null;
  error_class: string | null;
  error_code: string | null;
  latency_ms: number | null;
  response_id: string | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Timestamp;
}

export interface EvaluationDatasetTable {
  dataset_id: string;
  version: number;
  status: string;
  name: string;
  description: string | null;
  domain: string | null;
  tags_json: Json;
  default_weight: number;
  revision: number;
  dataset_hash: string;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
}

export interface EvaluationCaseTable {
  case_id: string;
  dataset_id: string;
  dataset_version: number;
  name: string;
  description: string | null;
  input_json: Json;
  context_refs_json: Json;
  expected_status: string | null;
  expected_tool_calls_json: Json;
  forbidden_tools_json: Json;
  final_assertions_json: Json;
  policy_assertions_json: Json;
  latency_budget_ms: number | null;
  input_token_budget: number | null;
  output_token_budget: number | null;
  total_token_budget: number | null;
  cost_budget: number | null;
  minimum_case_score: number | null;
  weight: number;
  tags_json: Json;
  enabled: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EvaluationSubjectSnapshotTable {
  subject_snapshot_id: string;
  subject_snapshot_ref: string;
  primary_subject_type: string;
  primary_subject_id: string;
  primary_subject_version: number;
  primary_subject_hash: string;
  candidate_bundle_json: Json;
  candidate_bundle_hash: string;
  created_at: Timestamp;
}

export interface EvaluationExecutionPlanTable {
  evaluation_execution_plan_id: string;
  evaluation_execution_plan_ref: string;
  subject_snapshot_ref: string;
  subject_snapshot_hash: string;
  tenant_id: string;
  dataset_id: string;
  dataset_version: number;
  dataset_hash: string;
  candidate_bundle_hash: string;
  plan_json: Json;
  plan_hash: string;
  created_at: Timestamp;
}

export interface EvaluationRunTable {
  evaluation_run_id: string;
  tenant_id: string;
  dataset_id: string;
  dataset_version: number;
  dataset_hash: string;
  subject_snapshot_ref: string;
  subject_snapshot_hash: string;
  evaluation_execution_plan_ref: string;
  evaluation_execution_plan_hash: string;
  workflow_id: string | null;
  workflow_run_id: string | null;
  cancellation_requested_at: Timestamp | null;
  system_error_cases: number;
  execution_started_at: Timestamp | null;
  evidence_collection_status: string;
  baseline_run_id: string | null;
  trigger_type: string;
  status: string;
  total_cases: number;
  completed_cases: number;
  passed_cases: number;
  failed_cases: number;
  skipped_cases: number;
  aggregate_score: number | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  error_code: string | null;
  error_message: string | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EvaluationCaseResultTable {
  evaluation_case_result_id: string;
  evaluation_run_id: string;
  case_id: string;
  workflow_id: string | null;
  workflow_run_id: string | null;
  status: string;
  score: number | null;
  metric_results_json: Json;
  evidence_snapshot_json: Json | null;
  evidence_hash: string | null;
  candidate_fidelity_verified: boolean;
  assertion_failure_count: number;
  hard_gate_failure_count: number;
  system_error_class: string | null;
  actual_status: string | null;
  task_run_id: string | null;
  agent_run_id: string | null;
  model_call_ids_json: Json;
  tool_call_ids_json: Json;
  final_output_ref: string | null;
  safe_output_json: Json | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface EvaluationGatePolicyTable {
  gate_policy_id: string;
  version: number;
  status: string;
  resource_types_json: Json;
  required_dataset_refs_json: Json;
  thresholds_json: Json;
  regression_rules_json: Json;
  required_case_tags_json: Json;
  allow_override: boolean;
  revision: number;
  gate_policy_hash: string;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  published_at: Timestamp | null;
}

export interface EvaluationGateDecisionTable {
  gate_decision_id: string;
  resource_type: string;
  resource_id: string;
  resource_version: number;
  resource_hash: string;
  candidate_bundle_hash: string;
  gate_policy_id: string;
  gate_policy_version: number;
  gate_policy_hash: string;
  evaluation_run_ids_json: Json;
  decision: string;
  reasons_json: Json;
  decided_at: Timestamp;
  created_at: Timestamp;
}

export interface EvaluationGateOverrideTable {
  override_id: string;
  gate_decision_id: string;
  resource_type: string;
  resource_id: string;
  resource_version: number;
  resource_hash: string;
  operator_id: string;
  reason: string;
  expires_at: Timestamp | null;
  created_at: Timestamp;
}

export interface EvaluationComparisonTable {
  comparison_id: string;
  candidate_run_id: string;
  baseline_run_id: string;
  dataset_id: string;
  dataset_version: number;
  dataset_hash: string;
  comparable: boolean;
  result_json: Json;
  created_by: string | null;
  created_at: Timestamp;
}

export interface AgentStepTable {
  agent_step_id: string;
  agent_run_id: string;
  segment_index: number;
  stable_step_key: string;
  segment_status: string;
  decision_summary: string | null;
  proposed_tool_calls_json: Json;
  tool_result_refs_json: Json;
  authoritative_tool_result_refs_json: Json;
  human_task_ids_json: Json;
  context_snapshot_before_ref: Json | null;
  context_snapshot_after_ref: Json | null;
  handoff_refs_json: Json;
  context_snapshot_ref: Json | null;
  output_ref: string | null;
  usage_json: Json;
  error_code: string | null;
  error_message: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AgentContextSnapshotTable {
  snapshot_id: string;
  agent_run_id: string;
  previous_snapshot_id: string | null;
  schema_version: string;
  sanitized_messages_json: Json;
  snapshot_hash: string;
  message_count: number;
  byte_size: number;
  created_at: Timestamp;
}

export interface TenantTable {
  tenant_id: string;
  display_name: string;
  description: string;
  status: string;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  disabled_at: Timestamp | null;
}

export interface UserAccountTable {
  user_id: string;
  display_name: string;
  email: string | null;
  status: string;
  platform_roles: Json;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  disabled_at: Timestamp | null;
}

export interface TenantMembershipTable {
  tenant_id: string;
  user_id: string;
  roles: Json;
  status: string;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  disabled_at: Timestamp | null;
}

export interface Database {
  tenant: TenantTable;
  user_account: UserAccountTable;
  tenant_membership: TenantMembershipTable;
  flow_definition: FlowDefinitionTable;
  flow_route_config: FlowRouteConfigTable;
  flow_route_embedding: FlowRouteEmbeddingTable;
  agent_spec: AgentSpecTable;
  tool_manifest: ToolManifestTable;
  prompt_definition: PromptDefinitionTable;
  conversation: ConversationTable;
  conversation_message: ConversationMessageTable;
  task_run: TaskRunTable;
  human_task: HumanTaskTable;
  audit_event: AuditEventTable;
  tool_call_log: ToolCallLogTable;
  evaluation_tool_call_reservation: EvaluationToolCallReservationTable;
  idempotency_record: IdempotencyRecordTable;
  capability_release: CapabilityReleaseTable;
  tenant_runtime_policy: TenantRuntimePolicyTable;
  tenant_runtime_policy_snapshot: TenantRuntimePolicySnapshotTable;
  tenant_agent_admission: TenantAgentAdmissionTable;
  flow_execution_plan: FlowExecutionPlanTable;
  agent_execution_plan: AgentExecutionPlanTable;
  agent_run: AgentRunTable;
  agent_step: AgentStepTable;
  agent_context_snapshot: AgentContextSnapshotTable;
  model_policy: ModelPolicyTable;
  model_gateway_profile: ModelGatewayProfileTable;
  model_definition: ModelDefinitionTable;
  model_call_log: ModelCallLogTable;
  model_call_attempt: ModelCallAttemptTable;
  evaluation_dataset: EvaluationDatasetTable;
  evaluation_case: EvaluationCaseTable;
  evaluation_subject_snapshot: EvaluationSubjectSnapshotTable;
  evaluation_execution_plan: EvaluationExecutionPlanTable;
  evaluation_run: EvaluationRunTable;
  evaluation_case_result: EvaluationCaseResultTable;
  evaluation_gate_policy: EvaluationGatePolicyTable;
  evaluation_gate_decision: EvaluationGateDecisionTable;
  evaluation_gate_override: EvaluationGateOverrideTable;
  evaluation_comparison: EvaluationComparisonTable;
}

export interface CreateDbOptions {
  databaseUrl: string;
  maxConnections?: number;
}

export function createDb(options: CreateDbOptions): Kysely<Database> {
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: options.maxConnections ?? 10,
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

export async function closeDb(db: Kysely<Database>): Promise<void> {
  await db.destroy();
}

export async function withTransaction<T>(
  db: Kysely<Database> | Transaction<Database>,
  callback: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  if (db instanceof Transaction) {
    return callback(db as Kysely<Database>);
  }
  return db.transaction().execute(callback);
}

export interface Repository<TRecord extends object> {
  list(): Promise<TRecord[]>;
  findById(id: string): Promise<TRecord | undefined>;
  upsert(record: TRecord): Promise<TRecord>;
}

export class InMemoryRepository<TRecord extends { id: string }> implements Repository<TRecord> {
  private readonly records = new Map<string, TRecord>();

  constructor(initialRecords: TRecord[] = []) {
    for (const record of initialRecords) {
      this.records.set(record.id, record);
    }
  }

  async list(): Promise<TRecord[]> {
    return [...this.records.values()];
  }

  async findById(id: string): Promise<TRecord | undefined> {
    return this.records.get(id);
  }

  async upsert(record: TRecord): Promise<TRecord> {
    this.records.set(record.id, record);
    return record;
  }
}

export { sql };
export * from './repositories.js';
export * from './evaluation-repositories.js';
export * from './registry.js';
export * from './tenant-policy.js';
export * from './iam-repositories.js';
