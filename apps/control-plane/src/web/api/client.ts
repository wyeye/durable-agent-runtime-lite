import type { StandardErrorResponse, StandardResponse } from '@dar/contracts';
import type { ControlPlaneIdentity } from '../auth/identity-context.js';

export interface ApiClientOptions {
  getIdentity(): ControlPlaneIdentity | undefined;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: object | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.baseUrl ?? '';
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const requestId = createRequestId();
    const headers = this.headers(requestId, options.body !== undefined);
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    const signal = mergeSignals(controller.signal, options.signal);

    try {
      const init: RequestInit = {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        signal,
      };
      if (options.body !== undefined) {
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(this.url(path, options.query), init);
      return await parseResponse<T>(response, requestId);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError(503, 'REQUEST_TIMEOUT', '请求超时或已取消', {}, requestId);
      }
      throw new ApiError(503, 'NETWORK_ERROR', '无法连接 control-plane 服务', {}, requestId);
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  private url(path: string, query: ApiRequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path}`, globalThis.location?.origin ?? 'http://localhost');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return this.baseUrl ? url.toString() : `${url.pathname}${url.search}`;
  }

  private headers(requestId: string, hasBody: boolean): Headers {
    const headers = new Headers();
    headers.set('accept', 'application/json');
    headers.set('accept-language', 'zh-CN');
    headers.set('x-request-id', requestId);
    if (hasBody) {
      headers.set('content-type', 'application/json');
    }
    const identity = this.options.getIdentity();
    if (identity) {
      headers.set('x-user-id', identity.user_id);
      headers.set('x-tenant-id', identity.tenant_id);
      headers.set('x-roles', identity.roles.join(','));
    }
    return headers;
  }
}

async function parseResponse<T>(response: Response, requestId: string): Promise<T> {
  const payload = await readJson(response);
  if (isStandardResponse(payload)) {
    if (payload.success) {
      return payload.data as T;
    }
    throw errorFromStandardResponse(response.status, payload, requestId);
  }
  if (!response.ok) {
    throw new ApiError(response.status, `HTTP_${response.status}`, response.statusText || '请求失败', {}, requestId);
  }
  return payload as T;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isStandardResponse(value: unknown): value is StandardResponse<unknown> {
  return value !== null
    && typeof value === 'object'
    && 'success' in value
    && 'data' in value
    && 'error' in value;
}

function errorFromStandardResponse(status: number, response: StandardErrorResponse, requestId: string): ApiError {
  return new ApiError(
    status,
    response.error.code,
    response.error.message,
    response.error.details ?? {},
    response.trace_id ?? requestId,
  );
}

function createRequestId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  requestCounter += 1;
  return `cp-${Date.now()}-${requestCounter}`;
}

let requestCounter = 0;

function mergeSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  if (!secondary) {
    return primary;
  }
  if (secondary.aborted) {
    return secondary;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  primary.addEventListener('abort', abort, { once: true });
  secondary.addEventListener('abort', abort, { once: true });
  return controller.signal;
}
