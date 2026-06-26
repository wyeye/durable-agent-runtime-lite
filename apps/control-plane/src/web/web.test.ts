import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api/client.js';
import {
  archiveConversation,
  createConversation,
  listConversationMessages,
  listConversations,
  renameConversation,
  sendConversationMessage,
} from './api/conversations-api.js';
import { createDraft, listResources } from './api/registry-api.js';
import { listHumanTasks, listToolCalls } from './api/operations-api.js';
import {
  cancelRun,
  createCase,
  createDataset,
  createOverride,
  createRun,
  listDatasets,
  listGateDecisions,
  updateDataset,
} from './api/evaluation-api.js';
import { parseJson, stringifyPretty } from './utils/json.js';
import { toFriendlyError } from './utils/errors.js';
import { resourceConfigs } from './pages/registry/resource-config.js';

describe('control-plane web api client', () => {
  it('injects identity headers, locale, and request id', async () => {
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
    expect(headers.get('accept-language')).toBe('zh-CN');
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

  it('builds evaluation client URLs under /api/v1 and injects identity headers', async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    const bodies: string[] = [];
    const roles: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      methods.push(init?.method ?? 'GET');
      bodies.push(String(init?.body ?? ''));
      roles.push((init?.headers as Headers).get('x-roles') ?? '');
      return jsonResponse({ success: true, data: successDataFor(String(input)), error: null });
    }));
    vi.stubGlobal('location', { origin: 'http://localhost:3100' });
    vi.stubGlobal('crypto', { randomUUID: () => 'request-id-eval' });
    const client = new ApiClient({ getIdentity: () => ({ user_id: 'operator', tenant_id: 'tenant-a', roles: ['capability_operator'] }) });

    await listDatasets(client, { status: 'published', page_size: 20 });
    await createDataset(client, {
      dataset_id: 'dataset-a',
      version: 1,
      name: 'Dataset A',
      status: 'draft',
      tags: [],
      default_weight: 1,
      revision: 1,
    });
    await updateDataset(client, 'dataset-a', 1, { dataset: { name: 'Dataset A2' }, expected_revision: 1 });
    await createCase(client, 'dataset-a', 1, {
      case_id: 'case-a',
      dataset_id: 'dataset-a',
      dataset_version: 1,
      name: 'Case A',
      input: { text: 'target case' },
      context_refs: [],
      expected_tool_calls: [],
      forbidden_tools: [],
      final_assertions: [{ type: 'non_empty' }],
      policy_assertions: [],
      weight: 1,
      tags: [],
      enabled: true,
    });
    await createRun(client, {
      dataset_id: 'dataset-a',
      dataset_version: 1,
      dataset_hash: 'a'.repeat(64),
      subject_snapshot_ref: 'db://evaluation-subject-snapshot/snapshot-a',
      subject_snapshot_hash: 'b'.repeat(64),
      evaluation_execution_plan_ref: 'db://evaluation-execution-plan/plan-a',
      evaluation_execution_plan_hash: 'c'.repeat(64),
      trigger_type: 'manual',
    });
    await cancelRun(client, 'run-a');
    await listGateDecisions(client, {
      resource_type: 'prompt',
      resource_id: 'prompt-a',
      current_resource_hash: 'd'.repeat(64),
    });
    await createOverride(client, 'decision-a', {
      resource_hash: 'e'.repeat(64),
      reason: 'allow exact hash for urgent release',
      scope: 'single_resource_hash',
      expires_at: new Date(0).toISOString(),
    });

    expect(urls.every((url) => url.startsWith('/api/v1/'))).toBe(true);
    expect(urls).toContain('/api/v1/evaluation-datasets?status=published&page_size=20');
    expect(urls).toContain('/api/v1/evaluation-datasets/dataset-a/versions/1');
    expect(urls).toContain('/api/v1/evaluation-datasets/dataset-a/versions/1/cases');
    expect(urls).toContain('/api/v1/evaluation-runs');
    expect(urls).toContain('/api/v1/evaluation-runs/run-a/cancel');
    expect(urls).toContain('/api/v1/evaluation-gate-decisions?resource_type=prompt&resource_id=prompt-a&current_resource_hash=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
    expect(urls).toContain('/api/v1/evaluation-gate-decisions/decision-a/override');
    expect(methods).toEqual(['GET', 'POST', 'PUT', 'POST', 'POST', 'POST', 'GET', 'POST']);
    expect(roles.every((role) => role === 'capability_operator')).toBe(true);
    expect(bodies.join('\n')).toContain('"evaluation_execution_plan_ref"');
    expect(bodies.join('\n')).not.toContain('"latest"');
  });

  it('builds conversation client URLs and methods under /api/v1', async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      methods.push(init?.method ?? 'GET');
      return jsonResponse({ success: true, data: conversationSuccessData(String(input), init?.method ?? 'GET'), error: null });
    }));
    vi.stubGlobal('location', { origin: 'http://localhost:3100' });
    vi.stubGlobal('crypto', { randomUUID: () => 'request-id-chat' });
    const client = new ApiClient({ getIdentity: () => ({ user_id: 'member', tenant_id: 'tenant-a', roles: [] }) });

    await listConversations(client, { status: 'active', page_size: 20 });
    await createConversation(client, {});
    await renameConversation(client, 'conversation_1', { title: '重命名', expected_revision: 1 });
    await listConversationMessages(client, 'conversation_1', { order: 'oldest', page_size: 100 });
    await sendConversationMessage(client, 'conversation_1', { content: '你好', client_message_id: 'client_1' });
    await archiveConversation(client, 'conversation_1');

    expect(urls).toEqual([
      '/api/v1/conversations?status=active&page_size=20',
      '/api/v1/conversations',
      '/api/v1/conversations/conversation_1',
      '/api/v1/conversations/conversation_1/messages?order=oldest&page_size=100',
      '/api/v1/conversations/conversation_1/messages',
      '/api/v1/conversations/conversation_1/archive',
    ]);
    expect(methods).toEqual(['GET', 'POST', 'PATCH', 'GET', 'POST', 'POST']);
  });
});

