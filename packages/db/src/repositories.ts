import { createHash, randomUUID } from 'node:crypto';
import type {
  AuditEvent,
  FlowSpec,
  IdempotencyRecord,
  PromptDefinition,
  RouteSpec,
  TaskRun,
  ToolManifest,
} from '@dar/contracts';
import {
  agentSpecSchema,
  auditEventSchema,
  flowSpecSchema,
  idempotencyRecordSchema,
  promptDefinitionSchema,
  routeSpecSchema,
  taskRunSchema,
  taskRunStatusSchema,
  toolManifestSchema,
  type AgentSpec,
  type RouteResult,
  type WorkflowStartResponse,
} from '@dar/contracts';
import type { Insertable, Kysely, Selectable, Updateable } from 'kysely';
import type {
  AgentSpecTable,
  AuditEventTable,
  Database,
  FlowDefinitionTable,
  FlowRouteConfigTable,
  IdempotencyRecordTable,
  PromptDefinitionTable,
  TaskRunTable,
  ToolManifestTable,
} from './index.js';

export const executableSpecStatuses = ['published', 'gray'] as const;
export type ExecutableSpecStatus = (typeof executableSpecStatuses)[number];

export interface RepositoryTenantOptions {
  tenantId?: string;
}

export interface UpsertSpecOptions extends RepositoryTenantOptions {
  status?: ExecutableSpecStatus | 'draft' | 'disabled' | 'archived';
  createdBy?: string;
}

export interface CreateTaskRunInput {
  taskRun: TaskRun;
  input: unknown;
  routeResult?: RouteResult;
  workflowStart?: WorkflowStartResponse;
}

export interface UpdateTaskRunStatusInput {
  status: TaskRun['status'];
  errorCode?: string;
  errorMessage?: string;
}

export interface IdempotencyReplayInput {
  idempotencyKey: string;
  tenantId: string;
  targetType: string;
  targetId: string;
  requestHash: string;
}

export type IdempotencyReplayDecision =
  | { decision: 'miss' }
  | { decision: 'replay'; record: IdempotencyRecord }
  | { decision: 'conflict'; record: IdempotencyRecord };

export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function buildDbFlowSnapshotRef(flowId: string, version: number): string {
  return `db://flow/${encodeURIComponent(flowId)}/versions/${version}`;
}

export function parseDbFlowSnapshotRef(ref: string): { flowId: string; version: number } | undefined {
  const match = /^db:\/\/flow\/([^/]+)\/versions\/([1-9]\d*)$/u.exec(ref);
  if (!match) {
    return undefined;
  }

  return {
    flowId: decodeURIComponent(match[1] ?? ''),
    version: Number(match[2]),
  };
}

export class FlowDefinitionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listPublished(options: RepositoryTenantOptions = {}): Promise<FlowSpec[]> {
    const rows = await this.db
      .selectFrom('flow_definition')
      .select(['spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('status', 'in', executableSpecStatuses)
      .orderBy('flow_id', 'asc')
      .orderBy('version', 'desc')
      .execute();

    return rows.map((row) => flowSpecSchema.parse(row.spec_json));
  }

  async getPublished(flowId: string, version: number, options: RepositoryTenantOptions = {}): Promise<FlowSpec | undefined> {
    const row = await this.db
      .selectFrom('flow_definition')
      .select(['spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('flow_id', '=', flowId)
      .where('version', '=', version)
      .where('status', 'in', executableSpecStatuses)
      .executeTakeFirst();

    return row ? flowSpecSchema.parse(row.spec_json) : undefined;
  }

  async upsert(flowSpec: FlowSpec, options: UpsertSpecOptions = {}): Promise<FlowSpec> {
    const parsed = flowSpecSchema.parse({ ...flowSpec, status: options.status ?? flowSpec.status ?? 'published' });
    const status = options.status ?? parsed.status ?? 'published';
    const row: Insertable<FlowDefinitionTable> = {
      tenant_id: tenant(options),
      flow_id: parsed.flow_id,
      version: parsed.version,
      status,
      spec_json: parsed,
      sha256: parsed.sha256 ?? hashJson(parsed),
      created_by: options.createdBy ?? null,
      published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus) ? new Date() : null,
    };

    const saved = await this.db
      .insertInto('flow_definition')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'flow_id', 'version']).doUpdateSet({
          status: row.status,
          spec_json: row.spec_json,
          sha256: row.sha256,
          created_by: row.created_by,
          published_at: row.published_at,
        }),
      )
      .returning(['spec_json'])
      .executeTakeFirstOrThrow();

    return flowSpecSchema.parse(saved.spec_json);
  }
}

