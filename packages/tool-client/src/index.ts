import { request } from 'undici';
import {
  toolInvokeRequestSchema,
  toolInvokeResponseSchema,
  type ToolInvokeRequest,
  type ToolInvokeResponse,
} from '@dar/contracts';

export interface ToolGatewayClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
}

export class ToolGatewayClient {
  private readonly baseUrl: URL;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: ToolGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  async invoke(payload: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    const parsed = toolInvokeRequestSchema.parse(payload);
    const body = JSON.stringify(parsed);
    const url = new URL(`/v1/tools/${encodeURIComponent(parsed.tool_name)}/invoke`, this.baseUrl);
    const response = await request(url, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        'content-type': 'application/json',
      },
      body,
    });

    const text = await response.body.text();
    const json: unknown = text ? JSON.parse(text) : {};
    return toolInvokeResponseSchema.parse(unwrapStandardResponse(json));
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
