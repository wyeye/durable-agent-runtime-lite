import { createHash } from 'node:crypto';
import {
  toolInvokeRequestSchema,
  toolInvokeResponseSchema,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
  type ToolManifest,
} from '@dar/contracts';
import { IdempotencyRecordRepository } from '@dar/db';
import { InMemoryAuditStore, type AuditStore } from './audit.js';
import { invokeMockAdapter } from './mock-adapter.js';
import { validateArguments } from './schema-validator.js';
import { InMemoryToolManifestRegistry, type ToolManifestRegistry } from './tool-registry.js';

export interface ToolServiceOptions {
  registry?: ToolManifestRegistry;
  auditStore?: AuditStore;
  idempotencyRepository?: IdempotencyRecordRepository;
}

export class ToolService {
  private readonly registry: ToolManifestRegistry;
  private readonly auditStore: AuditStore;
  private readonly idempotencyRepository: IdempotencyRecordRepository | undefined;
  private readonly idempotency = new Map<
    string,
    { requestHash: string; response: ToolInvokeResponse }
  >();

  constructor(options: ToolServiceOptions = {}) {
    this.registry = options.registry ?? new InMemoryToolManifestRegistry();
    this.auditStore = options.auditStore ?? new InMemoryAuditStore();
    this.idempotencyRepository = options.idempotencyRepository;
  }

  async listTools(tenantId?: string): Promise<ToolManifest[]> {
    return this.registry.list(tenantId);
  }

  async getTool(toolName: string, tenantId?: string): Promise<ToolManifest | undefined> {
    return this.registry.get(toolName, tenantId);
  }

  async listAuditEvents() {
    return this.auditStore.list();
  }

  async invoke(toolName: string, payload: unknown): Promise<ToolInvokeResponse> {
    const requestPayload = payload && typeof payload === 'object' ? payload : {};
    const request = toolInvokeRequestSchema.parse({ ...requestPayload, tool_name: toolName });
    const idempotencyStoreKey = buildIdempotencyStoreKey(request);
    const requestHash = hashIdempotencyRequest(request);
    const replay = await this.getIdempotencyReplay(request, idempotencyStoreKey, requestHash);
    if (replay.decision !== 'miss') {
      if (replay.decision === 'conflict') {
        return this.auditAndReturnDenied(request, 'IDEMPOTENCY_CONFLICT', '幂等键已被不同请求使用');
      }

      await this.auditStore.append({
        tenant_id: request.tenant_id,
        actor_id: String(request.user_context.user_id ?? request.user_context.userId ?? 'unknown'),
        action: 'tool.invoke',
        target_type: 'tool',
        target_id: toolName,
        result: 'succeeded',
        reason: 'idempotency_replay',
        trace_id: request.request_id,
        payload: {
          tool_name: toolName,
          tool_version: request.tool_version,
          task_run_id: request.task_context.task_run_id,
          idempotency_key: request.idempotency_key,
        },
      });
      return toolInvokeResponseSchema.parse(replay.response);
    }

    const manifest = await this.registry.get(toolName, request.tenant_id);
    if (!manifest) {
      return this.auditAndReturnDenied(request, 'TOOL_NOT_FOUND', '工具未注册');
    }

    if (manifest.version !== request.tool_version) {
      return this.auditAndReturnDenied(request, 'TOOL_VERSION_NOT_FOUND', '工具版本不存在');
    }

    try {
      validateArguments(manifest, request.arguments);
    } catch (error) {
      return this.auditAndReturnDenied(
        request,
        'TOOL_ARGUMENT_VALIDATION_FAILED',
        error instanceof Error ? error.message : '工具参数不合法',
      );
    }

    const result = await invokeMockAdapter({ toolName, args: request.arguments });
    const auditEvent = await this.auditStore.append({
      tenant_id: request.tenant_id,
      actor_id: String(request.user_context.user_id ?? request.user_context.userId ?? 'unknown'),
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
        task_run_id: request.task_context.task_run_id,
        input_hash: hashJson(request.arguments),
        output_hash: hashJson(result),
        policy_decision: 'allow',
      },
    });

    const response = toolInvokeResponseSchema.parse({
      tool_name: toolName,
      tool_version: request.tool_version,
      status: 'succeeded',
      result,
      audit_event_id: auditEvent.event_id,
      idempotency_key: request.idempotency_key,
    });
    await this.saveIdempotencyRecord(idempotencyStoreKey, request, requestHash, response);
    return response;
  }

  private async auditAndReturnDenied(
    request: ToolInvokeRequest,
    code: string,
    message: string,
  ): Promise<ToolInvokeResponse> {
    const auditEvent = await this.auditStore.append({
      tenant_id: request.tenant_id,
      actor_id: String(request.user_context.user_id ?? request.user_context.userId ?? 'unknown'),
      action: 'tool.invoke',
      target_type: 'tool',
      target_id: request.tool_name,
      result: 'denied',
      reason: code,
      trace_id: request.request_id,
      payload: {
        tool_name: request.tool_name,
        tool_version: request.tool_version,
        task_run_id: request.task_context.task_run_id,
      },
    });

    return toolInvokeResponseSchema.parse({
      tool_name: request.tool_name,
      tool_version: request.tool_version,
      status: 'denied',
      error: { code, message },
      audit_event_id: auditEvent.event_id,
      idempotency_key: request.idempotency_key,
    });
  }

  private async getIdempotencyReplay(
    request: ToolInvokeRequest,
    idempotencyStoreKey: string,
    requestHash: string,
  ): Promise<
    | { decision: 'miss' }
    | { decision: 'conflict' }
    | { decision: 'replay'; response: ToolInvokeResponse }
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
        response: toolInvokeResponseSchema.parse(decision.record.response_json),
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
    request: ToolInvokeRequest,
    requestHash: string,
    response: ToolInvokeResponse,
  ): Promise<void> {
    if (this.idempotencyRepository) {
      await this.idempotencyRepository.insert({
        idempotency_key: idempotencyStoreKey,
        tenant_id: request.tenant_id,
        target_type: 'tool',
        target_id: request.tool_name,
        request_hash: requestHash,
        response_json: response,
        status: response.status === 'succeeded' ? 'succeeded' : 'failed',
      });
      return;
    }

    this.idempotency.set(idempotencyStoreKey, { requestHash, response });
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function buildIdempotencyStoreKey(request: ToolInvokeRequest): string {
  return `${request.tenant_id}:${request.tool_name}:${request.idempotency_key}`;
}

function hashIdempotencyRequest(request: ToolInvokeRequest): string {
  return hashJson({
    tenant_id: request.tenant_id,
    tool_name: request.tool_name,
    tool_version: request.tool_version,
    user_context: request.user_context,
    task_context: request.task_context,
    arguments: request.arguments,
    risk_level: request.risk_level,
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
    );
  }

  return value;
}