export class RouteConfigRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listPublished(options: RepositoryTenantOptions = {}): Promise<RouteSpec[]> {
    const rows = await this.db
      .selectFrom('flow_route_config')
      .select(['route_spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('status', 'in', executableSpecStatuses)
      .orderBy('priority', 'desc')
      .orderBy('route_id', 'asc')
      .execute();

    return rows.map((row) => routeSpecSchema.parse(row.route_spec_json));
  }

  async getPublished(routeId: string, options: RepositoryTenantOptions = {}): Promise<RouteSpec | undefined> {
    const row = await this.db
      .selectFrom('flow_route_config')
      .select(['route_spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('route_id', '=', routeId)
      .where('status', 'in', executableSpecStatuses)
      .orderBy('flow_version', 'desc')
      .executeTakeFirst();

    return row ? routeSpecSchema.parse(row.route_spec_json) : undefined;
  }

  async upsert(routeSpec: RouteSpec, options: UpsertSpecOptions = {}): Promise<RouteSpec> {
    const parsed = routeSpecSchema.parse({ ...routeSpec, status: options.status ?? routeSpec.status ?? 'published' });
    const status = options.status ?? parsed.status ?? 'published';
    const routeId = parsed.route_id ?? `${parsed.flow_id}@${parsed.version}`;
    const row: Insertable<FlowRouteConfigTable> = {
      tenant_id: tenant(options),
      route_id: routeId,
      flow_id: parsed.flow_id,
      flow_version: parsed.version,
      status,
      route_spec_json: { ...parsed, route_id: routeId },
      priority: parsed.route.priority,
      sha256: parsed.sha256 ?? hashJson(parsed),
    };

    const saved = await this.db
      .insertInto('flow_route_config')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'route_id', 'flow_version']).doUpdateSet({
          flow_id: row.flow_id,
          status: row.status,
          route_spec_json: row.route_spec_json,
          priority: row.priority,
          sha256: row.sha256,
          updated_at: new Date(),
        }),
      )
      .returning(['route_spec_json'])
      .executeTakeFirstOrThrow();

    return routeSpecSchema.parse(saved.route_spec_json);
  }
}

export class ToolManifestRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listPublished(options: RepositoryTenantOptions = {}): Promise<ToolManifest[]> {
    const rows = await this.db
      .selectFrom('tool_manifest')
      .select(['spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('status', 'in', executableSpecStatuses)
      .orderBy('spec_id', 'asc')
      .orderBy('version', 'desc')
      .execute();

    return rows.map((row) => toolManifestSchema.parse(row.spec_json));
  }

  async getPublished(toolName: string, options: RepositoryTenantOptions = {}): Promise<ToolManifest | undefined> {
    const row = await this.db
      .selectFrom('tool_manifest')
      .select(['spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('spec_id', '=', toolName)
      .where('status', 'in', executableSpecStatuses)
      .orderBy('version', 'desc')
      .executeTakeFirst();

    return row ? toolManifestSchema.parse(row.spec_json) : undefined;
  }

  async upsert(manifest: ToolManifest, options: UpsertSpecOptions = {}): Promise<ToolManifest> {
    const parsed = toolManifestSchema.parse({ ...manifest, status: options.status ?? manifest.status ?? 'published' });
    const status = options.status ?? parsed.status ?? 'published';
    const row: Insertable<ToolManifestTable> = {
      tenant_id: tenant(options),
      spec_id: parsed.tool_name,
      version: manifestSpecVersion(parsed),
      status,
      spec_json: parsed,
      sha256: parsed.sha256 ?? hashJson(parsed),
      created_by: options.createdBy ?? null,
      published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus) ? new Date() : null,
    };

    const saved = await this.db
      .insertInto('tool_manifest')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'spec_id', 'version']).doUpdateSet({
          status: row.status,
          spec_json: row.spec_json,
          sha256: row.sha256,
          created_by: row.created_by,
          published_at: row.published_at,
        }),
      )
      .returning(['spec_json'])
      .executeTakeFirstOrThrow();

    return toolManifestSchema.parse(saved.spec_json);
  }
}

export class TaskRunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateTaskRunInput): Promise<TaskRun> {
    const taskRun = taskRunSchema.parse(input.taskRun);
    const row: Insertable<TaskRunTable> = {
      task_run_id: taskRun.task_run_id,
      tenant_id: taskRun.tenant_id,
      user_id: taskRun.user_id,
      route_type: taskRun.route_type,
      flow_id: taskRun.flow_id ?? null,
      flow_version: taskRun.flow_version ?? null,
      workflow_id: taskRun.workflow_id ?? null,
      status: taskRun.status,
      error_code: taskRun.error_code ?? null,
      error_message: taskRun.error_message ?? null,
      input_json: input.input,
      route_result_json: input.routeResult ?? null,
      workflow_start_json: input.workflowStart ?? null,
    };

