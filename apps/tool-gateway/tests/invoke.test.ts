import { describe, expect, it } from 'vitest';
import type { AuditEvent, HumanTask, IdempotencyRecord, ToolCallLog, ToolManifest } from '@dar/contracts';
import { buildServer, createToolGatewayService } from '../src/index.js';
import type { ToolManifestRegistry } from '../src/modules/tool-registry.js';
import {
  InMemoryHumanTaskLookupStore,
  InMemoryToolCallLogStore,
  ToolService,
} from '../src/modules/tool-service.js';

class MutableRegistry implements ToolManifestRegistry {
  readonly calls: Array<{ toolName?: string; tenantId?: string }> = [];
  private readonly manifests = new Map<string, ToolManifest>();

  constructor(manifests: ToolManifest[]) {
    for (const manifest of manifests) {
      this.manifests.set(manifest.tool_name, manifest);
    }
  }

  async list(tenantId?: string): Promise<ToolManifest[]> {
    this.calls.push({ tenantId });
    return [...this.manifests.values()];
  }

  async get(toolName: string, tenantId?: string): Promise<ToolManifest | undefined> {
    this.calls.push({ toolName, tenantId });
    return this.manifests.get(toolName);
  }

  delete(toolName: string): void {
    this.manifests.delete(toolName);
  }
}

class FakeAuditStore {
  readonly events: AuditEvent[] = [];

  async append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): Promise<AuditEvent> {
    const auditEvent: AuditEvent = {
      ...event,
      event_id: `audit_${this.events.length + 1}`,
      occurred_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    this.events.push(auditEvent);
    return auditEvent;
  }

  async list(): Promise<AuditEvent[]> {
    return [...this.events];
  }
}

class FakeIdempotencyRepository {
  readonly records = new Map<string, IdempotencyRecord>();

  async get(idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(idempotencyKey);
  }

  async insert(record: Omit<IdempotencyRecord, 'created_at' | 'updated_at'>): Promise<IdempotencyRecord> {
    const stored: IdempotencyRecord = {
      ...record,
      created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    this.records.set(record.idempotency_key, stored);
    return stored;
  }

  async replayOrConflict(input: {
    idempotencyKey: string;
    tenantId: string;
    targetType: string;
    targetId: string;
    requestHash: string;
  }) {
    const record = await this.get(input.idempotencyKey);
    if (!record) {
      return { decision: 'miss' as const };
    }
    if (
      record.tenant_id !== input.tenantId ||
      record.target_type !== input.targetType ||
      record.target_id !== input.targetId ||
      record.request_hash !== input.requestHash
    ) {
      return { decision: 'conflict' as const, record };
    }
    return { decision: 'replay' as const, record };
  }
}

const dbKnowledgeSearchTool: ToolManifest = {
  tool_name: 'knowledge.search',
  version: '1.0.0',
  description: 'DB registered knowledge search',
  risk_level: 'L1',
  side_effect: false,
  adapter: { type: 'mock', endpoint_ref: 'mock/knowledge-search' },
  input_schema: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
  },
  required_permissions: [],
  status: 'published',
};

const l4Tool: ToolManifest = {
  tool_name: 'secret.rotate',
  version: '1.0.0',
  description: 'L4 sensitive tool',
  risk_level: 'L4',
  side_effect: true,
  adapter: { type: 'mock', endpoint_ref: 'mock/secret-rotate' },
  input_schema: {
    type: 'object',
    properties: {},
  },
  required_permissions: [],
  status: 'published',
};

const productionConfig = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
  APP_VERSION: '0.1.5',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
  VALKEY_URL: 'redis://localhost:16380',
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  MODEL_GATEWAY_BASE_URL: 'http://localhost:4100',
  MODEL_GATEWAY_API_KEY: 'dev-only-placeholder',
  JWT_ISSUER: 'http://localhost:3000',
  JWT_AUDIENCE: 'durable-agent-runtime-lite',
  LOG_LEVEL: 'info',
  CONTROL_PLANE_PORT: 3000,
  RUNTIME_API_PORT: 3001,
  RUNTIME_WORKER_PORT: 3002,
  TOOL_GATEWAY_PORT: 3003,
  RUNTIME_WORKER_MODE: 'mock',
  RUNTIME_API_WORKFLOW_STARTER: 'mock',
  RUNTIME_API_ROUTE_SOURCE: 'db',
  TOOL_GATEWAY_REGISTRY_SOURCE: 'memory',
} as const;

