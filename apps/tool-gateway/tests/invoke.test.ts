import { describe, expect, it } from 'vitest';
import type { AuditEvent, IdempotencyRecord, ToolManifest } from '@dar/contracts';
import { buildServer, createToolGatewayService } from '../src/index.js';
import type { ToolManifestRegistry } from '../src/modules/tool-registry.js';
import { ToolService } from '../src/modules/tool-service.js';

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

  it('replays same idempotency key and writes audit event', async () => {
    const server = buildServer();
    const payload = {
      tool_version: '1.0.0',
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_2' },
      arguments: { record: { title: 'demo' } },
      idempotency_key: 'task_2:record.write.mock',
      request_id: 'req_2',
    };
    const first = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/invoke',
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/invoke',
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
      arguments: { record: { title: 'demo' } },
      idempotency_key: 'task_conflict:record.write.mock',
      request_id: 'req_conflict_1',
    };
    const first = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/invoke',
      payload,
    });
    const second = await server.inject({
      method: 'POST',
      url: '/v1/tools/record.write.mock/invoke',
      payload: {
        ...payload,
        arguments: { record: { title: 'changed' } },
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
});
