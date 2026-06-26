import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@dar/config';
import type { TenantRuntimePolicySnapshot, ToolManifest } from '@dar/contracts';
import { buildServiceIdentityHeaders } from '@dar/security';
import { buildServerWithReadiness } from '../src/index.js';
import { ToolGatewayReadinessService } from '../src/modules/readiness/tool-gateway-readiness-service.js';
import type { ToolManifestRegistry } from '../src/modules/tool-registry.js';
import { ToolService } from '../src/modules/tool-service.js';

class FakeRegistry implements ToolManifestRegistry {
  constructor(private readonly behavior: 'ok' | 'fail' = 'ok') {}

  async list(): Promise<ToolManifest[]> {
    if (this.behavior === 'fail') {
      throw new Error('registry secret');
    }
    return [];
  }

  async get(): Promise<ToolManifest | undefined> {
    return undefined;
  }
}

class FakeSnapshotStore {
  constructor(private readonly behavior: 'ok' | 'fail' = 'ok') {}

  async getByRef(): Promise<TenantRuntimePolicySnapshot | undefined> {
    if (this.behavior === 'fail') {
      throw new Error('snapshot secret');
    }
    return undefined;
  }
}

class FakeIdempotencyRepository {
  async get(idempotencyKey: string) {
    return {
      idempotency_key: idempotencyKey,
      tenant_id: 'tenant_1',
      target_type: 'tool',
      target_id: 'knowledge.search',
      request_hash: 'hash',
      status: 'succeeded' as const,
      response_json: { token: 'secret-token' },
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    };
  }
}

const config: RuntimeConfig = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
  APP_VERSION: '0.8.0',
  BUILD_SHA: 'test-sha',
  BUILD_TIME: '2026-01-01T00:00:00Z',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
  VALKEY_URL: 'redis://localhost:16380',
  TEMPORAL_ADDRESS: 'localhost:7233',
  TEMPORAL_NAMESPACE: 'default',
  MODEL_GATEWAY_BASE_URL: 'http://localhost:4100',
  MODEL_GATEWAY_API_KEY: 'dev-only-placeholder',
  MODEL_GATEWAY_MODE: 'disabled',
  MODEL_GATEWAY_PROTOCOL: 'dar_generate',
  MODEL_GATEWAY_TIMEOUT_MS: 30_000,
  MODEL_GATEWAY_MAX_RETRIES: 1,
  MODEL_GATEWAY_MAX_RESPONSE_BYTES: 1_000_000,
  MODEL_GATEWAY_ALLOW_INSECURE_HTTP: true,
  MODEL_GATEWAY_IDEMPOTENCY_HEADER: 'Idempotency-Key',
  MODEL_GATEWAY_USER_AGENT: 'durable-agent-runtime-lite/runtime-worker',
  PI_CONTEXT_MAX_BYTES: 262_144,
  PI_SEGMENT_TIMEOUT_MS: 120_000,
  PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW: 20,
  RUNTIME_API_AUTH_MODE: 'header',
  JWT_ISSUER: 'http://localhost:3000',
  JWT_AUDIENCE: 'durable-agent-runtime-lite',
  LOG_LEVEL: 'info',
  CONTROL_PLANE_PORT: 3000,
  RUNTIME_API_PORT: 3001,
  RUNTIME_WORKER_PORT: 3002,
  TOOL_GATEWAY_PORT: 3003,
  RUNTIME_WORKER_MODE: 'temporal',
  RUNTIME_API_WORKFLOW_STARTER: 'temporal',
  TOOL_GATEWAY_AUTH_MODE: 'service_token',
  TENANT_RUNTIME_POLICY_MODE: 'required',
  TENANT_POLICY_CACHE_TTL_MS: 5000,
  TENANT_ADMISSION_RECONCILE_ENABLED: false,
  TENANT_ADMISSION_STALE_AFTER_MS: 300_000,
  TENANT_ADMISSION_MAX_RECONCILE_BATCH: 50,
  TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED: false,
  TOOL_GATEWAY_RUNTIME_WORKER_TOKEN: 'runtime-worker-token-for-tests',
  TOOL_GATEWAY_CONTROL_PLANE_TOKEN: 'control-plane-token-for-tests',
  CONTROL_PLANE_AUTH_MODE: 'header',
  CONTROL_PLANE_SWAGGER_ENABLED: true,
};