describe('tool-gateway invoke', () => {
  it('invokes knowledge.search through mock adapter', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_1' },
        arguments: { query: 'mvp' },
        idempotency_key: 'task_1:knowledge.search',
        request_id: 'req_1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('succeeded');
    await server.close();
  });

  it('replays same readonly idempotency key and writes audit event', async () => {
    const server = buildServer();
    const payload = {
      tool_version: '1.0.0',
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_2' },
      arguments: { query: 'demo' },
      idempotency_key: 'task_2:knowledge.search',
      request_id: 'req_2',
    };
    const first = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload,
    });
    expect(first.json().data.status).toBe('succeeded');
    expect(second.json().data).toEqual(first.json().data);

    const audit = await server.inject({ method: 'GET', url: '/v1/audit-events' });
    expect(audit.json().data).toHaveLength(2);
    expect(audit.json().data[1].reason).toBe('idempotency_replay');
    await server.close();
  });

  it('rejects reused idempotency key with a different request payload', async () => {
    const server = buildServer();
    const payload = {
      tool_version: '1.0.0',
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_conflict' },
      arguments: { query: 'demo' },
      idempotency_key: 'task_conflict:knowledge.search',
      request_id: 'req_conflict_1',
    };
    const first = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload: {
        ...payload,
        arguments: { query: 'changed' },
        request_id: 'req_conflict_2',
      },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });

    const audit = await server.inject({ method: 'GET', url: '/v1/audit-events' });
    expect(audit.json().data).toHaveLength(2);
    expect(audit.json().data[1].reason).toBe('IDEMPOTENCY_CONFLICT');
    await server.close();
  });

  it('requires L3 tools to use preview before commit instead of direct invoke', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/invoke',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_l3_invoke' },
        arguments: { record: { title: 'demo' } },
        idempotency_key: 'task_l3_invoke:record.write.mock',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'needs_confirmation',
      error: { code: 'HUMAN_CONFIRMATION_REQUIRED' },
      policy: { decision: 'require_human_confirm', risk_level: 'L3' },
    });
    expect(response.json().data.result).toBeUndefined();
    await server.close();
  });

  it('previews L3 tools without executing side effects and records tool_call_log plus audit', async () => {
    const toolCallLogStore = new InMemoryToolCallLogStore();
    const server = buildServer(new ToolService({ toolCallLogStore }));

    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/preview',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_l3_preview', workflow_id: 'wf_1' },
        arguments: { record: { title: 'demo' } },
        idempotency_key: 'task_l3_preview:record.write.mock:preview',
        request_id: 'req_l3_preview',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      tool_name: 'record.write.mock',
      mode: 'preview',
      status: 'pending_confirmation',
      policy: { decision: 'require_human_confirm', risk_level: 'L3' },
      preview: { planned: true, side_effect: true },
    });
    expect(response.json().data.preview.written).toBeUndefined();

    const toolCall = await server.inject({
      method: 'GET',
      url: `/v1/tool-calls/${response.json().data.tool_call_id}`,
    });
    expect(toolCall.statusCode).toBe(200);
    expect(toolCall.json().data).toMatchObject({
      status: 'pending_confirmation',
      policy_decision: 'require_human_confirm',
      mode: 'preview',
      tool_name: 'record.write.mock',
    });

    const audit = await server.inject({ method: 'GET', url: '/v1/audit-events' });
    expect(audit.json().data).toHaveLength(1);
    expect(audit.json().data[0]).toMatchObject({
      action: 'tool.preview',
      result: 'pending',
      target_id: 'record.write.mock',
    });
    await server.close();
  });

  it('rejects L3 commit before human approval and commits after approval', async () => {
    const toolCallLogStore = new InMemoryToolCallLogStore();
    const humanTaskStore = new InMemoryHumanTaskLookupStore();
    const server = buildServer(new ToolService({ toolCallLogStore, humanTaskStore }));

    const preview = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/preview',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_l3_commit', workflow_id: 'wf_1' },
        arguments: { record: { title: 'demo' } },
        idempotency_key: 'task_l3_commit:record.write.mock:preview',
      },
    });
    const toolCallId = preview.json().data.tool_call_id as string;

    const denied = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/commit',
      payload: {
        tool_call_id: toolCallId,
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_l3_commit', workflow_id: 'wf_1' },
        arguments: { record: { title: 'demo' } },
        idempotency_key: 'task_l3_commit:record.write.mock:commit',
      },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');

    humanTaskStore.add({
      human_task_id: 'human_1',
      tenant_id: 'tenant_1',
      task_run_id: 'task_l3_commit',
      workflow_id: 'wf_1',
      status: 'approved',
      candidate_groups: [],
      payload: { tool_call_id: toolCallId },
      decision: { status: 'approved' },
      decided_by: 'approver_1',
      decided_at: '2025-01-01T00:00:00.000Z',
      created_at: '2025-01-01T00:00:00.000Z',
    } satisfies HumanTask);

    const committed = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/commit',
      payload: {
        tool_call_id: toolCallId,
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_l3_commit', workflow_id: 'wf_1' },
        arguments: { record: { title: 'demo' } },
        idempotency_key: 'task_l3_commit:record.write.mock:commit:approved',
      },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().data).toMatchObject({
      status: 'committed',
      result: { written: true, preview: false },
    });

    const toolCall = await server.inject({ method: 'GET', url: `/v1/tool-calls/${toolCallId}` });
    expect(toolCall.json().data).toMatchObject({
      status: 'committed',
      mode: 'commit',
      result_json: { written: true },
    });
    await server.close();
  });

  it('replays and conflicts L3 commit idempotency after approval', async () => {
    const toolCallLogStore = new InMemoryToolCallLogStore();
    const humanTaskStore = new InMemoryHumanTaskLookupStore();
    const server = buildServer(new ToolService({ toolCallLogStore, humanTaskStore }));

    const preview = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/preview',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_l3_idem', workflow_id: 'wf_1' },
        arguments: { record: { title: 'demo' } },
        idempotency_key: 'task_l3_idem:record.write.mock:preview',
      },
    });
    const toolCallId = preview.json().data.tool_call_id as string;
    humanTaskStore.add({
      human_task_id: 'human_idem',
      tenant_id: 'tenant_1',
      task_run_id: 'task_l3_idem',
      workflow_id: 'wf_1',
      status: 'approved',
      candidate_groups: [],
      payload: { tool_call_id: toolCallId },
      decided_by: 'approver_1',
      decided_at: '2025-01-01T00:00:00.000Z',
      created_at: '2025-01-01T00:00:00.000Z',
    });

    const payload = {
      tool_call_id: toolCallId,
      tool_version: '1.0.0',
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_l3_idem', workflow_id: 'wf_1' },
      arguments: { record: { title: 'demo' } },
      idempotency_key: 'task_l3_idem:record.write.mock:commit',
    };

    const first = await server.inject({ method: 'POST', url: '/v1/tools/record.write.mock/commit', payload });
    const replay = await server.inject({ method: 'POST', url: '/v1/tools/record.write.mock/commit', payload });
    const conflict = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/commit',
      payload: { ...payload, arguments: { record: { title: 'changed' } } },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe('committed');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toMatchObject({ status: 'replayed', result: first.json().data.result });
    expect(conflict.statusCode).toBe(400);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    await server.close();
  });

  it('denies L4 tools and writes audit event', async () => {
    const registry = new MutableRegistry([l4Tool]);
    const auditStore = new FakeAuditStore();
    const server = buildServer(new ToolService({ registry, auditStore }));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/secret.rotate/preview',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_l4' },
        arguments: {},
        idempotency_key: 'task_l4:secret.rotate:preview',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      error: { code: 'TOOL_RISK_L4_DENIED' },
    });
    expect(auditStore.events).toHaveLength(1);
    expect(auditStore.events[0]).toMatchObject({ result: 'denied', reason: 'TOOL_RISK_L4_DENIED' });
    await server.close();
  });

  it('rejects invalid arguments with standard error', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_3' },
        arguments: {},
        idempotency_key: 'task_3:knowledge.search',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: 'TOOL_ARGUMENT_VALIDATION_FAILED' },
    });

    const audit = await server.inject({ method: 'GET', url: '/v1/audit-events' });
    expect(audit.json().data).toHaveLength(1);
    expect(audit.json().data[0].result).toBe('denied');
    await server.close();
  });

  it('returns standard error for unknown tools', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/unknown.tool/invoke',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_4' },
        arguments: {},
        idempotency_key: 'task_4:unknown.tool',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: 'TOOL_NOT_FOUND' },
    });
    await server.close();
  });

  it('uses DB-backed registry, idempotency, and audit without memory fallback', async () => {
    const registry = new MutableRegistry([dbKnowledgeSearchTool]);
    const auditStore = new FakeAuditStore();
    const idempotencyRepository = new FakeIdempotencyRepository();
    const server = buildServer(
      new ToolService({
        registry,
        auditStore,
        idempotencyRepository: idempotencyRepository as never,
      }),
    );

    const list = await server.inject({ method: 'GET', url: '/v1/tools' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual([dbKnowledgeSearchTool]);

    const payload = {
      tool_version: '1.0.0',
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_db' },
      arguments: { query: 'db manifest query' },
      idempotency_key: 'task_db:knowledge.search',
      request_id: 'req_db_1',
    };

    const first = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload,
    });
    const conflict = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload: {
        ...payload,
        arguments: { query: 'changed db manifest query' },
        request_id: 'req_db_2',
      },
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().data.status).toBe('succeeded');
    expect(registry.calls).toContainEqual({ toolName: 'knowledge.search', tenantId: 'tenant_1' });
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toEqual(first.json().data);
    expect(conflict.statusCode).toBe(400);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');

    const audit = await server.inject({ method: 'GET', url: '/v1/audit-events' });
    expect(audit.json().data).toHaveLength(3);
    expect(audit.json().data.map((event: AuditEvent) => event.reason)).toEqual([
      'readonly_mock_adapter',
      'idempotency_replay',
      'IDEMPOTENCY_CONFLICT',
    ]);

    registry.delete('knowledge.search');
    const afterDelete = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload: {
        ...payload,
        idempotency_key: 'task_db:knowledge.search:deleted',
        request_id: 'req_db_deleted',
      },
    });
    expect(afterDelete.statusCode).toBe(404);
    expect(afterDelete.json().error.code).toBe('TOOL_NOT_FOUND');

    await server.close();
  });

  it('requires DB ToolManifest registry in production', () => {
    expect(() => createToolGatewayService(productionConfig)).toThrow(
      'TOOL_GATEWAY_REGISTRY_SOURCE=db is required in production',
    );
  });

  it('queries audit events and tool calls with tenant filters and masks sensitive payloads', async () => {
    const auditStore = new FakeAuditStore();
    await auditStore.append({
      tenant_id: 'tenant_1',
      actor_id: 'user_1',
      action: 'tool.commit',
      target_type: 'tool',
      target_id: 'knowledge.search',
      result: 'succeeded',
      payload: {
        task_run_id: 'task_sensitive',
        token: 'plain-token',
      },
    });
    const toolCallLogStore = new InMemoryToolCallLogStore();
    const toolCall = await toolCallLogStore.create({
      tenant_id: 'tenant_1',
      task_run_id: 'task_sensitive',
      user_id: 'user_1',
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      risk_level: 'L1',
      policy_decision: 'allow',
      status: 'committed',
      preview_json: { token: 'preview-secret' },
      result_json: { password: 'result-secret', value: 'ok' },
    });
    await toolCallLogStore.create({
      tenant_id: 'tenant_2',
      task_run_id: 'task_other',
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      risk_level: 'L1',
      policy_decision: 'allow',
      status: 'failed',
    });
    const server = buildServer(new ToolService({ auditStore, toolCallLogStore }));

    const audit = await server.inject({
      method: 'GET',
      url: '/v1/audit-events?tenant_id=tenant_1&task_run_id=task_sensitive&tool_name=knowledge.search&event_type=tool.commit',
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data).toHaveLength(1);
    expect(audit.json().data[0].payload.token).toBe('[REDACTED]');

    const toolCalls = await server.inject({
      method: 'GET',
      url: '/v1/tool-calls?tenant_id=tenant_1&task_run_id=task_sensitive&tool_name=knowledge.search&status=committed',
    });
    expect(toolCalls.statusCode).toBe(200);
    const rows = toolCalls.json().data as ToolCallLog[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool_call_id).toBe(toolCall.tool_call_id);
    expect((rows[0]?.preview_json as { token?: string }).token).toBe('[REDACTED]');
    expect((rows[0]?.result_json as { password?: string; value?: string }).password).toBe('[REDACTED]');
    expect((rows[0]?.result_json as { value?: string }).value).toBe('ok');

    const single = await server.inject({
      method: 'GET',
      url: `/v1/tool-calls/${toolCall.tool_call_id}`,
    });
    expect((single.json().data.result_json as { password?: string }).password).toBe('[REDACTED]');

    await server.close();
  });
});
