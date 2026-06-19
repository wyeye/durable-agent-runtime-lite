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
    return toolInvokeResponseSchema.parse(
      await this.post(`/v1/tools/${encodeURIComponent(parsed.tool_name)}/invoke`, parsed),
    );
  }

  async preview(payload: ToolPreviewRequest): Promise<ToolPreviewResponse> {
    const parsed = toolPreviewRequestSchema.parse(payload);
    return toolPreviewResponseSchema.parse(
      await this.post(`/v1/tools/${encodeURIComponent(parsed.tool_name)}/preview`, parsed),
    );
  }

  async commit(payload: ToolCommitRequest): Promise<ToolCommitResponse> {
    const parsed = toolCommitRequestSchema.parse(payload);
    return toolCommitResponseSchema.parse(
      await this.post(`/v1/tools/${encodeURIComponent(parsed.tool_name)}/commit`, parsed),
    );
  }

  async getToolCall(toolCallId: string): Promise<ToolCallLog> {
    const url = new URL(`/v1/tool-calls/${encodeURIComponent(toolCallId)}`, this.baseUrl);
    const response = await request(url, {
      method: 'GET',
      headers: this.defaultHeaders,
    });
    const text = await response.body.text();
    const json: unknown = text ? JSON.parse(text) : {};
    return toolCallLogSchema.parse(unwrapStandardResponse(json));
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const response = await request(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.body.text();
    const json: unknown = text ? JSON.parse(text) : {};
    return unwrapStandardResponse(json);
  }
}

function unwrapStandardResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('success' in value)) {
    return value;
  }

  const response = value as { success?: unknown; data?: unknown; error?: unknown };
  if (response.success === true) {
    return response.data;
  }

  const error = response.error && typeof response.error === 'object'
    ? (response.error as { code?: unknown; message?: unknown })
    : {};
  throw new Error(typeof error.message === 'string' ? error.message : 'tool gateway request failed');
}
