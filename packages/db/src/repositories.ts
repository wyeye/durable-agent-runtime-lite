import { createHash, randomUUID } from 'node:crypto';
import type {
  AuditEvent,
  FlowSpec,
  HumanTask,
  HumanTaskCreateRequest,
  IdempotencyRecord,
  PromptDefinition,
  RouteSpec,
  TaskRun,
  ToolCallLog,
  ToolManifest,
} from '@dar/contracts';
import {
  agentSpecSchema,
  auditEventSchema,
  flowSpecSchema,
  humanTaskCreateRequestSchema,
  humanTaskSchema,
  idempotencyRecordSchema,
  promptDefinitionSchema,
  routeSpecSchema,
  taskRunSchema,
  taskRunStatusSchema,
  toolCallLogSchema,
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
  HumanTaskTable,
  IdempotencyRecordTable,
  PromptDefinitionTable,
  TaskRunTable,
  ToolCallLogTable,
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

export interface HumanTaskDecisionInput {
  tenantId?: string;
  decidedBy: string;
  decisionReason?: string;
  payload?: Record<string, unknown>;
}

export interface ToolCallLogCreateInput {
  tool_call_id?: string;
  task_run_id?: string;
  workflow_id?: string;
  tenant_id: string;
  user_id?: string;
  tool_name: string;
  tool_version: string;
  risk_level: ToolCallLog['risk_level'];
  policy_decision: ToolCallLog['policy_decision'];
  status: ToolCallLog['status'];
  mode?: ToolCallLog['mode'];
  duration_ms?: number;
  idempotency_key?: string;
  input_hash?: string;
  output_hash?: string;
  error_code?: string;
  adapter_type?: string;
  preview_json?: unknown;
  result_json?: unknown;
}

export interface ToolCallLogUpdateInput {
  status?: ToolCallLog['status'];
  policy_decision?: ToolCallLog['policy_decision'];
  mode?: ToolCallLog['mode'];
  duration_ms?: number;
  output_hash?: string;
  error_code?: string;
  preview_json?: unknown;
  result_json?: unknown;
}

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

export class HumanTaskRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: HumanTaskCreateRequest & { human_task_id?: string }): Promise<HumanTask> {
    const parsed = humanTaskCreateRequestSchema.parse(input);
    const humanTaskId = input.human_task_id ?? `human_${randomUUID()}`;
    const payload = {
      ...parsed.payload,
      ...(parsed.tool_call_id ? { tool_call_id: parsed.tool_call_id } : {}),
      ...(parsed.tool_name ? { tool_name: parsed.tool_name } : {}),
      requested_by: parsed.user_id,
    };
    const row: Insertable<HumanTaskTable> = {
      human_task_id: humanTaskId,
      tenant_id: parsed.tenant_id,
      task_run_id: parsed.task_run_id,
      workflow_id: parsed.workflow_id ?? null,
      status: 'pending',
      assignee: parsed.assignee ?? null,
      candidate_groups: parsed.candidate_groups,
      payload,
      decision: null,
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      completed_at: null,
    };

    const saved = await this.db.insertInto('human_task').values(row).returningAll().executeTakeFirstOrThrow();
    return mapHumanTask(saved);
  }

  async get(humanTaskId: string): Promise<HumanTask | undefined> {
    const row = await this.db
      .selectFrom('human_task')
      .selectAll()
      .where('human_task_id', '=', humanTaskId)
      .executeTakeFirst();

    return row ? mapHumanTask(row) : undefined;
  }

  async approve(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'approved', input);
  }

  async reject(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'rejected', input);
  }

  async cancel(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'cancelled', input);
  }

  async expire(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'expired', input);
  }

  async listByTaskRunId(taskRunId: string, options: RepositoryTenantOptions = {}): Promise<HumanTask[]> {
    let query = this.db
      .selectFrom('human_task')
      .selectAll()
      .where('task_run_id', '=', taskRunId);

    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }

    const rows = await query.orderBy('created_at', 'asc').execute();
    return rows.map(mapHumanTask);
  }

  async list(options: { tenantId?: string; taskRunId?: string; status?: HumanTask['status'] } = {}): Promise<HumanTask[]> {
    let query = this.db.selectFrom('human_task').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.taskRunId) {
      query = query.where('task_run_id', '=', options.taskRunId);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }

    const rows = await query.orderBy('created_at', 'asc').execute();
    return rows.map(mapHumanTask);
  }

  private async decide(
    humanTaskId: string,
    status: HumanTask['status'],
    input: HumanTaskDecisionInput,
  ): Promise<HumanTask | undefined> {
    const decidedAt = new Date();
    let query = this.db
      .updateTable('human_task')
      .set({
        status,
        decision: {
          status,
          reason: input.decisionReason,
          payload: input.payload ?? {},
        },
        decided_by: input.decidedBy,
        decided_at: decidedAt,
        decision_reason: input.decisionReason ?? null,
        completed_at: decidedAt,
      })
      .where('human_task_id', '=', humanTaskId);

    if (input.tenantId) {
      query = query.where('tenant_id', '=', input.tenantId);
    }

    const row = await query.returningAll().executeTakeFirst();
    return row ? mapHumanTask(row) : undefined;
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

export class ToolCallLogRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: ToolCallLogCreateInput): Promise<ToolCallLog> {
    const toolCallLog = toolCallLogSchema.parse({
      ...input,
      tool_call_id: input.tool_call_id ?? `tool_call_${randomUUID()}`,
    });
    const row: Insertable<ToolCallLogTable> = {
      tool_call_id: toolCallLog.tool_call_id,
      task_run_id: toolCallLog.task_run_id ?? null,
      workflow_id: toolCallLog.workflow_id ?? null,
      tenant_id: toolCallLog.tenant_id,
      user_id: toolCallLog.user_id ?? null,
      tool_name: toolCallLog.tool_name,
      tool_version: toolCallLog.tool_version,
      risk_level: toolCallLog.risk_level,
      policy_decision: toolCallLog.policy_decision,
      status: toolCallLog.status,
      duration_ms: toolCallLog.duration_ms ?? null,
      idempotency_key: toolCallLog.idempotency_key ?? null,
      input_hash: toolCallLog.input_hash ?? null,
      output_hash: toolCallLog.output_hash ?? null,
      error_code: toolCallLog.error_code ?? null,
      adapter_type: toolCallLog.adapter_type ?? null,
      mode: toolCallLog.mode ?? null,
      preview_json: toolCallLog.preview_json ?? null,
      result_json: toolCallLog.result_json ?? null,
    };

