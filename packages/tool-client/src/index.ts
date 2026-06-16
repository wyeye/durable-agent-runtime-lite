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
    const body = JSON.stringify(toolInvokeRequestSchema.parse(payload));
    const url = new URL('/v1/tools/invoke', this.baseUrl);
    const response = await request(url, {
      method: 'POST',
      headers: {
        ...this.defaultHeaders,
        'content-type': 'application/json',
      },
      body,
    });

    const text = await response.body.text();
    const json = text ? JSON.parse(text) : {};
    return toolInvokeResponseSchema.parse(json);
  }
}
