import { createHash, randomUUID } from 'node:crypto';
import {
  humanTaskSchema,
  operationAuditQuerySchema,
  toolCallLogSchema,
  toolCommitRequestSchema,
  toolCommitResponseSchema,
  toolInvokeRequestSchema,
  toolInvokeResponseSchema,
  toolPreviewRequestSchema,
  toolPreviewResponseSchema,
  toolCallQuerySchema,
  type HumanTask,
  type PolicyEvaluationResult,
  type ToolCallLog,
  type ToolCommitRequest,
  type ToolCommitResponse,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
  type ToolManifest,
  type ToolPolicyDecision,
  type ToolPreviewRequest,
  type ToolPreviewResponse,
  type TenantRuntimePolicySnapshot,
  type AuditEvent,
} from '@dar/contracts';
import { maskSensitiveFields } from '@dar/security';
import {
  localizeAuditEvent,
  messageKeyForAuditEvent,
  type SafeTranslationParams,
} from '@dar/i18n';
import {
  HumanTaskRepository,
  IdempotencyRecordRepository,
  TenantRuntimePolicyError,
  type ListAuditEventsOptions,
  type ListToolCallLogsOptions,
  type EvaluationToolCallReservationInput,
  type EvaluationToolCallReservationResult,
  type ToolCallLogCreateInput,
  assertSnapshotAllowsTool,
} from '@dar/db';
import { InMemoryAuditStore, type AuditStore } from './audit.js';
import { ToolAdapterError } from './adapter-errors.js';
import { validateArguments } from './schema-validator.js';
import { ToolAdapterDispatcher } from './tool-adapter-dispatcher.js';
import { InMemoryToolManifestRegistry, type ToolManifestRegistry } from './tool-registry.js';

export interface HumanTaskLookupStore {
  findApprovedForToolCall(input: {
    tenantId: string;
    taskRunId?: string;
    toolCallId: string;
  }): Promise<HumanTask | undefined>;
}

export interface ToolCallLogStore {
  create(input: ToolCallLogCreateInput): Promise<ToolCallLog>;
  get(toolCallId: string): Promise<ToolCallLog | undefined>;
  update(toolCallId: string, input: ToolCallLogUpdateInput): Promise<ToolCallLog | undefined>;
  list(options?: ListToolCallLogsOptions): Promise<ToolCallLog[]>;
  reserveEvaluationLogicalCall?(
    input: EvaluationToolCallReservationInput,
  ): Promise<EvaluationToolCallReservationResult>;
}

export interface TenantPolicySnapshotLookupStore {
  getByRef(snapshotRef: string, options?: { tenantId?: string }): Promise<TenantRuntimePolicySnapshot | undefined>;
}

export interface ToolCallLogUpdateInput {
  status?: ToolCallLog['status'];
  policy_decision?: ToolPolicyDecision;
  mode?: 'preview' | 'commit';
  execution_context_type?: ToolCallLog['execution_context_type'];
  evaluation_run_id?: string;
  evaluation_case_id?: string;
  evaluation_execution_plan_ref?: string;
  evaluation_execution_plan_hash?: string;
  duration_ms?: number;
  output_hash?: string;
  error_code?: string;
  preview_json?: unknown;
  result_json?: unknown;
  tenant_policy_snapshot_ref?: string;
  policy_decision_code?: string;
}

export interface ToolServiceOptions {
  registry?: ToolManifestRegistry;
  auditStore?: AuditStore;
  idempotencyRepository?: IdempotencyRecordRepository;
  toolCallLogStore?: ToolCallLogStore;
  humanTaskStore?: HumanTaskLookupStore;
  tenantPolicySnapshotStore?: TenantPolicySnapshotLookupStore;
  tenantPolicyMode?: 'required' | 'optional';
  adapterDispatcher?: ToolAdapterDispatcher;
}

export class InMemoryToolCallLogStore implements ToolCallLogStore {
  private readonly logs = new Map<string, ToolCallLog>();
  private readonly evaluationReservations = new Map<string, Set<string>>();

