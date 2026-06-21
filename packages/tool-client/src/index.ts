import { request } from 'undici';
import {
  toolCallLogSchema,
  toolCommitRequestSchema,
  toolCommitResponseSchema,
  toolInvokeRequestSchema,
  toolInvokeResponseSchema,
  toolPreviewRequestSchema,
  toolPreviewResponseSchema,
  type ToolCallLog,
  type ToolCommitRequest,
  type ToolCommitResponse,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
  type ToolPreviewRequest,
  type ToolPreviewResponse,
  type RuntimeError,
} from '@dar/contracts';
import { buildServiceIdentityHeaders, type ServiceId } from '@dar/security';

export interface ToolGatewayClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  serviceIdentity?: {
    serviceId: ServiceId;
    token?: string;
  };
}

export class ToolGatewayClient {
  private readonly baseUrl: URL;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: ToolGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.defaultHeaders = {
      ...(options.serviceIdentity
        ? buildServiceIdentityHeaders({
            serviceId: options.serviceIdentity.serviceId,
            ...(options.serviceIdentity.token ? { token: options.serviceIdentity.token } : {}),
          })
        : {}),
      ...(options.defaultHeaders ?? {}),
    };
  }

  async invoke(payload: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    const parsed = toolInvokeRequestSchema.parse(payload);
    const response = await this.post(`/v1/tools/${encodeURIComponent(parsed.tool_name)}/invoke`, parsed);
    if (response.ok) {
      return toolInvokeResponseSchema.parse(response.data);
    }
    return toolInvokeResponseSchema.parse(deniedInvokeResponse(assertToolGatewayDeniedError(response.error)));
  }

  async preview(payload: ToolPreviewRequest): Promise<ToolPreviewResponse> {
    const parsed = toolPreviewRequestSchema.parse(payload);
    const response = await this.post(`/v1/tools/${encodeURIComponent(parsed.tool_name)}/preview`, parsed);
    if (response.ok) {
      return toolPreviewResponseSchema.parse(response.data);
    }
    return toolPreviewResponseSchema.parse(deniedPreviewResponse(assertToolGatewayDeniedError(response.error)));
  }

  async commit(payload: ToolCommitRequest): Promise<ToolCommitResponse> {
    const parsed = toolCommitRequestSchema.parse(payload);
    const response = await this.post(`/v1/tools/${encodeURIComponent(parsed.tool_name)}/commit`, parsed);
    if (response.ok) {
      return toolCommitResponseSchema.parse(response.data);
    }
    return toolCommitResponseSchema.parse(deniedCommitResponse(assertToolGatewayDeniedError(response.error)));
  }

  async getToolCall(toolCallId: string): Promise<ToolCallLog> {
    const url = new URL(`/v1/tool-calls/${encodeURIComponent(toolCallId)}`, this.baseUrl);
    const response = await request(url, {
      method: 'GET',
      headers: {
        ...this.defaultHeaders,
        'accept-language': this.defaultHeaders['accept-language'] ?? 'zh-CN',
      },
    });
    const text = await response.body.text();
    const json: unknown = text ? JSON.parse(text) : {};
    const result = unwrapStandardResponse(json);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return toolCallLogSchema.parse(result.data);
  }

  private async post(path: string, payload: unknown): Promise<ClientPostResult> {
    const response = await request(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        'content-type': 'application/json',
        'accept-language': this.defaultHeaders['accept-language'] ?? 'zh-CN',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.body.text();
    const json: unknown = text ? JSON.parse(text) : {};
    return unwrapStandardResponse(json);
  }
}

type ClientPostResult =
  | { ok: true; data: unknown }
  | { ok: false; error: RuntimeError };

const toolGatewayDeniedErrorCodes = new Set([
  'EXECUTION_PLAN_HASH_MISMATCH',
  'HUMAN_CONFIRMATION_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'TENANT_POLICY_HASH_MISMATCH',
  'TENANT_POLICY_SNAPSHOT_CONTEXT_MISSING',
  'TENANT_POLICY_SNAPSHOT_STORE_UNAVAILABLE',
  'TENANT_POLICY_SNAPSHOT_TENANT_MISMATCH',
  'TENANT_RUNTIME_POLICY_NOT_FOUND',
  'TOOL_ARGUMENT_VALIDATION_FAILED',
  'TOOL_CALL_MISMATCH',
  'TOOL_CALL_NOT_FOUND',
  'TOOL_DENIED_BY_EVALUATION_POLICY',
  'TOOL_DENIED_BY_TENANT_POLICY',
  'TOOL_EVALUATION_CALL_LIMIT_EXCEEDED',
  'TOOL_EVALUATION_CONTEXT_REQUIRED',
  'TOOL_EVALUATION_PREVIEW_ONLY',
  'TOOL_EVALUATION_RESERVATION_UNAVAILABLE',
  'TOOL_EVALUATION_SANDBOX_REQUIRED',
  'TOOL_HASH_MISMATCH',
  'TOOL_NOT_FOUND',
  'TOOL_POLICY_DENIED',
  'TOOL_RISK_L4_DENIED',
  'TOOL_RISK_MISMATCH',
  'TOOL_VERSION_NOT_FOUND',
]);

