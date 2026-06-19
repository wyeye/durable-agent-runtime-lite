import type { StandardResponse } from '@dar/contracts';
import { ControlPlaneHttpError } from '../utils/http.js';

export interface ForwardHeaders {
  userId: string;
  tenantId: string;
  roles: string[];
  requestId?: string;
}

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

export class DownstreamClient {
  constructor(private readonly options: HttpClientOptions) {}

  async get<T>(path: string, headers: ForwardHeaders): Promise<T> {
    return this.request<T>(path, { method: 'GET', headers: this.headers(headers) });
  }

  async post<T>(path: string, body: unknown, headers: ForwardHeaders): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: {
        ...this.headers(headers),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
    try {
      const response = await fetch(new URL(path, this.options.baseUrl), {
        ...init,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new ControlPlaneHttpError(
          response.status >= 500 ? 503 : response.status,
          downstreamErrorCode(body) ?? 'DOWNSTREAM_ERROR',
          downstreamErrorMessage(body) ?? 'Downstream request failed',
        );
      }
      const parsed = body as StandardResponse<T>;
      if (!parsed.success) {
        throw new ControlPlaneHttpError(response.status, parsed.error.code, parsed.error.message, parsed.error.details);
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ControlPlaneHttpError) {
        throw error;
      }
      throw new ControlPlaneHttpError(503, 'DOWNSTREAM_UNAVAILABLE', 'Downstream service unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(headers: ForwardHeaders): Record<string, string> {
    return {
      ...(this.options.defaultHeaders ?? {}),
      ...forwardHeaders(headers),
    };
  }
}

function forwardHeaders(input: ForwardHeaders): Record<string, string> {
  return {
    'x-user-id': input.userId,
    'x-tenant-id': input.tenantId,
    'x-roles': input.roles.join(','),
    ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
  };
}

function downstreamErrorCode(body: unknown): string | undefined {
  return isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string'
    ? body.error.code
    : undefined;
}

function downstreamErrorMessage(body: unknown): string | undefined {
  return isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
    ? body.error.message
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