    const saved = await this.db
      .insertInto('task_run')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapTaskRun(saved);
  }

  async get(taskRunId: string): Promise<TaskRun | undefined> {
    const row = await this.db
      .selectFrom('task_run')
      .selectAll()
      .where('task_run_id', '=', taskRunId)
      .executeTakeFirst();

    return row ? mapTaskRun(row) : undefined;
  }

  async updateStatus(
    taskRunId: string,
    input: TaskRun['status'] | UpdateTaskRunStatusInput,
  ): Promise<TaskRun | undefined> {
    const normalized = typeof input === 'string' ? { status: input } : input;
    const parsedStatus = taskRunStatusSchema.parse(normalized.status);
    const failureStatus = parsedStatus === 'failed' || parsedStatus === 'failed_to_start';
    const rowUpdate: Updateable<TaskRunTable> = {
      status: parsedStatus,
      updated_at: new Date(),
      error_code: failureStatus ? normalized.errorCode ?? 'WORKFLOW_FAILED' : null,
      error_message: failureStatus ? normalized.errorMessage ?? 'Workflow failed' : null,
    };
    const row = await this.db
      .updateTable('task_run')
      .set(rowUpdate)
      .where('task_run_id', '=', taskRunId)
      .returningAll()
      .executeTakeFirst();

    return row ? mapTaskRun(row) : undefined;
  }

  async updateWorkflowStart(
    taskRunId: string,
    workflowStart: WorkflowStartResponse,
  ): Promise<TaskRun | undefined> {
    const row = await this.db
      .updateTable('task_run')
      .set({ workflow_start_json: workflowStart, updated_at: new Date() })
      .where('task_run_id', '=', taskRunId)
      .returningAll()
      .executeTakeFirst();

    return row ? mapTaskRun(row) : undefined;
  }
}

export class AuditEventRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): Promise<AuditEvent> {
    const auditEvent = auditEventSchema.parse({
      ...event,
      event_id: `audit_${randomUUID()}`,
      occurred_at: new Date().toISOString(),
    });
    const row: Insertable<AuditEventTable> = {
      event_id: auditEvent.event_id,
      tenant_id: auditEvent.tenant_id,
      actor_id: auditEvent.actor_id ?? null,
      action: auditEvent.action,
      target_type: auditEvent.target_type,
      target_id: auditEvent.target_id,
      result: auditEvent.result,
      reason: auditEvent.reason ?? null,
      payload: auditEvent.payload,
      trace_id: auditEvent.trace_id ?? null,
      occurred_at: auditEvent.occurred_at,
    };

    const saved = await this.db.insertInto('audit_event').values(row).returningAll().executeTakeFirstOrThrow();
    return mapAuditEvent(saved);
  }

  async list(options: { tenantId?: string; targetType?: string; targetId?: string } = {}): Promise<AuditEvent[]> {
    let query = this.db.selectFrom('audit_event').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.targetType) {
      query = query.where('target_type', '=', options.targetType);
    }
    if (options.targetId) {
      query = query.where('target_id', '=', options.targetId);
    }

    const rows = await query.orderBy('occurred_at', 'asc').execute();
    return rows.map(mapAuditEvent);
  }
}

export class IdempotencyRecordRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async get(idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    const row = await this.db
      .selectFrom('idempotency_record')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();

    return row ? mapIdempotencyRecord(row) : undefined;
  }

  async insert(record: Omit<IdempotencyRecord, 'created_at' | 'updated_at'>): Promise<IdempotencyRecord> {
    const parsed = idempotencyRecordSchema.parse(record);
    const row: Insertable<IdempotencyRecordTable> = {
      idempotency_key: parsed.idempotency_key,
      tenant_id: parsed.tenant_id,
      target_type: parsed.target_type,
      target_id: parsed.target_id,
      request_hash: parsed.request_hash,
      response_json: parsed.response_json ?? null,
      status: parsed.status,
    };

    const saved = await this.db
      .insertInto('idempotency_record')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapIdempotencyRecord(saved);
  }

  async replayOrConflict(input: IdempotencyReplayInput): Promise<IdempotencyReplayDecision> {
    const record = await this.get(input.idempotencyKey);
    if (!record) {
      return { decision: 'miss' };
    }

    if (
      record.tenant_id !== input.tenantId ||
      record.target_type !== input.targetType ||
      record.target_id !== input.targetId ||
      record.request_hash !== input.requestHash
    ) {
      return { decision: 'conflict', record };
    }

    return { decision: 'replay', record };
  }
}

