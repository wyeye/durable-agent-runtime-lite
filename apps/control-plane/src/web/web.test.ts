import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api/client.js';
import { createDraft, listResources } from './api/registry-api.js';
import { listHumanTasks, listToolCalls } from './api/operations-api.js';
import { parseJson, stringifyPretty } from './utils/json.js';
import { toFriendlyError } from './utils/errors.js';
import { resourceConfigs } from './pages/registry/resource-config.js';

describe('control-plane web api client', () => {
  it('injects identity headers and request id', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return jsonResponse({ success: true, data: { ok: true }, error: null });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { origin: 'http://localhost:3100' });
    vi.stubGlobal('crypto', { randomUUID: () => 'request-id-1' });

    const client = new ApiClient({
      getIdentity: () => ({ user_id: 'operator', tenant_id: 'tenant-a', roles: ['capability_operator'] }),
    });

    await client.request('/api/v1/prompts');

    expect(capturedInit).toBeDefined();
    const headers = capturedInit?.headers as Headers;
    expect(headers.get('x-user-id')).toBe('operator');
    expect(headers.get('x-tenant-id')).toBe('tenant-a');
    expect(headers.get('x-roles')).toBe('capability_operator');
    expect(headers.get('x-request-id')).toBe('request-id-1');
  });

  it('maps standard 401/403/409/422/503 errors to ApiError', async () => {
    const statuses = [401, 403, 409, 422, 503];
    for (const status of statuses) {
      const fetchMock = vi.fn(async () => jsonResponse({
        success: false,
        data: null,
        error: { code: `ERR_${status}`, message: `error ${status}` },
        trace_id: `trace-${status}`,
      }, status));
      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('location', { origin: 'http://localhost:3100' });
      const client = new ApiClient({ getIdentity: () => undefined });
      await expect(client.request('/api/v1/prompts')).rejects.toMatchObject({
        status,
        code: `ERR_${status}`,
        requestId: `trace-${status}`,
      });
    }
  });

  it('returns friendly optimistic lock and validation messages', () => {
    expect(toFriendlyError(new ApiError(409, 'REGISTRY_OPTIMISTIC_LOCK_CONFLICT', 'revision conflict', {}, 'r1')).title).toBe('版本冲突');
    expect(toFriendlyError(new ApiError(422, 'REGISTRY_VALIDATION_FAILED', 'can_publish=false', {}, 'r2')).title).toBe('校验未通过');
  });

  it('builds registry and operations URLs under /api/v1 only', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({ success: true, data: { items: [], page: 1, page_size: 20 }, error: null });
    }));
    vi.stubGlobal('location', { origin: 'http://localhost:3100' });
    const client = new ApiClient({ getIdentity: () => ({ user_id: 'u', tenant_id: 't', roles: ['auditor'] }) });
    await listResources(client, 'flow', { keyword: 'abc', page_size: 5 });
    expect(urls[0]).toContain('/api/v1/flows');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({ success: true, data: { human_tasks: [] }, error: null });
    }));
    await listHumanTasks(client, { status: 'pending' });
    expect(urls[1]).toContain('/api/v1/operations/human-tasks');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({ success: true, data: [], error: null });
    }));
    await listToolCalls(client, { status: 'failed' });
    expect(urls[2]).toContain('/api/v1/operations/tool-calls');
  });
});

describe('registry web model', () => {
  it('does not render legacy sample resources as page defaults', () => {
    const templates = Object.values(resourceConfigs).map((config) => stringifyPretty(config.makeDraftTemplate())).join('\n');
    expect(templates).not.toContain('sample_flow');
    expect(templates).not.toContain('knowledge.search');
    expect(templates).not.toContain('record.write.mock');
  });

  it('rejects invalid JSON before submit', () => {
    expect(parseJson('{ bad json').ok).toBe(false);
    expect(parseJson('{"ok":true}').ok).toBe(true);
  });

  it('creates draft through shared registry client payload shape', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return jsonResponse({
      success: true,
      data: {
        tenant_id: 'default',
        resource_type: 'prompt',
        resource_id: 'prompt-a',
        version: 1,
        status: 'draft',
        spec: { prompt_id: 'prompt-a', version: 1, name: 'Prompt', content: 'Body', variables: [] },
        sha256: 'hash',
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        revision: 1,
        gray_policy: { tenant_allowlist: [], user_allowlist: [] },
      },
      error: null,
    });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('location', { origin: 'http://localhost:3100' });
    const client = new ApiClient({ getIdentity: () => ({ user_id: 'operator', tenant_id: 'default', roles: ['capability_operator'] }) });
    await createDraft(client, 'prompt', { prompt_id: 'prompt-a', version: 1, name: 'Prompt', content: 'Body', variables: [] });
    expect(capturedInit?.method).toBe('POST');
    expect(String(capturedInit?.body)).toContain('"spec"');
  });

  it('keeps archived out of visible lifecycle statuses', () => {
    const text = stringifyPretty(resourceConfigs);
    expect(text).not.toContain('archived');
  });

  it('exposes L3/L4 risk metadata through Tool template', () => {
    const template = resourceConfigs.tool.makeDraftTemplate();
    const text = stringifyPretty(template);
    expect(text).toContain('risk_level');
    expect(text).toContain('side_effect');
    expect(text).toContain('adapter');
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