describe('ToolGatewayReadinessService', () => {
  it('returns build metadata without exposing service tokens', async () => {
    const server = buildServerWithReadiness(new ToolService(), {
      ...config,
      APP_VERSION: '9.9.9-test',
      BUILD_SHA: 'abc123',
      BUILD_TIME: '2026-01-01T00:00:00Z',
    });

    const response = await server.inject({ method: 'GET', url: '/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'tool-gateway',
      version: '9.9.9-test',
      build_sha: 'abc123',
      build_time: '2026-01-01T00:00:00Z',
      message_key: 'common.health.versionReady',
      message: '服务版本信息可用。',
      locale: 'zh-CN',
    });
    expect(response.headers['content-language']).toBe('zh-CN');
    expect(response.headers.vary).toContain('Accept-Language');
    expect(response.body).not.toContain('runtime-worker-token-for-tests');

    await server.close();
  });

  it('reports ready when registry, snapshot store, and service auth are valid', async () => {
    const service = new ToolGatewayReadinessService({
      config,
      registry: new FakeRegistry(),
      tenantPolicySnapshotStore: new FakeSnapshotStore(),
      databaseProbe: async () => undefined,
    });
    const result = await service.check();
    expect(result.ready).toBe(true);
    expect(result.checks.service_auth.status).toBe('ok');
  });

  it('fails registry and snapshot probes without leaking error details', async () => {
    const service = new ToolGatewayReadinessService({
      config,
      registry: new FakeRegistry('fail'),
      tenantPolicySnapshotStore: new FakeSnapshotStore('fail'),
      databaseProbe: async () => undefined,
    });
    const result = await service.check();
    expect(result.ready).toBe(false);
    expect(result.checks.tool_registry.code).toBe('TOOL_REGISTRY_UNAVAILABLE');
    expect(result.checks.policy_snapshot_store.code).toBe('POLICY_SNAPSHOT_STORE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('fails DB probe independently', async () => {
    const service = new ToolGatewayReadinessService({
      config,
      registry: new FakeRegistry(),
      tenantPolicySnapshotStore: new FakeSnapshotStore(),
      databaseProbe: async () => { throw new Error('postgres://secret-db'); },
    });
    const result = await service.check();
    expect(result.ready).toBe(false);
    expect(result.checks.database.code).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('postgres://secret-db');
  });


  it('rejects missing, identical, placeholder, and timeout cases', async () => {
    const missing = await new ToolGatewayReadinessService({
      config: { ...config, TOOL_GATEWAY_RUNTIME_WORKER_TOKEN: undefined },
      registry: new FakeRegistry(),
      tenantPolicySnapshotStore: new FakeSnapshotStore(),
      databaseProbe: async () => undefined,
    }).check();
    expect(missing.checks.service_auth.code).toBe('SERVICE_AUTH_UNAVAILABLE');

    const identical = await new ToolGatewayReadinessService({
      config: { ...config, TOOL_GATEWAY_CONTROL_PLANE_TOKEN: config.TOOL_GATEWAY_RUNTIME_WORKER_TOKEN },
      registry: new FakeRegistry(),
      tenantPolicySnapshotStore: new FakeSnapshotStore(),
      databaseProbe: async () => undefined,
    }).check();
    expect(identical.checks.service_auth.status).toBe('failed');

    const placeholder = await new ToolGatewayReadinessService({
      config: { ...config, TOOL_GATEWAY_RUNTIME_WORKER_TOKEN: 'replace-with-runtime-worker-service-token' },
      registry: new FakeRegistry(),
      tenantPolicySnapshotStore: new FakeSnapshotStore(),
      databaseProbe: async () => undefined,
    }).check();
    expect(placeholder.checks.service_auth.status).toBe('failed');

    const timeout = await new ToolGatewayReadinessService({
      config,
      registry: { ...new FakeRegistry(), list: async () => new Promise((resolve) => setTimeout(() => resolve([]), 20)) },
      tenantPolicySnapshotStore: new FakeSnapshotStore(),
      databaseProbe: async () => undefined,
      probeTimeoutMs: 1,
      cacheTtlMs: 0,
    }).check();
    expect(timeout.checks.tool_registry.status).toBe('timeout');
  });
});

describe('tool-gateway debug idempotency endpoint', () => {
  it('is disabled by default', async () => {
    const server = buildServerWithReadiness(
      new ToolService({ idempotencyRepository: new FakeIdempotencyRepository() as never }),
      config,
    );
    const response = await server.inject({
      method: 'GET',
      url: '/v1/idempotency-records/key_1',
      headers: buildServiceIdentityHeaders({ serviceId: 'control-plane', token: config.TOOL_GATEWAY_CONTROL_PLANE_TOKEN }),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('DEBUG_ENDPOINT_DISABLED');
    await server.close();
  });

  it('requires idempotency:debug permission and allows control-plane when enabled', async () => {
    const debugConfig = { ...config, NODE_ENV: 'test' as const, APP_ENV: 'test', TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED: true };
    const server = buildServerWithReadiness(
      new ToolService({ idempotencyRepository: new FakeIdempotencyRepository() as never }),
      debugConfig,
    );
    const runtimeWorker = await server.inject({
      method: 'GET',
      url: '/v1/idempotency-records/key_1',
      headers: buildServiceIdentityHeaders({ serviceId: 'runtime-worker', token: debugConfig.TOOL_GATEWAY_RUNTIME_WORKER_TOKEN }),
    });
    expect(runtimeWorker.statusCode).toBe(403);

    const controlPlane = await server.inject({
      method: 'GET',
      url: '/v1/idempotency-records/key_1',
      headers: buildServiceIdentityHeaders({ serviceId: 'control-plane', token: debugConfig.TOOL_GATEWAY_CONTROL_PLANE_TOKEN }),
    });
    expect(controlPlane.statusCode).toBe(200);
    expect(controlPlane.json().data.idempotency_key).toBe('key_1');
    expect(controlPlane.json().data.response_json.token).toBe('[REDACTED]');
    await server.close();
  });
});