export async function upsertAgentSpec(
  db: Kysely<Database>,
  agentSpec: AgentSpec,
  options: UpsertSpecOptions = {},
): Promise<AgentSpec> {
  const parsed = agentSpecSchema.parse({ ...agentSpec, status: options.status ?? agentSpec.status ?? 'published' });
  const status = options.status ?? parsed.status ?? 'published';
  const row: Insertable<AgentSpecTable> = {
    tenant_id: tenant(options),
    spec_id: parsed.agent_id,
    version: parsed.version,
    status,
    spec_json: parsed,
    sha256: parsed.sha256 ?? hashJson(parsed),
    created_by: options.createdBy ?? null,
    published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus) ? new Date() : null,
  };
  const saved = await db
    .insertInto('agent_spec')
    .values(row)
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'spec_id', 'version']).doUpdateSet({
        status: row.status,
        spec_json: row.spec_json,
        sha256: row.sha256,
        created_by: row.created_by,
        published_at: row.published_at,
      }),
    )
    .returning(['spec_json'])
    .executeTakeFirstOrThrow();

  return agentSpecSchema.parse(saved.spec_json);
}

export async function upsertPromptDefinition(
  db: Kysely<Database>,
  prompt: PromptDefinition,
  options: UpsertSpecOptions = {},
): Promise<PromptDefinition> {
  const parsed = promptDefinitionSchema.parse({ ...prompt, status: options.status ?? prompt.status ?? 'published' });
  const status = options.status ?? parsed.status ?? 'published';
  const row: Insertable<PromptDefinitionTable> = {
    tenant_id: tenant(options),
    spec_id: parsed.prompt_id,
    version: parsed.version,
    status,
    spec_json: parsed,
    sha256: parsed.sha256 ?? hashJson(parsed),
    created_by: options.createdBy ?? null,
    published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus) ? new Date() : null,
  };
  const saved = await db
    .insertInto('prompt_definition')
    .values(row)
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'spec_id', 'version']).doUpdateSet({
        status: row.status,
        spec_json: row.spec_json,
        sha256: row.sha256,
        created_by: row.created_by,
        published_at: row.published_at,
      }),
    )
    .returning(['spec_json'])
    .executeTakeFirstOrThrow();

  return promptDefinitionSchema.parse(saved.spec_json);
}

function tenant(options: RepositoryTenantOptions): string {
  return options.tenantId ?? 'default';
}

function manifestSpecVersion(manifest: ToolManifest): number {
  const [major] = manifest.version.split('.');
  const parsed = Number(major);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function mapTaskRun(row: Selectable<TaskRunTable>): TaskRun {
  const taskRun: TaskRun = {
    task_run_id: row.task_run_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    route_type: row.route_type as TaskRun['route_type'],
    status: row.status as TaskRun['status'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };

  if (row.flow_id) {
    taskRun.flow_id = row.flow_id;
  }
  if (row.flow_version) {
    taskRun.flow_version = row.flow_version;
  }
  if (row.workflow_id) {
    taskRun.workflow_id = row.workflow_id;
  }
  if (row.error_code) {
    taskRun.error_code = row.error_code;
  }
  if (row.error_message) {
    taskRun.error_message = row.error_message;
  }

  return taskRunSchema.parse(taskRun);
}

function mapAuditEvent(row: Selectable<AuditEventTable>): AuditEvent {
  const auditEvent: AuditEvent = {
    event_id: row.event_id,
    tenant_id: row.tenant_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    result: row.result as AuditEvent['result'],
    occurred_at: toIso(row.occurred_at),
    payload: isRecord(row.payload) ? row.payload : {},
  };

  if (row.actor_id) {
    auditEvent.actor_id = row.actor_id;
  }
  if (row.reason) {
    auditEvent.reason = row.reason;
  }
  if (row.trace_id) {
    auditEvent.trace_id = row.trace_id;
  }

  return auditEventSchema.parse(auditEvent);
}

function mapIdempotencyRecord(row: Selectable<IdempotencyRecordTable>): IdempotencyRecord {
  const record: IdempotencyRecord = {
    idempotency_key: row.idempotency_key,
    tenant_id: row.tenant_id,
    target_type: row.target_type,
    target_id: row.target_id,
    request_hash: row.request_hash,
    status: row.status as IdempotencyRecord['status'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };

  if (row.response_json !== null) {
    record.response_json = row.response_json;
  }

  return idempotencyRecordSchema.parse(record);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
