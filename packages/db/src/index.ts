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
  status: string;
  assignee: string | null;
  candidate_groups: Json;
  payload: Json;
  decision: Json | null;
  decided_by: string | null;
  decided_at: Timestamp | null;
  decision_reason: string | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface AuditEventTable {
  event_id: string;
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