  async create(input: ToolCallLogCreateInput): Promise<ToolCallLog> {
    const log = toolCallLogSchema.parse({
      ...input,
      tool_call_id: input.tool_call_id ?? `tool_call_${randomUUID()}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    this.logs.set(log.tool_call_id, log);
    return log;
  }

  async get(toolCallId: string): Promise<ToolCallLog | undefined> {
    return this.logs.get(toolCallId);
  }

  async update(toolCallId: string, input: ToolCallLogUpdateInput): Promise<ToolCallLog | undefined> {
    const existing = this.logs.get(toolCallId);
    if (!existing) {
      return undefined;
    }
    const updated = toolCallLogSchema.parse({
      ...existing,
      ...(input as Record<string, unknown>),
      updated_at: new Date().toISOString(),
    });
    this.logs.set(toolCallId, updated);
    return updated;
  }

  async list(options: ListToolCallLogsOptions = {}): Promise<ToolCallLog[]> {
    return [...this.logs.values()].filter((log) => {
      if (options.tenantId && log.tenant_id !== options.tenantId) {
        return false;
      }
      if (options.taskRunId && log.task_run_id !== options.taskRunId) {
        return false;
      }
      if (options.evaluationRunId && log.evaluation_run_id !== options.evaluationRunId) {
        return false;
      }
      if (options.evaluationCaseId && log.evaluation_case_id !== options.evaluationCaseId) {
        return false;
      }
      if (options.toolName && log.tool_name !== options.toolName) {
        return false;
      }
      if (options.status && log.status !== options.status) {
        return false;
      }
      return true;
    }).slice(options.offset ?? 0, (options.offset ?? 0) + Math.min(Math.max(options.limit ?? 20, 1), 100));
  }

  async reserveEvaluationLogicalCall(
    input: EvaluationToolCallReservationInput,
  ): Promise<EvaluationToolCallReservationResult> {
    const scope = [
      input.tenantId,
      input.evaluationRunId,
      input.evaluationCaseId,
      input.toolName,
    ].join(':');
    const reservations = this.evaluationReservations.get(scope) ?? new Set<string>();
    const alreadyReserved = reservations.has(input.logicalToolCallId);
    if (alreadyReserved) {
      return {
        allowed: true,
        currentCount: reservations.size,
        limit: input.limit,
        alreadyReserved: true,
      };
    }
    if (reservations.size >= input.limit) {
      return {
        allowed: false,
        currentCount: reservations.size,
        limit: input.limit,
        alreadyReserved: false,
      };
    }
    reservations.add(input.logicalToolCallId);
    this.evaluationReservations.set(scope, reservations);
    return {
      allowed: true,
      currentCount: reservations.size,
      limit: input.limit,
      alreadyReserved: false,
    };
  }
}

export class InMemoryHumanTaskLookupStore implements HumanTaskLookupStore {
  private readonly tasks: HumanTask[] = [];

  constructor(initialTasks: HumanTask[] = []) {
    this.tasks = initialTasks.map((task) => humanTaskSchema.parse(task));
  }

  add(task: HumanTask): void {
    this.tasks.push(humanTaskSchema.parse(task));
  }

  async findApprovedForToolCall(input: {
    tenantId: string;
    taskRunId?: string;
    toolCallId: string;
  }): Promise<HumanTask | undefined> {
    return this.tasks.find((task) => {
      if (task.tenant_id !== input.tenantId || task.status !== 'approved') {
        return false;
      }
      if (input.taskRunId && task.task_run_id !== input.taskRunId) {
        return false;
      }
      return task.payload.tool_call_id === input.toolCallId;
    });
  }
}

export class DbHumanTaskLookupStore implements HumanTaskLookupStore {
  constructor(private readonly repository: HumanTaskRepository) {}

  async findApprovedForToolCall(input: {
    tenantId: string;
    taskRunId?: string;
    toolCallId: string;
  }): Promise<HumanTask | undefined> {
    const tasks = input.taskRunId
      ? await this.repository.listByTaskRunId(input.taskRunId, { tenantId: input.tenantId })
      : await this.repository.list({ tenantId: input.tenantId, status: 'approved' });
    return tasks.find((task) => task.status === 'approved' && task.payload.tool_call_id === input.toolCallId);
  }
}

export class ToolService {
  private readonly registry: ToolManifestRegistry;
  private readonly auditStore: AuditStore;
  private readonly idempotencyRepository: IdempotencyRecordRepository | undefined;
  private readonly toolCallLogStore: ToolCallLogStore;
  private readonly humanTaskStore: HumanTaskLookupStore;
  private readonly tenantPolicySnapshotStore: TenantPolicySnapshotLookupStore | undefined;
  private readonly tenantPolicyMode: 'required' | 'optional';
  private readonly adapterDispatcher: ToolAdapterDispatcher;
  private readonly idempotency = new Map<
    string,
    { requestHash: string; response: ToolInvokeResponse | ToolCommitResponse }
  >();

  constructor(options: ToolServiceOptions = {}) {
    this.registry = options.registry ?? new InMemoryToolManifestRegistry();
    this.auditStore = options.auditStore ?? new InMemoryAuditStore();
    this.idempotencyRepository = options.idempotencyRepository;
    this.toolCallLogStore = options.toolCallLogStore ?? new InMemoryToolCallLogStore();
    this.humanTaskStore = options.humanTaskStore ?? new InMemoryHumanTaskLookupStore();
    this.tenantPolicySnapshotStore = options.tenantPolicySnapshotStore;
    this.tenantPolicyMode = options.tenantPolicyMode ?? 'optional';
    this.adapterDispatcher = options.adapterDispatcher ?? new ToolAdapterDispatcher();
  }

  async listTools(tenantId?: string): Promise<ToolManifest[]> {
    return this.registry.list(tenantId);
  }

  async getTool(toolName: string, tenantId?: string): Promise<ToolManifest | undefined> {
    return this.registry.get(toolName, tenantId);
  }

  async listAuditEvents(input: unknown = {}, locale?: unknown) {
    const query = operationAuditQuerySchema.parse(input);
    const options: ListAuditEventsOptions = {
      ...(query.tenant_id ? { tenantId: query.tenant_id } : {}),
      ...(query.task_run_id ? { taskRunId: query.task_run_id } : {}),
      ...(query.tool_name ? { toolName: query.tool_name } : {}),
      ...(query.event_type ? { action: query.event_type } : {}),
      ...(query.start_time ? { startTime: query.start_time } : {}),
      ...(query.end_time ? { endTime: query.end_time } : {}),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    };
    const events = await this.auditStore.list(options);
    return events.map((event) => localizedAuditEvent(event, locale));
  }

  async getToolCall(toolCallId: string): Promise<ToolCallLog | undefined> {
    const toolCall = await this.toolCallLogStore.get(toolCallId);
    return toolCall ? maskToolCall(toolCall) : undefined;
  }

  async listToolCalls(input: unknown = {}): Promise<ToolCallLog[]> {
    const query = toolCallQuerySchema.parse(input);
    const toolCalls = await this.toolCallLogStore.list({
      ...(query.tenant_id ? { tenantId: query.tenant_id } : {}),
      ...(query.task_run_id ? { taskRunId: query.task_run_id } : {}),
      ...(query.tool_name ? { toolName: query.tool_name } : {}),
      ...(query.status ? { status: query.status } : {}),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    return toolCalls.map(maskToolCall);
  }

  async getIdempotencyRecord(idempotencyKey: string) {
    const record = await this.idempotencyRepository?.get(idempotencyKey);
    return record ? maskSensitiveFields(record) : undefined;
  }

  async preview(toolName: string, payload: unknown): Promise<ToolPreviewResponse> {
    const request = toolPreviewRequestSchema.parse({ ...asObject(payload), tool_name: toolName });
    const manifestResult = await this.loadAndValidateManifest(request);
    if ('response' in manifestResult) {
      return toolPreviewResponseSchema.parse({
        tool_call_id: `tool_call_${randomUUID()}`,
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        mode: 'preview',
        status: 'denied',
        policy: manifestResult.policy,
        error: manifestResult.response.error,
        audit_event_id: manifestResult.response.audit_event_id,
        idempotency_key: request.idempotency_key,
      });
    }

    const { manifest } = manifestResult;
    const evaluationPolicy = await this.enforceEvaluationPolicy(request, manifest, 'preview');
    if (evaluationPolicy.decision === 'deny') {
      return toolPreviewResponseSchema.parse({
        tool_call_id: `tool_call_${randomUUID()}`,
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        mode: 'preview',
        status: 'denied',
        policy: evaluationPolicy.policy,
        error: evaluationPolicy.policy.error,
        audit_event_id: (await this.auditDenied(request, 'tool.preview', evaluationPolicy.reasonCode, evaluationPolicy.message)).event_id,
        idempotency_key: request.idempotency_key,
      });
    }
    const tenantPolicy = await this.enforceTenantPolicy(request, manifest, 'preview');
    if (tenantPolicy.decision === 'deny') {
      return toolPreviewResponseSchema.parse({
        tool_call_id: `tool_call_${randomUUID()}`,
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        mode: 'preview',
        status: 'denied',
        policy: tenantPolicy.policy,
        error: tenantPolicy.policy.error,
        audit_event_id: (await this.auditDenied(request, 'tool.preview', tenantPolicy.reasonCode, tenantPolicy.message)).event_id,
        idempotency_key: request.idempotency_key,
      });
    }
    const policy = evaluatePolicy(manifest, 'preview');
    const inputHash = hashJson(request.arguments);
    const preview = buildPreviewPlan(request, manifest);
    const taskRunId = getTaskRunId(request.task_context);
    const workflowId = getWorkflowId(request.task_context);
    const toolCallId = `tool_call_${randomUUID()}`;
    const reservation = await this.reserveEvaluationLogicalCall(request, manifest, 'preview', toolCallId);
    if (reservation.decision === 'deny') {
      return toolPreviewResponseSchema.parse({
        tool_call_id: toolCallId,
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        mode: 'preview',
        status: 'denied',
        policy: reservation.policy,
        error: reservation.policy.error,
        audit_event_id: (await this.auditDenied(request, 'tool.preview', reservation.reasonCode, reservation.message)).event_id,
        idempotency_key: request.idempotency_key,
      });
    }
    const toolCall = await this.toolCallLogStore.create({
      tool_call_id: toolCallId,
      ...(taskRunId ? { task_run_id: taskRunId } : {}),
      ...(workflowId ? { workflow_id: workflowId } : {}),
      tenant_id: request.tenant_id,
      user_id: getUserId(request.user_context),
      tool_name: request.tool_name,
      tool_version: request.tool_version,
      risk_level: manifest.risk_level,
      policy_decision: policy.decision,
      status: policy.decision === 'allow' ? 'previewed' : policy.decision === 'deny' ? 'denied' : 'pending_confirmation',
      mode: 'preview',
      execution_context_type: request.execution_context_type,
      ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
      ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
      ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
      ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
      idempotency_key: request.idempotency_key,
      input_hash: inputHash,
      adapter_type: manifest.adapter.type,
      preview_json: preview,
      ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
      policy_decision_code: policy.reason,
      ...(policy.error?.code ? { error_code: policy.error.code } : {}),
    });

    const auditEvent = await this.appendAuditEvent({
      tenant_id: request.tenant_id,
      actor_id: getUserId(request.user_context),
      action: 'tool.preview',
      target_type: 'tool',
      target_id: request.tool_name,
      result: policy.decision === 'deny' ? 'denied' : policy.decision === 'allow' ? 'allowed' : 'pending',
      reason: policy.reason,
      trace_id: request.request_id,
      payload: {
        tool_call_id: toolCall.tool_call_id,
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        risk_level: manifest.risk_level,
        task_run_id: taskRunId,
        input_hash: inputHash,
        policy_decision: policy.decision,
        execution_context_type: request.execution_context_type,
        ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
        ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
        ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
        ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
        ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
        policy_decision_code: policy.reason,
      },
    });

    return toolPreviewResponseSchema.parse({
      tool_call_id: toolCall.tool_call_id,
      tool_name: request.tool_name,
      tool_version: request.tool_version,
      mode: 'preview',
      status: policy.decision === 'deny' ? 'denied' : policy.decision === 'allow' ? 'allowed' : 'pending_confirmation',
      policy,
      preview,
      ...(policy.error ? { error: policy.error } : {}),
      audit_event_id: auditEvent.event_id,
      idempotency_key: request.idempotency_key,
    });
  }

  async commit(toolName: string, payload: unknown): Promise<ToolCommitResponse> {
    const request = toolCommitRequestSchema.parse({ ...asObject(payload), tool_name: toolName });
    const idempotencyStoreKey = buildIdempotencyStoreKey(request, 'commit');
    const requestHash = hashCommitRequest(request);
    const replay = await this.getIdempotencyReplay(request, idempotencyStoreKey, requestHash);
    if (replay.decision !== 'miss') {
      if (replay.decision === 'conflict') {
        return this.auditAndReturnCommitDenied(request, 'IDEMPOTENCY_CONFLICT', '幂等键已被不同请求使用');
      }
      await this.auditIdempotencyReplay(request);
      return toolCommitResponseSchema.parse({ ...replay.response, status: 'replayed' });
    }

    const manifestResult = await this.loadAndValidateManifest(request);
    if ('response' in manifestResult) {
      return this.commitDeniedFromInvokeDenied(request, manifestResult.response);
    }

    const { manifest } = manifestResult;
    const evaluationPolicy = await this.enforceEvaluationPolicy(request, manifest, 'commit');
    if (evaluationPolicy.decision === 'deny') {
      return this.auditAndReturnCommitDenied(request, evaluationPolicy.reasonCode, evaluationPolicy.message);
    }
    const tenantPolicy = await this.enforceTenantPolicy(request, manifest, 'commit');
    if (tenantPolicy.decision === 'deny') {
      return this.auditAndReturnCommitDenied(request, tenantPolicy.reasonCode, tenantPolicy.message);
    }
    const policy = evaluatePolicy(manifest, 'commit');
    if (policy.decision === 'deny') {
      return this.auditAndReturnCommitDenied(
        request,
        policy.error?.code ?? 'TOOL_POLICY_DENIED',
        policy.error?.message ?? policy.reason,
      );
    }

    const toolCall = await this.toolCallLogStore.get(request.tool_call_id);
    if (!toolCall) {
      return this.auditAndReturnCommitDenied(request, 'TOOL_CALL_NOT_FOUND', 'tool_call_id 不存在');
    }
    if (toolCall.tenant_id !== request.tenant_id || toolCall.tool_name !== request.tool_name) {
      return this.auditAndReturnCommitDenied(request, 'TOOL_CALL_MISMATCH', 'tool_call_id 与请求不匹配');
    }

    const taskRunId = getTaskRunId(request.task_context);
    if (manifest.risk_level === 'L3') {
      const humanTaskLookupInput = {
        tenantId: request.tenant_id,
        toolCallId: request.tool_call_id,
        ...(taskRunId ? { taskRunId } : {}),
      };
      const humanTask = await this.humanTaskStore.findApprovedForToolCall(humanTaskLookupInput);
      if (!humanTask) {
        await this.toolCallLogStore.update(request.tool_call_id, {
          status: 'denied',
          mode: 'commit',
          error_code: 'HUMAN_CONFIRMATION_REQUIRED',
          policy_decision_code: 'HUMAN_CONFIRMATION_REQUIRED',
        });
        return this.auditAndReturnCommitDenied(
          request,
          'HUMAN_CONFIRMATION_REQUIRED',
          'L3 工具提交前需要人工批准',
        );
      }
    }

    const reservation = await this.reserveEvaluationLogicalCall(request, manifest, 'commit', request.tool_call_id);
    if (reservation.decision === 'deny') {
      return this.auditAndReturnCommitDenied(request, reservation.reasonCode, reservation.message);
    }

    try {
      this.adapterDispatcher.assertCommitSupported(manifest);
    } catch (error) {
      const adapterError = error instanceof ToolAdapterError
        ? error
        : new ToolAdapterError('TOOL_ADAPTER_NOT_SUPPORTED', '当前工具 Adapter 不支持 commit');
      await this.toolCallLogStore.update(request.tool_call_id, {
        status: 'denied',
        mode: 'commit',
        error_code: adapterError.code,
        policy_decision_code: adapterError.code,
      });
      return this.auditAndReturnCommitDenied(request, adapterError.code, adapterError.message);
    }

    const startedAt = Date.now();
    const result = await this.adapterDispatcher.invoke({
      manifest,
      arguments: request.arguments,
      requestContext: safeToolContext(request),
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    const outputHash = hashJson(result);
    const updated = await this.toolCallLogStore.update(request.tool_call_id, {
      status: 'committed',
      mode: 'commit',
      execution_context_type: request.execution_context_type,
      ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
      ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
      ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
      ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
      duration_ms: durationMs,
      output_hash: outputHash,
      result_json: result,
      ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
      policy_decision_code: policy.reason,
    });
    if (!updated) {
      return this.auditAndReturnCommitDenied(request, 'TOOL_CALL_NOT_FOUND', 'tool_call_id 不存在');
    }

    const auditEvent = await this.appendAuditEvent({
      tenant_id: request.tenant_id,
      actor_id: getUserId(request.user_context),
      action: 'tool.commit',
      target_type: 'tool',
      target_id: request.tool_name,
      result: 'succeeded',
      reason: manifest.side_effect ? 'side_effect_mock_adapter' : 'readonly_mock_adapter',
      trace_id: request.request_id,
      payload: {
        tool_call_id: request.tool_call_id,
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        task_run_id: taskRunId,
        output_hash: outputHash,
        policy_decision: policy.decision,
        execution_context_type: request.execution_context_type,
        ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
        ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
        ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
        ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
        ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
        policy_decision_code: policy.reason,
      },
    });

    const response = toolCommitResponseSchema.parse({
      tool_call_id: request.tool_call_id,
      tool_name: request.tool_name,
      tool_version: request.tool_version,
      mode: 'commit',
      status: 'committed',
      result,
      audit_event_id: auditEvent.event_id,
      idempotency_key: request.idempotency_key,
    });
    await this.saveIdempotencyRecord(idempotencyStoreKey, request, requestHash, response);
    return response;
  }

  async invoke(toolName: string, payload: unknown): Promise<ToolInvokeResponse> {
    const request = toolInvokeRequestSchema.parse({ ...asObject(payload), tool_name: toolName });
    const idempotencyStoreKey = buildIdempotencyStoreKey(request, 'invoke');
    const requestHash = hashInvokeRequest(request);
    const replay = await this.getIdempotencyReplay(request, idempotencyStoreKey, requestHash);
    if (replay.decision !== 'miss') {
      if (replay.decision === 'conflict') {
        return this.auditAndReturnDenied(request, 'IDEMPOTENCY_CONFLICT', '幂等键已被不同请求使用');
      }

      await this.auditIdempotencyReplay(request);
      return toolInvokeResponseSchema.parse(replay.response);
    }

    const manifestResult = await this.loadAndValidateManifest(request);
    if ('response' in manifestResult) {
      return manifestResult.response;
    }

    const { manifest } = manifestResult;
    const evaluationPolicy = await this.enforceEvaluationPolicy(request, manifest, 'invoke');
    if (evaluationPolicy.decision === 'deny') {
      return this.auditAndReturnDenied(
        request,
        evaluationPolicy.reasonCode,
        evaluationPolicy.message,
        evaluationPolicy.policy,
      );
    }
    const tenantPolicy = await this.enforceTenantPolicy(request, manifest, 'invoke');
    if (tenantPolicy.decision === 'deny') {
      return this.auditAndReturnDenied(
        request,
        tenantPolicy.reasonCode,
        tenantPolicy.message,
        tenantPolicy.policy,
      );
    }
    const policy = evaluatePolicy(manifest, 'commit');
    if (policy.decision === 'deny') {
      return this.auditAndReturnDenied(
        request,
        policy.error?.code ?? 'TOOL_POLICY_DENIED',
        policy.error?.message ?? policy.reason,
        policy,
      );
    }
    if (policy.decision === 'require_human_confirm') {
      const auditEvent = await this.appendAuditEvent({
        tenant_id: request.tenant_id,
        actor_id: getUserId(request.user_context),
        action: 'tool.invoke',
        target_type: 'tool',
        target_id: request.tool_name,
        result: 'pending',
        reason: policy.reason,
        trace_id: request.request_id,
        payload: {
          tool_name: request.tool_name,
          tool_version: request.tool_version,
          risk_level: manifest.risk_level,
          task_run_id: getTaskRunId(request.task_context),
          policy_decision: policy.decision,
          ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
          policy_decision_code: policy.reason,
        },
      });
      return toolInvokeResponseSchema.parse({
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        status: 'needs_confirmation',
        error: { code: 'HUMAN_CONFIRMATION_REQUIRED', message: 'L3 工具必须先 preview 并人工确认后 commit' },
        audit_event_id: auditEvent.event_id,
        idempotency_key: request.idempotency_key,
        policy,
      });
    }

    const toolCallId = `tool_call_${randomUUID()}`;
    const reservation = await this.reserveEvaluationLogicalCall(request, manifest, 'invoke', toolCallId);
    if (reservation.decision === 'deny') {
      return this.auditAndReturnDenied(
        request,
        reservation.reasonCode,
        reservation.message,
        reservation.policy,
      );
    }

    const inputHash = hashJson(request.arguments);
    const taskRunId = getTaskRunId(request.task_context);
    const workflowId = getWorkflowId(request.task_context);
    const startedAt = Date.now();
    let result: unknown;
    try {
      result = await this.adapterDispatcher.invoke({
        manifest,
        arguments: request.arguments,
        requestContext: safeToolContext(request),
      });
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const adapterError = error instanceof ToolAdapterError
        ? error
        : new ToolAdapterError('TOOL_FAILED', '工具 Adapter 执行失败');
      const toolCall = await this.toolCallLogStore.create({
        tool_call_id: toolCallId,
        ...(taskRunId ? { task_run_id: taskRunId } : {}),
        ...(workflowId ? { workflow_id: workflowId } : {}),
        tenant_id: request.tenant_id,
        user_id: getUserId(request.user_context),
        tool_name: toolName,
        tool_version: request.tool_version,
        risk_level: manifest.risk_level,
        policy_decision: 'deny',
        status: isAdapterDenyCode(adapterError.code) ? 'denied' : 'failed',
        mode: 'commit',
        execution_context_type: request.execution_context_type,
        ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
        ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
        ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
        ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
        duration_ms: durationMs,
        idempotency_key: request.idempotency_key,
        input_hash: inputHash,
        adapter_type: manifest.adapter.type,
        error_code: adapterError.code,
        ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
        policy_decision_code: adapterError.code,
      });
      return this.auditAndReturnAdapterFailure(request, toolCall.tool_call_id, adapterError);
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    const outputHash = hashJson(result);
    const toolCall = await this.toolCallLogStore.create({
      tool_call_id: toolCallId,
      ...(taskRunId ? { task_run_id: taskRunId } : {}),
      ...(workflowId ? { workflow_id: workflowId } : {}),
      tenant_id: request.tenant_id,
      user_id: getUserId(request.user_context),
      tool_name: toolName,
      tool_version: request.tool_version,
      risk_level: manifest.risk_level,
      policy_decision: policy.decision,
      status: 'committed',
      mode: 'commit',
      execution_context_type: request.execution_context_type,
      ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
      ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
      ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
      ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
      duration_ms: durationMs,
      idempotency_key: request.idempotency_key,
      input_hash: inputHash,
      output_hash: outputHash,
      adapter_type: manifest.adapter.type,
      result_json: result,
      ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
      policy_decision_code: policy.reason,
    });
    const auditEvent = await this.appendAuditEvent({
      tenant_id: request.tenant_id,
      actor_id: getUserId(request.user_context),
      action: 'tool.invoke',
      target_type: 'tool',
      target_id: toolName,
      result: 'succeeded',
      reason: manifest.side_effect ? 'side_effect_mock_adapter' : 'readonly_mock_adapter',
      trace_id: request.request_id,
      payload: {
        tool_name: toolName,
        tool_version: request.tool_version,
        risk_level: request.risk_level ?? manifest.risk_level,
        tool_call_id: toolCall.tool_call_id,
        task_run_id: taskRunId,
        input_hash: inputHash,
        output_hash: outputHash,
        policy_decision: policy.decision,
        execution_context_type: request.execution_context_type,
        ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
        ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
        ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
        ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
        ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
        policy_decision_code: policy.reason,
      },
    });

    const response = toolInvokeResponseSchema.parse({
      tool_name: toolName,
      tool_version: request.tool_version,
      status: 'succeeded',
      result,
      tool_call_id: toolCall.tool_call_id,
      audit_event_id: auditEvent.event_id,
      idempotency_key: request.idempotency_key,
      policy,
    });
    await this.saveIdempotencyRecord(idempotencyStoreKey, request, requestHash, response);
    return response;
  }

  private async loadAndValidateManifest(
    request: ToolInvokeRequest | ToolPreviewRequest | ToolCommitRequest,
  ): Promise<
    | { manifest: ToolManifest }
    | { response: ToolInvokeResponse; policy: PolicyEvaluationResult }
  > {
    const manifest = await this.registry.get(request.tool_name, request.tenant_id, request.tool_version);
    if (!manifest) {
      return {
        response: await this.auditAndReturnDenied(request, 'TOOL_NOT_FOUND', '工具未注册'),
        policy: deniedPolicy(requestRiskLevel(request), 'TOOL_NOT_FOUND', '工具未注册'),
      };
    }

    if (manifest.version !== request.tool_version) {
      return {
        response: await this.auditAndReturnDenied(request, 'TOOL_VERSION_NOT_FOUND', '工具版本不存在'),
        policy: deniedPolicy(manifest.risk_level, 'TOOL_VERSION_NOT_FOUND', '工具版本不存在'),
      };
    }

    if (request.tool_sha256 && manifest.sha256 && manifest.sha256 !== request.tool_sha256) {
      return {
        response: await this.auditAndReturnDenied(request, 'TOOL_HASH_MISMATCH', '工具版本哈希与执行计划不一致'),
        policy: deniedPolicy(manifest.risk_level, 'TOOL_HASH_MISMATCH', '工具版本哈希与执行计划不一致'),
      };
    }

    if ('risk_level' in request && request.risk_level && request.risk_level !== manifest.risk_level) {
      return {
        response: await this.auditAndReturnDenied(request, 'TOOL_RISK_MISMATCH', '工具风险等级与 Tool Gateway 注册表不一致'),
        policy: deniedPolicy(manifest.risk_level, 'TOOL_RISK_MISMATCH', '工具风险等级与 Tool Gateway 注册表不一致'),
      };
    }

    try {
      validateArguments(manifest, request.arguments);
    } catch (error) {
      const message = error instanceof Error ? error.message : '工具参数不合法';
      return {
        response: await this.auditAndReturnDenied(request, 'TOOL_ARGUMENT_VALIDATION_FAILED', message),
        policy: deniedPolicy(manifest.risk_level, 'TOOL_ARGUMENT_VALIDATION_FAILED', message),
      };
    }

    return { manifest };
  }

  private async enforceEvaluationPolicy(
    request: ToolInvokeRequest | ToolPreviewRequest | ToolCommitRequest,
    manifest: ToolManifest,
    operation: 'invoke' | 'preview' | 'commit',
  ): Promise<{ decision: 'allow' } | { decision: 'deny'; reasonCode: string; message: string; policy: PolicyEvaluationResult }> {
    if (request.execution_context_type !== 'evaluation') {
      return { decision: 'allow' };
    }
    const policy = manifest.evaluation_policy ?? {
      allowed_in_evaluation: false,
      mode: 'deny' as const,
      allowed_tenants: [],
      result_redaction_policy: 'mask_sensitive' as const,
    };
    if (!policy.allowed_in_evaluation || policy.mode === 'deny') {
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_DENIED_BY_EVALUATION_POLICY', 'Tool is not allowed in evaluation context');
    }
    const allowedTenants = policy.allowed_tenants ?? [];
    if (allowedTenants.length > 0 && !allowedTenants.includes(request.tenant_id)) {
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_DENIED_BY_EVALUATION_POLICY', 'Tenant is not allowed to use this tool in evaluation');
    }
    if (policy.mode === 'preview_only' && operation !== 'preview') {
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_EVALUATION_PREVIEW_ONLY', 'Tool evaluation policy allows preview only');
    }
    if (policy.mode === 'sandbox_commit' && manifest.adapter.type !== 'mock') {
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_EVALUATION_SANDBOX_REQUIRED', 'Evaluation sandbox commit requires a mock adapter');
    }
    if (!request.evaluation_run_id || !request.evaluation_case_id || !request.evaluation_execution_plan_ref || !request.evaluation_execution_plan_hash) {
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_EVALUATION_CONTEXT_REQUIRED', 'Evaluation tool calls require run, case and execution plan identity');
    }
    return { decision: 'allow' };
  }

  private async reserveEvaluationLogicalCall(
    request: ToolInvokeRequest | ToolPreviewRequest | ToolCommitRequest,
    manifest: ToolManifest,
    operation: 'invoke' | 'preview' | 'commit',
    logicalToolCallId: string,
  ): Promise<{ decision: 'allow' } | { decision: 'deny'; reasonCode: string; message: string; policy: PolicyEvaluationResult }> {
    if (request.execution_context_type !== 'evaluation') {
      return { decision: 'allow' };
    }
    const policy = manifest.evaluation_policy ?? {
      allowed_in_evaluation: false,
      mode: 'deny' as const,
      allowed_tenants: [],
      result_redaction_policy: 'mask_sensitive' as const,
    };
    if (policy.maximum_calls_per_case === undefined) {
      return { decision: 'allow' };
    }
    if (!request.evaluation_run_id || !request.evaluation_case_id) {
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_EVALUATION_CONTEXT_REQUIRED', 'Evaluation tool calls require run and case identity');
    }
    if (!this.toolCallLogStore.reserveEvaluationLogicalCall) {
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_EVALUATION_RESERVATION_UNAVAILABLE', 'Evaluation tool call reservation store is unavailable');
    }
    const reservation = await this.toolCallLogStore.reserveEvaluationLogicalCall({
      tenantId: request.tenant_id,
      evaluationRunId: request.evaluation_run_id,
      evaluationCaseId: request.evaluation_case_id,
      toolName: request.tool_name,
      toolVersion: request.tool_version,
      logicalToolCallId,
      operation,
      limit: policy.maximum_calls_per_case,
      ...(request.idempotency_key ? { idempotencyKey: request.idempotency_key } : {}),
    });
    if (!reservation.allowed) {
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_EVALUATION_CALL_LIMIT_EXCEEDED', 'Evaluation tool call limit exceeded for this case');
    }
    return { decision: 'allow' };
  }

  private async enforceTenantPolicy(
    request: ToolInvokeRequest | ToolPreviewRequest | ToolCommitRequest,
    manifest: ToolManifest,
    operation: 'invoke' | 'preview' | 'commit',
  ): Promise<{ decision: 'allow' } | { decision: 'deny'; reasonCode: string; message: string; policy: PolicyEvaluationResult }> {
    if (!request.tenant_policy_snapshot_ref) {
      if (this.tenantPolicyMode === 'required') {
        return tenantPolicyDenied(manifest.risk_level, 'TENANT_RUNTIME_POLICY_NOT_FOUND', 'Tenant policy snapshot is required');
      }
      return { decision: 'allow' };
    }
    if (!request.tenant_policy_hash || !request.execution_plan_ref || !request.execution_plan_hash) {
      return tenantPolicyDenied(manifest.risk_level, 'TENANT_POLICY_SNAPSHOT_CONTEXT_MISSING', 'Tenant policy snapshot hash and execution plan identity are required');
    }
    if (!this.tenantPolicySnapshotStore) {
      return tenantPolicyDenied(manifest.risk_level, 'TENANT_POLICY_SNAPSHOT_STORE_UNAVAILABLE', 'Tenant policy snapshot store is unavailable');
    }

    const snapshot = await this.tenantPolicySnapshotStore.getByRef(request.tenant_policy_snapshot_ref, {
      tenantId: request.tenant_id,
    });
    if (!snapshot) {
      return tenantPolicyDenied(manifest.risk_level, 'TENANT_RUNTIME_POLICY_NOT_FOUND', 'Tenant policy snapshot not found');
    }

    try {
      assertSnapshotAllowsTool({
        snapshot,
        tenantId: request.tenant_id,
        snapshotHash: request.tenant_policy_hash,
        executionPlanRef: request.execution_plan_ref,
        executionPlanHash: request.execution_plan_hash,
        toolName: request.tool_name,
        toolVersion: request.tool_version,
        operation,
        riskLevel: manifest.risk_level,
      });
      return { decision: 'allow' };
    } catch (error) {
      if (error instanceof TenantRuntimePolicyError) {
        return tenantPolicyDenied(manifest.risk_level, error.code, error.message);
      }
      return tenantPolicyDenied(manifest.risk_level, 'TOOL_DENIED_BY_TENANT_POLICY', 'Tool denied by tenant policy');
    }
  }

  private async auditDenied(
    request: ToolInvokeRequest | ToolPreviewRequest | ToolCommitRequest,
    action: 'tool.invoke' | 'tool.preview' | 'tool.commit',
    code: string,
    message: string,
  ) {
    return this.appendAuditEvent({
      tenant_id: request.tenant_id,
      actor_id: getUserId(request.user_context),
      action,
      target_type: 'tool',
      target_id: request.tool_name,
      result: 'denied',
      reason: code,
      trace_id: request.request_id,
      payload: {
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        ...(request.tool_sha256 ? { tool_sha256: request.tool_sha256 } : {}),
        task_run_id: getTaskRunId(request.task_context),
        execution_context_type: request.execution_context_type,
        ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
        ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
        ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
        ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
        ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
        ...(request.tenant_policy_hash ? { tenant_policy_hash: request.tenant_policy_hash } : {}),
        ...(request.execution_plan_ref ? { execution_plan_ref: request.execution_plan_ref } : {}),
        ...(request.execution_plan_hash ? { execution_plan_hash: request.execution_plan_hash } : {}),
        policy_decision_code: code,
        message,
      },
    });
  }

  private async auditAndReturnDenied(
    request: ToolInvokeRequest | ToolPreviewRequest | ToolCommitRequest,
    code: string,
    message: string,
    policy = deniedPolicy(requestRiskLevel(request), code, message),
  ): Promise<ToolInvokeResponse> {
    const auditEvent = await this.appendAuditEvent({
      tenant_id: request.tenant_id,
      actor_id: getUserId(request.user_context),
      action: 'tool.invoke',
      target_type: 'tool',
      target_id: request.tool_name,
      result: 'denied',
      reason: code,
      trace_id: request.request_id,
      payload: {
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        ...(request.tool_sha256 ? { tool_sha256: request.tool_sha256 } : {}),
        task_run_id: getTaskRunId(request.task_context),
        execution_context_type: request.execution_context_type,
        ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
        ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
        ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
        ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
        ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
        ...(request.tenant_policy_hash ? { tenant_policy_hash: request.tenant_policy_hash } : {}),
        ...(request.execution_plan_ref ? { execution_plan_ref: request.execution_plan_ref } : {}),
        ...(request.execution_plan_hash ? { execution_plan_hash: request.execution_plan_hash } : {}),
        policy_decision_code: code,
      },
    });

    return toolInvokeResponseSchema.parse({
      tool_name: request.tool_name,
      tool_version: request.tool_version,
      status: 'denied',
      error: { code, message },
      audit_event_id: auditEvent.event_id,
      idempotency_key: request.idempotency_key,
      policy,
    });
  }

  private async auditAndReturnAdapterFailure(
    request: ToolInvokeRequest,
    toolCallId: string,
    error: ToolAdapterError,
  ): Promise<ToolInvokeResponse> {
    const policy = deniedPolicy(requestRiskLevel(request), error.code, error.message);
    const auditEvent = await this.appendAuditEvent({
      tenant_id: request.tenant_id,
      actor_id: getUserId(request.user_context),
      action: 'tool.invoke',
      target_type: 'tool',
      target_id: request.tool_name,
      result: isAdapterDenyCode(error.code) ? 'denied' : 'failed',
      reason: error.code,
      trace_id: request.request_id,
      payload: {
        tool_call_id: toolCallId,
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        ...(request.tool_sha256 ? { tool_sha256: request.tool_sha256 } : {}),
        task_run_id: getTaskRunId(request.task_context),
        execution_context_type: request.execution_context_type,
        ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
        ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
        ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
        ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
        ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
        policy_decision_code: error.code,
      },
    });

    return toolInvokeResponseSchema.parse({
      tool_name: request.tool_name,
      tool_version: request.tool_version,
      status: isAdapterDenyCode(error.code) ? 'denied' : 'failed',
      error: { code: error.code, message: error.message },
      tool_call_id: toolCallId,
      audit_event_id: auditEvent.event_id,
      idempotency_key: request.idempotency_key,
      policy,
    });
  }

  private async auditAndReturnCommitDenied(
    request: ToolCommitRequest,
    code: string,
    message: string,
  ): Promise<ToolCommitResponse> {
    const auditEvent = await this.appendAuditEvent({
      tenant_id: request.tenant_id,
      actor_id: getUserId(request.user_context),
      action: 'tool.commit',
      target_type: 'tool',
      target_id: request.tool_name,
      result: 'denied',
      reason: code,
      trace_id: request.request_id,
      payload: {
        tool_call_id: request.tool_call_id,
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        ...(request.tool_sha256 ? { tool_sha256: request.tool_sha256 } : {}),
        task_run_id: getTaskRunId(request.task_context),
        ...(request.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: request.tenant_policy_snapshot_ref } : {}),
        ...(request.tenant_policy_hash ? { tenant_policy_hash: request.tenant_policy_hash } : {}),
        ...(request.execution_plan_ref ? { execution_plan_ref: request.execution_plan_ref } : {}),
        ...(request.execution_plan_hash ? { execution_plan_hash: request.execution_plan_hash } : {}),
        policy_decision_code: code,
      },
    });

    return toolCommitResponseSchema.parse({
      tool_call_id: request.tool_call_id,
      tool_name: request.tool_name,
      tool_version: request.tool_version,
      mode: 'commit',
      status: 'denied',
      error: { code, message },
      audit_event_id: auditEvent.event_id,
      idempotency_key: request.idempotency_key,
    });
  }

  private commitDeniedFromInvokeDenied(
    request: ToolCommitRequest,
    denied: ToolInvokeResponse,
  ): ToolCommitResponse {
    return toolCommitResponseSchema.parse({
      tool_call_id: request.tool_call_id,
      tool_name: request.tool_name,
      tool_version: request.tool_version,
      mode: 'commit',
      status: 'denied',
      error: denied.error,
      audit_event_id: denied.audit_event_id,
      idempotency_key: request.idempotency_key,
    });
  }

  private async auditIdempotencyReplay(request: ToolInvokeRequest | ToolCommitRequest): Promise<void> {
    await this.appendAuditEvent({
      tenant_id: request.tenant_id,
      actor_id: getUserId(request.user_context),
      action: 'tool.idempotency_replay',
      target_type: 'tool',
      target_id: request.tool_name,
      result: 'succeeded',
      reason: 'idempotency_replay',
      trace_id: request.request_id,
      payload: {
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        ...(request.tool_sha256 ? { tool_sha256: request.tool_sha256 } : {}),
        task_run_id: getTaskRunId(request.task_context),
        execution_context_type: request.execution_context_type,
        ...(request.evaluation_run_id ? { evaluation_run_id: request.evaluation_run_id } : {}),
        ...(request.evaluation_case_id ? { evaluation_case_id: request.evaluation_case_id } : {}),
        ...(request.evaluation_execution_plan_ref ? { evaluation_execution_plan_ref: request.evaluation_execution_plan_ref } : {}),
        ...(request.evaluation_execution_plan_hash ? { evaluation_execution_plan_hash: request.evaluation_execution_plan_hash } : {}),
        idempotency_key: request.idempotency_key,
      },
    });
  }

  private appendAuditEvent(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): AuditEvent | Promise<AuditEvent> {
    const messageParams = auditMessageParams(event);
    const messageKey = event.message_key ?? messageKeyForAuditEvent(event.action);
    return this.auditStore.append({
      ...event,
      message_key: messageKey,
      message_params: event.message_params ?? messageParams,
      payload: {
        ...event.payload,
        message_key: messageKey,
        message_params: messageParams,
      },
    });
  }

  private async getIdempotencyReplay(
    request: ToolInvokeRequest | ToolCommitRequest,
    idempotencyStoreKey: string,
    requestHash: string,
  ): Promise<
    | { decision: 'miss' }
    | { decision: 'conflict' }
    | { decision: 'replay'; response: ToolInvokeResponse | ToolCommitResponse }
  > {
    if (this.idempotencyRepository) {
      const decision = await this.idempotencyRepository.replayOrConflict({
        idempotencyKey: idempotencyStoreKey,
        tenantId: request.tenant_id,
        targetType: 'tool',
        targetId: request.tool_name,
        requestHash,
      });

      if (decision.decision === 'miss') {
        return { decision: 'miss' };
      }
      if (decision.decision === 'conflict') {
        return { decision: 'conflict' };
      }

      return {
        decision: 'replay',
        response: decision.record.response_json as ToolInvokeResponse | ToolCommitResponse,
      };
    }

    const replay = this.idempotency.get(idempotencyStoreKey);
    if (!replay) {
      return { decision: 'miss' };
    }
    if (replay.requestHash !== requestHash) {
      return { decision: 'conflict' };
    }
    return { decision: 'replay', response: replay.response };
  }

  private async saveIdempotencyRecord(
    idempotencyStoreKey: string,
    request: ToolInvokeRequest | ToolCommitRequest,
    requestHash: string,
    response: ToolInvokeResponse | ToolCommitResponse,
  ): Promise<void> {
    if (this.idempotencyRepository) {
      await this.idempotencyRepository.insert({
        idempotency_key: idempotencyStoreKey,
        tenant_id: request.tenant_id,
        target_type: 'tool',
        target_id: request.tool_name,
        request_hash: requestHash,
        response_json: response,
        status: response.status === 'succeeded' || response.status === 'committed' ? 'succeeded' : 'failed',
      });
      return;
    }

    this.idempotency.set(idempotencyStoreKey, { requestHash, response });
  }
}

function evaluatePolicy(manifest: ToolManifest, mode: 'invoke' | 'preview' | 'commit'): PolicyEvaluationResult {
  if (manifest.risk_level === 'L4') {
    return deniedPolicy('L4', 'TOOL_RISK_L4_DENIED', 'L4 工具默认拒绝');
  }

  if (manifest.risk_level === 'L3') {
    return {
      decision: 'require_human_confirm',
      risk_level: 'L3',
      reason: 'side_effect_requires_human_confirm',
      requires_human_confirm: true,
    };
  }

  return {
    decision: 'allow',
    risk_level: manifest.risk_level,
    reason: mode === 'preview' ? 'preview_allowed' : 'policy_allowed',
    requires_human_confirm: false,
  };
}

function deniedPolicy(
  riskLevel: PolicyEvaluationResult['risk_level'],
  code: string,
  message: string,
): PolicyEvaluationResult {
  return {
    decision: 'deny',
    risk_level: riskLevel,
    reason: code,
    requires_human_confirm: false,
    error: { code, message },
  };
}

function tenantPolicyDenied(
  riskLevel: PolicyEvaluationResult['risk_level'],
  code: string,
  message: string,
): { decision: 'deny'; reasonCode: string; message: string; policy: PolicyEvaluationResult } {
  return {
    decision: 'deny',
    reasonCode: code,
    message,
    policy: deniedPolicy(riskLevel, code, message),
  };
}

function requestRiskLevel(request: ToolInvokeRequest | ToolPreviewRequest | ToolCommitRequest): PolicyEvaluationResult['risk_level'] {
  return 'risk_level' in request && request.risk_level ? request.risk_level : 'L4';
}

function buildPreviewPlan(request: ToolPreviewRequest, manifest: ToolManifest): Record<string, unknown> {
  return {
    planned: true,
    side_effect: manifest.side_effect,
    tool_name: request.tool_name,
    tool_version: request.tool_version,
    risk_level: manifest.risk_level,
    arguments: request.arguments,
  };
}

function maskToolCall(toolCall: ToolCallLog): ToolCallLog {
  return toolCallLogSchema.parse({
    ...toolCall,
    preview_json: toolCall.preview_json === undefined ? undefined : maskSensitiveFields(toolCall.preview_json),
    result_json: toolCall.result_json === undefined ? undefined : maskSensitiveFields(toolCall.result_json),
  });
}

function localizedAuditEvent(event: AuditEvent, locale?: unknown): AuditEvent {
  const payload = maskSensitiveFields(event.payload) as Record<string, unknown>;
  const messageParams = isRecord(event.message_params)
    ? safeParams(event.message_params)
    : isRecord(payload.message_params)
      ? safeParams(payload.message_params)
      : auditMessageParams(event);
  const messageKey = event.message_key ?? stringValue(payload.message_key) ?? messageKeyForAuditEvent(event.action);
  const display = localizeAuditEvent(event.action, messageParams, locale);
  return {
    ...event,
    message_key: messageKey,
    message_params: messageParams,
    display_message: display.display_message,
    locale: display.locale,
    payload,
  };
}

function auditMessageParams(event: Pick<AuditEvent, 'target_id' | 'reason' | 'payload'>): SafeTranslationParams {
  return safeParams({
    targetId: event.target_id,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(typeof event.payload.tool_name === 'string' ? { toolName: event.payload.tool_name } : {}),
    ...(typeof event.payload.tool_version === 'string' ? { toolVersion: event.payload.tool_version } : {}),
    ...(typeof event.payload.task_run_id === 'string' ? { taskRunId: event.payload.task_run_id } : {}),
  });
}

function safeParams(value: Record<string, unknown>): SafeTranslationParams {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/password|secret|token|authorization|cookie|api[_-]?key/iu.test(key))
      .filter(([, nested]) => ['string', 'number', 'boolean'].includes(typeof nested))
      .map(([key, nested]) => [key, nested as string | number | boolean]),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function buildIdempotencyStoreKey(request: ToolInvokeRequest | ToolCommitRequest, mode: 'invoke' | 'commit'): string {
  return `${request.tenant_id}:${request.tool_name}:${mode}:${request.idempotency_key}`;
}

function hashInvokeRequest(request: ToolInvokeRequest): string {
  return hashJson({
    mode: 'invoke',
    tenant_id: request.tenant_id,
    tool_name: request.tool_name,
    tool_version: request.tool_version,
    tool_sha256: request.tool_sha256,
    user_context: request.user_context,
    task_context: request.task_context,
    arguments: request.arguments,
    risk_level: request.risk_level,
    execution_context_type: request.execution_context_type,
    evaluation_run_id: request.evaluation_run_id,
    evaluation_case_id: request.evaluation_case_id,
    evaluation_execution_plan_ref: request.evaluation_execution_plan_ref,
    evaluation_execution_plan_hash: request.evaluation_execution_plan_hash,
  });
}

function hashCommitRequest(request: ToolCommitRequest): string {
  return hashJson({
    mode: 'commit',
    tool_call_id: request.tool_call_id,
    tenant_id: request.tenant_id,
    tool_name: request.tool_name,
    tool_version: request.tool_version,
    tool_sha256: request.tool_sha256,
    user_context: request.user_context,
    task_context: request.task_context,
    arguments: request.arguments,
    execution_context_type: request.execution_context_type,
    evaluation_run_id: request.evaluation_run_id,
    evaluation_case_id: request.evaluation_case_id,
    evaluation_execution_plan_ref: request.evaluation_execution_plan_ref,
    evaluation_execution_plan_hash: request.evaluation_execution_plan_hash,
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
    );
  }

  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function safeToolContext(request: ToolInvokeRequest | ToolCommitRequest): {
  request_id?: string;
  tenant_id: string;
  user_id?: string;
  task_run_id?: string;
  workflow_id?: string;
  tool_name: string;
} {
  const userId = getUserId(request.user_context);
  const taskRunId = getTaskRunId(request.task_context);
  const workflowId = getWorkflowId(request.task_context);
  return {
    ...(request.request_id ? { request_id: request.request_id } : {}),
    tenant_id: request.tenant_id,
    ...(userId ? { user_id: userId } : {}),
    ...(taskRunId ? { task_run_id: taskRunId } : {}),
    ...(workflowId ? { workflow_id: workflowId } : {}),
    tool_name: request.tool_name,
  };
}

function isAdapterDenyCode(code: string): boolean {
  return code === 'TOOL_ADAPTER_NOT_SUPPORTED'
    || code === 'TOOL_HTTP_HOST_NOT_ALLOWED'
    || code === 'TOOL_HTTP_INSECURE_URL'
    || code === 'TOOL_HTTP_SECRET_NOT_CONFIGURED'
    || code === 'TOOL_HTTP_OUTPUT_SCHEMA_INVALID'
    || code === 'TOOL_ARGUMENT_VALIDATION_FAILED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getUserId(userContext: Record<string, unknown>): string {
  return String(userContext.user_id ?? userContext.userId ?? 'unknown');
}

function getTaskRunId(taskContext: Record<string, unknown>): string | undefined {
  const value = taskContext.task_run_id ?? taskContext.taskRunId;
  return typeof value === 'string' ? value : undefined;
}

function getWorkflowId(taskContext: Record<string, unknown>): string | undefined {
  const value = taskContext.workflow_id ?? taskContext.workflowId;
  return typeof value === 'string' ? value : undefined;
}