    const saved = await this.db.insertInto('tool_call_log').values(row).returningAll().executeTakeFirstOrThrow();
    return mapToolCallLog(saved);
  }

  async get(toolCallId: string): Promise<ToolCallLog | undefined> {
    const row = await this.db
      .selectFrom('tool_call_log')
      .selectAll()
      .where('tool_call_id', '=', toolCallId)
      .executeTakeFirst();

    return row ? mapToolCallLog(row) : undefined;
  }

  async update(toolCallId: string, input: ToolCallLogUpdateInput): Promise<ToolCallLog | undefined> {
    const rowUpdate: Updateable<ToolCallLogTable> = {
      updated_at: new Date(),
    };
    if (input.status) {
      rowUpdate.status = input.status;
    }
    if (input.policy_decision) {
      rowUpdate.policy_decision = input.policy_decision;
    }
    if (input.mode) {
      rowUpdate.mode = input.mode;
    }
    if (input.duration_ms !== undefined) {
      rowUpdate.duration_ms = input.duration_ms;
    }
    if (input.output_hash !== undefined) {
      rowUpdate.output_hash = input.output_hash;
    }
    if (input.error_code !== undefined) {
      rowUpdate.error_code = input.error_code;
    }
    if (input.preview_json !== undefined) {
      rowUpdate.preview_json = input.preview_json;
    }
    if (input.result_json !== undefined) {
      rowUpdate.result_json = input.result_json;
    }

    const row = await this.db
      .updateTable('tool_call_log')
      .set(rowUpdate)
      .where('tool_call_id', '=', toolCallId)
      .returningAll()
      .executeTakeFirst();

    return row ? mapToolCallLog(row) : undefined;
  }

  async list(options: { tenantId?: string; taskRunId?: string } = {}): Promise<ToolCallLog[]> {
    let query = this.db.selectFrom('tool_call_log').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.taskRunId) {
      query = query.where('task_run_id', '=', options.taskRunId);
    }

    const rows = await query.orderBy('created_at', 'asc').execute();
    return rows.map(mapToolCallLog);
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

function mapHumanTask(row: Selectable<HumanTaskTable>): HumanTask {
  const humanTask: HumanTask = {
    human_task_id: row.human_task_id,
    tenant_id: row.tenant_id,
    task_run_id: row.task_run_id,
    status: row.status as HumanTask['status'],
    candidate_groups: Array.isArray(row.candidate_groups) ? row.candidate_groups.map(String) : [],
    payload: isRecord(row.payload) ? row.payload : {},
    created_at: toIso(row.created_at),
  };

  if (row.workflow_id) {
    humanTask.workflow_id = row.workflow_id;
  }
  if (row.assignee) {
    humanTask.assignee = row.assignee;
  }
  if (isRecord(row.decision)) {
    humanTask.decision = row.decision;
  }
  if (row.decided_by) {
    humanTask.decided_by = row.decided_by;
  }
  if (row.decided_at) {
    humanTask.decided_at = toIso(row.decided_at);
  }
  if (row.decision_reason) {
    humanTask.decision_reason = row.decision_reason;
  }
  if (row.completed_at) {
    humanTask.completed_at = toIso(row.completed_at);
  }

  return humanTaskSchema.parse(humanTask);
}

function mapToolCallLog(row: Selectable<ToolCallLogTable>): ToolCallLog {
  const toolCallLog: ToolCallLog = {
    tool_call_id: row.tool_call_id,
    tenant_id: row.tenant_id,
    tool_name: row.tool_name,
    tool_version: row.tool_version,
    risk_level: row.risk_level as ToolCallLog['risk_level'],
    policy_decision: row.policy_decision as ToolCallLog['policy_decision'],
    status: row.status as ToolCallLog['status'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };

  if (row.task_run_id) {
    toolCallLog.task_run_id = row.task_run_id;
  }
  if (row.workflow_id) {
    toolCallLog.workflow_id = row.workflow_id;
  }
  if (row.user_id) {
    toolCallLog.user_id = row.user_id;
  }
  if (row.mode) {
    toolCallLog.mode = row.mode as ToolCallLog['mode'];
  }
  if (row.duration_ms !== null) {
    toolCallLog.duration_ms = row.duration_ms;
  }
  if (row.idempotency_key) {
    toolCallLog.idempotency_key = row.idempotency_key;
  }
  if (row.input_hash) {
    toolCallLog.input_hash = row.input_hash;
  }
  if (row.output_hash) {
    toolCallLog.output_hash = row.output_hash;
  }
  if (row.error_code) {
    toolCallLog.error_code = row.error_code;
  }
  if (row.adapter_type) {
    toolCallLog.adapter_type = row.adapter_type;
  }
  if (row.preview_json !== null) {
    toolCallLog.preview_json = row.preview_json;
  }
  if (row.result_json !== null) {
    toolCallLog.result_json = row.result_json;
  }

  return toolCallLogSchema.parse(toolCallLog);
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
