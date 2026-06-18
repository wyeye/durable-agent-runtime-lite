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
} from '@dar/contracts';
import { maskSensitiveFields } from '@dar/security';
import {
  HumanTaskRepository,
  IdempotencyRecordRepository,
  type ListAuditEventsOptions,
  type ListToolCallLogsOptions,
  type ToolCallLogCreateInput,
} from '@dar/db';
import { InMemoryAuditStore, type AuditStore } from './audit.js';
import { invokeMockAdapter } from './mock-adapter.js';
import { validateArguments } from './schema-validator.js';
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
}

export interface ToolCallLogUpdateInput {
  status?: ToolCallLog['status'];
  policy_decision?: ToolPolicyDecision;
  mode?: 'preview' | 'commit';
  duration_ms?: number;
  output_hash?: string;
  error_code?: string;
  preview_json?: unknown;
  result_json?: unknown;
}

export interface ToolServiceOptions {
  registry?: ToolManifestRegistry;
  auditStore?: AuditStore;
  idempotencyRepository?: IdempotencyRecordRepository;
  toolCallLogStore?: ToolCallLogStore;
  humanTaskStore?: HumanTaskLookupStore;
}

export class InMemoryToolCallLogStore implements ToolCallLogStore {
  private readonly logs = new Map<string, ToolCallLog>();

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
      if (options.toolName && log.tool_name !== options.toolName) {
        return false;
      }
      if (options.status && log.status !== options.status) {
        return false;
      }
      return true;
    }).slice(options.offset ?? 0, (options.offset ?? 0) + Math.min(Math.max(options.limit ?? 20, 1), 100));
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
  }

  async listTools(tenantId?: string): Promise<ToolManifest[]> {
    return this.registry.list(tenantId);
  }

  async getTool(toolName: string, tenantId?: string): Promise<ToolManifest | undefined> {
    return this.registry.get(toolName, tenantId);
  }

  async listAuditEvents(input: unknown = {}) {
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
    return events.map((event) => ({
      ...event,
      payload: maskSensitiveFields(event.payload) as Record<string, unknown>,
    }));
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
    return this.idempotencyRepository?.get(idempotencyKey);
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
    const policy = evaluatePolicy(manifest, 'preview');
    const inputHash = hashJson(request.arguments);
    const preview = buildPreviewPlan(request, manifest);
    const taskRunId = getTaskRunId(request.task_context);
    const workflowId = getWorkflowId(request.task_context);
    const toolCall = await this.toolCallLogStore.create({
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
      idempotency_key: request.idempotency_key,
      input_hash: inputHash,
      adapter_type: manifest.adapter.type,
      preview_json: preview,
      ...(policy.error?.code ? { error_code: policy.error.code } : {}),
    });

    const auditEvent = await this.auditStore.append({
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
        });
        return this.auditAndReturnCommitDenied(
          request,
          'HUMAN_CONFIRMATION_REQUIRED',
          'L3 工具提交前需要人工批准',
        );
      }
    }

    const startedAt = Date.now();
    const result = await invokeMockAdapter({ toolName: request.tool_name, args: request.arguments });
    const durationMs = Math.max(0, Date.now() - startedAt);
    const outputHash = hashJson(result);
    const updated = await this.toolCallLogStore.update(request.tool_call_id, {
      status: 'committed',
      mode: 'commit',
      duration_ms: durationMs,
      output_hash: outputHash,
      result_json: result,
    });
    if (!updated) {
      return this.auditAndReturnCommitDenied(request, 'TOOL_CALL_NOT_FOUND', 'tool_call_id 不存在');
    }

    const auditEvent = await this.auditStore.append({
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
      const auditEvent = await this.auditStore.append({
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

    const result = await invokeMockAdapter({ toolName, args: request.arguments });
    const auditEvent = await this.auditStore.append({
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
        task_run_id: getTaskRunId(request.task_context),
        input_hash: hashJson(request.arguments),
        output_hash: hashJson(result),
        policy_decision: policy.decision,
      },
    });

    const response = toolInvokeResponseSchema.parse({
      tool_name: toolName,
      tool_version: request.tool_version,
      status: 'succeeded',
      result,
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

  private async auditAndReturnDenied(
    request: ToolInvokeRequest | ToolPreviewRequest | ToolCommitRequest,
    code: string,
    message: string,
    policy = deniedPolicy(requestRiskLevel(request), code, message),
  ): Promise<ToolInvokeResponse> {
    const auditEvent = await this.auditStore.append({
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

  private async auditAndReturnCommitDenied(
    request: ToolCommitRequest,
    code: string,
    message: string,
  ): Promise<ToolCommitResponse> {
    const auditEvent = await this.auditStore.append({
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
    await this.auditStore.append({
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
        idempotency_key: request.idempotency_key,
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
