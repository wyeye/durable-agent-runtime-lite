import { setTimeout as delay } from 'node:timers/promises';
import { request, type Dispatcher } from 'undici';
import type { ToolManifest } from '@dar/contracts';
import { createLogger, logEvent } from '@dar/logger';
import { maskSensitiveFields } from '@dar/security';
import { adapterError, ToolAdapterError } from './adapter-errors.js';
import { HttpToolResponseSanitizer } from './http-response-sanitizer.js';
import { HttpToolUrlPolicy } from './http-url-policy.js';
import { validateOutput } from './schema-validator.js';

export interface SafeToolContext {
  request_id?: string;
  tenant_id: string;
  user_id?: string;
  task_run_id?: string;
  workflow_id?: string;
  tool_name: string;
}

export interface ToolAdapterInvokeInput {
  manifest: ToolManifest;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
  requestContext: SafeToolContext;
}

export interface HttpReadonlyAdapterOptions {
  urlPolicy: HttpToolUrlPolicy;
  maxTimeoutMs: number;
  maxResponseBytes: number;
  fetchRequest?: typeof request;
  env?: Record<string, string | undefined>;
  sanitizer?: HttpToolResponseSanitizer;
}

const DEFAULT_RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const logger = createLogger('tool-gateway');

export class HttpReadonlyAdapter {
  private readonly fetchRequest: typeof request;
  private readonly env: Record<string, string | undefined>;
  private readonly sanitizer: HttpToolResponseSanitizer;

  constructor(private readonly options: HttpReadonlyAdapterOptions) {
    this.fetchRequest = options.fetchRequest ?? request;
    this.env = options.env ?? process.env;
    this.sanitizer = options.sanitizer ?? new HttpToolResponseSanitizer();
  }

