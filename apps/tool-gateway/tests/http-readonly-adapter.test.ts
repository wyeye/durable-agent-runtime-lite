import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '@dar/contracts';
import { ToolAdapterError } from '../src/modules/adapter-errors.js';
import { HttpReadonlyAdapter } from '../src/modules/http-readonly-adapter.js';
import { HttpToolUrlPolicy } from '../src/modules/http-url-policy.js';

const manifest: ToolManifest = {
  tool_name: 'company.policy.lookup',
  version: '1.0.0',
  risk_level: 'L1',
  side_effect: false,
  adapter: {
    type: 'http_readonly',
    base_url: 'http://localhost:4100',
    path: '/business-api/v1/policies',
    query_mapping: { keyword: 'keyword' },
    auth: { type: 'bearer_env', secret_ref: 'env:TOOL_SECRET_BUSINESS_API' },
    timeout_ms: 1000,
    max_response_bytes: 4096,
    retry: { max_attempts: 2, retryable_status_codes: [429, 503], backoff_ms: 0 },
  },
  input_schema: { type: 'object', required: ['keyword'], properties: { keyword: { type: 'string' } } },
  output_schema: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
  required_permissions: [],
};

describe('HttpReadonlyAdapter', () => {
  it('sends GET with mapped query and bearer env secret', async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const adapter = createAdapter(async (url, options) => {
      requests.push({ url: String(url), headers: options.headers as Record<string, string> });
      return jsonResponse(200, { items: [{ id: 'policy-1', title: '差旅报销政策' }] });
    });

    const result = await adapter.invoke(invokeInput({ keyword: '差旅' }));

    expect(result).toMatchObject({ items: [{ id: 'policy-1' }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/business-api/v1/policies?keyword=');
    expect(requests[0]?.headers.Authorization).toBe('Bearer business-read-secret');
  });

  it('fails closed before network when secret is missing', async () => {
    let requestCount = 0;
    const adapter = createAdapter(async () => {
      requestCount += 1;
      return jsonResponse(200, {});
    }, {});

    await expect(adapter.invoke(invokeInput({ keyword: '差旅' }))).rejects.toMatchObject({
      code: 'TOOL_HTTP_SECRET_NOT_CONFIGURED',
    });
    expect(requestCount).toBe(0);
  });

  it('retries 429 once and returns a single logical result', async () => {
    let requestCount = 0;
    const adapter = createAdapter(async () => {
      requestCount += 1;
      return requestCount === 1
        ? jsonResponse(429, { error: 'rate limited' })
        : jsonResponse(200, { items: [{ id: 'policy-1' }] });
    });

    await expect(adapter.invoke(invokeInput({ keyword: '差旅' }))).resolves.toMatchObject({
      items: [{ id: 'policy-1' }],
    });
    expect(requestCount).toBe(2);
  });

  it.each([
    ['TOOL_HTTP_RESPONSE_NOT_JSON', 'application/json', '{not-json'],
    ['TOOL_HTTP_RESPONSE_TOO_LARGE', 'application/json', JSON.stringify({ items: ['x'.repeat(5000)] })],
  ])('maps response failure %s', async (code, contentType, body) => {
    const adapter = createAdapter(async () => rawResponse(200, body, contentType), undefined, 16);

    await expect(adapter.invoke(invokeInput({ keyword: '差旅' }))).rejects.toMatchObject({ code });
  });

  it('validates response body path against output schema', async () => {
    const adapter = createAdapter(async () => jsonResponse(200, { data: { items: [{ id: 'policy-1' }] } }));

    await expect(adapter.invoke(invokeInput({ keyword: '差旅' }, {
      adapter: { ...(manifest.adapter as Extract<ToolManifest['adapter'], { type: 'http_readonly' }>), response_body_path: 'data' },
    }))).resolves.toMatchObject({ items: [{ id: 'policy-1' }] });
  });
});

function createAdapter(
  fetchRequest: ConstructorParameters<typeof HttpReadonlyAdapter>[0]['fetchRequest'],
  env: Record<string, string | undefined> = { TOOL_SECRET_BUSINESS_API: 'business-read-secret' },
  maxResponseBytes = 4096,
) {
  return new HttpReadonlyAdapter({
    urlPolicy: new HttpToolUrlPolicy({ allowedHosts: ['localhost'], allowInsecureLocalhost: true }),
    maxTimeoutMs: 1000,
    maxResponseBytes,
    fetchRequest,
    env,
  });
}

function invokeInput(args: Record<string, unknown>, overrides: Partial<ToolManifest> = {}) {
  return {
    manifest: { ...manifest, ...overrides },
    arguments: args,
    requestContext: { tenant_id: 'tenant_1', tool_name: 'company.policy.lookup' },
  };
}

function jsonResponse(statusCode: number, value: unknown) {
  return rawResponse(statusCode, JSON.stringify(value), 'application/json');
}

function rawResponse(statusCode: number, body: string, contentType: string) {
  return {
    statusCode,
    headers: { 'content-type': contentType },
    body: Readable.from([body]),
  } as Awaited<ReturnType<NonNullable<ConstructorParameters<typeof HttpReadonlyAdapter>[0]['fetchRequest']>>>;
}

void ToolAdapterError;