describe('registry web model', () => {
  it('does not render legacy sample resources as page defaults', () => {
    const templates = Object.values(resourceConfigs).map((config) => stringifyPretty(config.makeDraftTemplate())).join('\n');
    expect(templates).not.toContain('sample_flow');
    expect(templates).not.toContain('knowledge.search');
    expect(templates).not.toContain('record.write.mock');
  });

  it('keeps evaluation templates exact-version oriented without mock sample data', () => {
    const text = stringifyPretty(resourceConfigs);
    expect(text).not.toContain('latest');
    expect(text).not.toContain('sample_flow');
    expect(text).not.toContain('raw_provider_response');
    expect(text).not.toContain('hidden_reasoning');
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

function successDataFor(url: string): unknown {
  if (url.includes('/evaluation-gate-decisions')) {
    return { items: [], page: 1, page_size: 20 };
  }
  if (url.includes('/evaluation-runs/run-a/cancel')) {
    return { evaluation_run_id: 'run-a', status: 'cancelling' };
  }
  if (url.endsWith('/evaluation-runs')) {
    return {
      evaluation_run: { evaluation_run_id: 'run-a', status: 'queued' },
      workflow_start: { started: true },
    };
  }
  if (url.includes('/evaluation-datasets')) {
    return { items: [], page: 1, page_size: 20 };
  }
  return {};
}

function conversationSuccessData(url: string, method: string): unknown {
  if (url.includes('/messages') && method === 'GET') {
    return { items: [], page: 1, page_size: 100, total: 0 };
  }
  if (url.includes('/messages') && method === 'POST') {
    return {
      conversation: conversationRecord(),
      user_message: {
        message_id: 'msg_user_1',
        conversation_id: 'conversation_1',
        tenant_id: 'tenant-a',
        sequence_no: 1,
        role: 'user',
        status: 'completed',
        content_text: '你好',
        client_message_id: 'client_1',
        clarify_candidates: [],
        context_message_ids: [],
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        completed_at: new Date(0).toISOString(),
      },
      assistant_message: {
        message_id: 'msg_assistant_1',
        conversation_id: 'conversation_1',
        tenant_id: 'tenant-a',
        sequence_no: 2,
        role: 'assistant',
        status: 'queued',
        effective_status: 'queued',
        content_text: null,
        reply_to_message_id: 'msg_user_1',
        clarify_candidates: [],
        context_message_ids: [],
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      },
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
    };
  }
  if (url.endsWith('/archive')) {
    return { ...conversationRecord(), status: 'archived', archived_at: new Date(0).toISOString() };
  }
  if (method === 'GET') {
    return { items: [conversationRecord()], page: 1, page_size: 20, total: 1 };
  }
  return conversationRecord();
}

function conversationRecord() {
  return {
    conversation_id: 'conversation_1',
    tenant_id: 'tenant-a',
    owner_user_id: 'member',
    title: '测试会话',
    status: 'active',
    revision: 1,
    next_sequence_no: 3,
    last_message_at: new Date(0).toISOString(),
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    archived_at: null,
  };
}