  async invoke(input: ToolAdapterInvokeInput): Promise<unknown> {
    const { manifest } = input;
    if (manifest.adapter.type !== 'http_readonly') {
      throw adapterError('TOOL_ADAPTER_NOT_SUPPORTED', 'HTTP 只读适配器不支持该 Adapter 类型');
    }
    if (manifest.side_effect || (manifest.risk_level !== 'L0' && manifest.risk_level !== 'L1')) {
      throw adapterError('TOOL_ADAPTER_NOT_SUPPORTED', 'HTTP 只读适配器仅支持 L0/L1 且 side_effect=false 的工具');
    }
    if (!manifest.output_schema) {
      throw adapterError('TOOL_HTTP_OUTPUT_SCHEMA_INVALID', 'HTTP 只读工具必须配置 output_schema');
    }

    const timeoutMs = Math.min(manifest.adapter.timeout_ms, this.options.maxTimeoutMs);
    const maxResponseBytes = Math.min(manifest.adapter.max_response_bytes, this.options.maxResponseBytes);
    const retryableStatusCodes = new Set([
      ...DEFAULT_RETRYABLE_STATUS_CODES,
      ...(manifest.adapter.retry.retryable_status_codes ?? []),
    ]);
    const maxAttempts = Math.max(1, Math.min(manifest.adapter.retry.max_attempts, 5));
    const headers = this.buildHeaders(manifest);
    if (input.requestContext.request_id) {
      headers['X-Request-Id'] = input.requestContext.request_id;
    }
    const policyResult = await this.options.urlPolicy.validate(manifest);
    const url = this.buildUrl(policyResult.url, manifest, input.arguments);

    let lastError: ToolAdapterError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const abortForwarder = () => controller.abort();
      input.signal?.addEventListener('abort', abortForwarder, { once: true });
      try {
        logEvent(logger, 'info', 'tool.committed', { tool_name: manifest.tool_name }, {
          ...input.requestContext,
          http_host: policyResult.hostname,
          http_attempt: attempt,
        });
        const response = await this.fetchRequest(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        const contentType = headerValue(response.headers, 'content-type');
        const bytes = await readLimitedBody(response.body, maxResponseBytes);
        if (response.statusCode >= 300 && response.statusCode < 400) {
          throw adapterError('TOOL_HTTP_INSECURE_URL', 'HTTP 只读工具禁止重定向');
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          if (retryableStatusCodes.has(response.statusCode) && attempt < maxAttempts) {
            await delay(manifest.adapter.retry.backoff_ms, undefined, { signal: input.signal });
            continue;
          }
          throw adapterError('TOOL_HTTP_UPSTREAM_ERROR', `HTTP 上游返回非成功状态：${response.statusCode}`, retryableStatusCodes.has(response.statusCode));
        }
        if (!contentType?.toLowerCase().includes('application/json')) {
          throw adapterError('TOOL_HTTP_RESPONSE_NOT_JSON', 'HTTP 上游响应 Content-Type 不是 JSON');
        }
        const parsed = parseJson(bytes);
        const selected = this.sanitizer.selectBodyPath(parsed, manifest.adapter.response_body_path);
        try {
          validateOutput(manifest, selected);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'HTTP 工具输出不符合 output_schema';
          throw adapterError('TOOL_HTTP_OUTPUT_SCHEMA_INVALID', message);
        }
        return maskSensitiveFields(selected);
      } catch (error) {
        lastError = normalizeHttpError(error);
        if (lastError.retryable && attempt < maxAttempts) {
          await delay(manifest.adapter.retry.backoff_ms, undefined, { signal: input.signal });
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener('abort', abortForwarder);
      }
    }
    throw lastError ?? adapterError('TOOL_HTTP_NETWORK_ERROR', 'HTTP 工具调用失败');
  }

  private buildHeaders(manifest: ToolManifest): Record<string, string> {
    if (manifest.adapter.type !== 'http_readonly') {
      return { Accept: 'application/json' };
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    const auth = manifest.adapter.auth ?? { type: 'none' as const };
    if (auth.type === 'none') {
      return headers;
    }
    const secret = secretFromEnv(this.env, auth.secret_ref);
    if (!secret) {
      throw adapterError('TOOL_HTTP_SECRET_NOT_CONFIGURED', 'HTTP 工具密钥引用未配置');
    }
    if (auth.type === 'bearer_env') {
      headers.Authorization = `Bearer ${secret}`;
      return headers;
    }
    headers[auth.header_name] = secret;
    return headers;
  }

  private buildUrl(base: URL, manifest: ToolManifest, args: Record<string, unknown>): string {
    if (manifest.adapter.type !== 'http_readonly') {
      return base.toString();
    }
    const url = new URL(base.toString());
    for (const [queryName, argumentName] of Object.entries(manifest.adapter.query_mapping ?? {})) {
      const value = args[argumentName];
      if (value === undefined || value === null) {
        continue;
      }
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        throw adapterError('TOOL_ARGUMENT_VALIDATION_FAILED', `HTTP query 参数仅支持 string/number/boolean：${argumentName}`);
      }
      url.searchParams.set(queryName, String(value));
    }
    for (const [queryName, value] of Object.entries(manifest.adapter.static_query ?? {})) {
      url.searchParams.set(queryName, String(value));
    }
    return url.toString();
  }
}

function secretFromEnv(env: Record<string, string | undefined>, secretRef: string): string | undefined {
  const name = /^env:(TOOL_SECRET_[A-Z0-9_]+)$/u.exec(secretRef)?.[1];
  if (!name) {
    return undefined;
  }
  return env[name];
}

async function readLimitedBody(body: Dispatcher.ResponseData['body'], maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw adapterError('TOOL_HTTP_RESPONSE_TOO_LARGE', 'HTTP 上游响应超过大小限制');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw adapterError('TOOL_HTTP_RESPONSE_NOT_JSON', 'HTTP 上游响应不是合法 JSON');
  }
}

function headerValue(headers: Dispatcher.ResponseData['headers'], name: string): string | undefined {
  const normalized = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      const key = String(headers[index] ?? '').toLowerCase();
      if (key === normalized) {
        return String(headers[index + 1] ?? '');
      }
    }
    return undefined;
  }
  const value = headers[name] ?? headers[normalized];
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value === undefined ? undefined : String(value);
}

function normalizeHttpError(error: unknown): ToolAdapterError {
  if (error instanceof ToolAdapterError) {
    return error;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return adapterError('TOOL_HTTP_TIMEOUT', 'HTTP 工具调用超时或被取消', true);
  }
  if (error instanceof Error && /aborted|timeout/iu.test(error.message)) {
    return adapterError('TOOL_HTTP_TIMEOUT', 'HTTP 工具调用超时或被取消', true);
  }
  if (error instanceof Error && /reset|econnreset|socket|network/iu.test(error.message)) {
    return adapterError('TOOL_HTTP_NETWORK_ERROR', 'HTTP 工具网络错误', true);
  }
  return adapterError('TOOL_HTTP_NETWORK_ERROR', 'HTTP 工具网络错误', true);
}
