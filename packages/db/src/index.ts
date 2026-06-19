import { Kysely, PostgresDialect, type ColumnType, type Generated, sql } from 'kysely';
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
  example_text: string;
  embedding: unknown | null;
  created_at: Timestamp;
}

export interface TaskRunTable {
  task_run_id: string;
  tenant_id: string;
  user_id: string;
  route_type: string;
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
  preview_json: Json | null;
  result_json: Json | null;
  tenant_policy_snapshot_ref: string | null;
  policy_decision_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
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

export interface Database {
  flow_definition: FlowDefinitionTable;
  flow_route_config: FlowRouteConfigTable;
  flow_route_embedding: FlowRouteEmbeddingTable;
  agent_spec: AgentSpecTable;
  tool_manifest: ToolManifestTable;
  prompt_definition: PromptDefinitionTable;
  task_run: TaskRunTable;
  human_task: HumanTaskTable;
  audit_event: AuditEventTable;
  tool_call_log: ToolCallLogTable;
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
  db: Kysely<Database>,
  callback: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
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
export * from './registry.js';
export * from './tenant-policy.js';