function unwrapStandardResponse(value: unknown): ClientPostResult {
  if (!value || typeof value !== 'object' || !('success' in value)) {
    return { ok: true, data: value };
  }

  const response = value as { success?: unknown; data?: unknown; error?: unknown };
  if (response.success === true) {
    return { ok: true, data: response.data };
  }

  const error = response.error && typeof response.error === 'object'
    ? (response.error as { code?: unknown; message?: unknown; details?: unknown })
    : {};
  if (typeof error.code === 'string' && typeof error.message === 'string') {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(isRecord(error.details) ? { details: error.details } : {}),
      },
    };
  }
  throw new Error(typeof error.message === 'string' ? error.message : 'tool gateway request failed');
}

function assertToolGatewayDeniedError(error: RuntimeError): RuntimeError {
  const details = isRecord(error.details) ? error.details : {};
  const hasToolIdentity = typeof details.tool_name === 'string' && typeof details.tool_version === 'string';
  const hasGatewayEvidence = typeof details.audit_event_id === 'string'
    || typeof details.idempotency_key === 'string'
    || typeof details.tool_call_id === 'string';
  if (toolGatewayDeniedErrorCodes.has(error.code) && hasToolIdentity && hasGatewayEvidence) {
    return error;
  }
  throw new Error(`${error.code}: ${error.message}`);
}

function deniedInvokeResponse(error: RuntimeError): ToolInvokeResponse {
  const details = isRecord(error.details) ? error.details : {};
  return {
    tool_name: stringDetail(details, 'tool_name'),
    tool_version: stringDetail(details, 'tool_version'),
    status: 'denied',
    error,
    ...(stringDetail(details, 'audit_event_id') ? { audit_event_id: stringDetail(details, 'audit_event_id') } : {}),
    ...(stringDetail(details, 'idempotency_key') ? { idempotency_key: stringDetail(details, 'idempotency_key') } : {}),
    ...(stringDetail(details, 'tool_call_id') ? { tool_call_id: stringDetail(details, 'tool_call_id') } : {}),
  };
}

function deniedPreviewResponse(error: RuntimeError): ToolPreviewResponse {
  const details = isRecord(error.details) ? error.details : {};
  return {
    tool_call_id: stringDetail(details, 'tool_call_id'),
    tool_name: stringDetail(details, 'tool_name'),
    tool_version: stringDetail(details, 'tool_version'),
    mode: 'preview',
    status: 'denied',
    policy: deniedPolicy(error),
    error,
    ...(stringDetail(details, 'audit_event_id') ? { audit_event_id: stringDetail(details, 'audit_event_id') } : {}),
    ...(stringDetail(details, 'idempotency_key') ? { idempotency_key: stringDetail(details, 'idempotency_key') } : {}),
  };
}

function deniedCommitResponse(error: RuntimeError): ToolCommitResponse {
  const details = isRecord(error.details) ? error.details : {};
  return {
    tool_call_id: stringDetail(details, 'tool_call_id'),
    tool_name: stringDetail(details, 'tool_name'),
    tool_version: stringDetail(details, 'tool_version'),
    mode: 'commit',
    status: 'denied',
    error,
    ...(stringDetail(details, 'audit_event_id') ? { audit_event_id: stringDetail(details, 'audit_event_id') } : {}),
    ...(stringDetail(details, 'idempotency_key') ? { idempotency_key: stringDetail(details, 'idempotency_key') } : {}),
  };
}

function deniedPolicy(error: RuntimeError): ToolPreviewResponse['policy'] {
  const details = isRecord(error.details) ? error.details : {};
  return {
    decision: 'deny',
    risk_level: riskLevelDetail(details),
    reason: error.code,
    requires_human_confirm: false,
    error,
  };
}

function riskLevelDetail(details: Record<string, unknown>): ToolPreviewResponse['policy']['risk_level'] {
  const value = details.risk_level;
  return value === 'L0' || value === 'L1' || value === 'L2' || value === 'L3' || value === 'L4'
    ? value
    : 'L1';
}

function stringDetail(details: Record<string, unknown>, key: string): string {
  const value = details[key];
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
