import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@dar/config';
import type { RouteSpec } from '@dar/contracts';
import { RuntimeApiReadinessService } from '../src/modules/readiness/runtime-api-readiness-service.js';
import type { RouteSpecSource } from '../src/modules/router/route-source.js';

class FakeRouteSource implements RouteSpecSource {
  constructor(private readonly behavior: 'ok' | 'fail' = 'ok') {}

  async listPublished(): Promise<RouteSpec[]> {
    if (this.behavior === 'fail') {
      throw new Error('postgres://secret-route-registry');
    }
    return [];
  }
}

const productionConfig: RuntimeConfig = {
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
  MODEL_GATEWAY_MODEL: 'dar-local-model',
  MODEL_GATEWAY_MODE: 'disabled',
  MODEL_GATEWAY_PROTOCOL: 'dar_generate',
  MODEL_GATEWAY_TIMEOUT_MS: 30_000,
  MODEL_GATEWAY_MAX_RETRIES: 1,
  MODEL_GATEWAY_MAX_RESPONSE_BYTES: 1_000_000,
  MODEL_GATEWAY_ALLOW_INSECURE_HTTP: true,
  MODEL_GATEWAY_IDEMPOTENCY_HEADER: 'Idempotency-Key',
  MODEL_GATEWAY_USER_AGENT: 'durable-agent-runtime-lite/runtime-worker',
  PI_AGENT_MODE: 'disabled',
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
  RUNTIME_API_ROUTE_SOURCE: 'db',
  TOOL_GATEWAY_REGISTRY_SOURCE: 'db',
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

describe('RuntimeApiReadinessService', () => {
  it('reports ready when all injected probes succeed', async () => {
    const service = new RuntimeApiReadinessService({
      config: productionConfig,
      routeSource: new FakeRouteSource(),
      databaseProbe: async () => undefined,
      temporalProbe: async () => undefined,
      tenantPolicyProbe: async () => undefined,
    });

    const result = await service.check();
    expect(result.ready).toBe(true);
    expect(result.checks.temporal.status).toBe('ok');
    expect(result.checks.route_registry.status).toBe('ok');
  });

  it('fails route registry without leaking internal error text', async () => {
    const service = new RuntimeApiReadinessService({
      config: productionConfig,
      routeSource: new FakeRouteSource('fail'),
      databaseProbe: async () => undefined,
      temporalProbe: async () => undefined,
      tenantPolicyProbe: async () => undefined,
    });

    const result = await service.check();
    expect(result.ready).toBe(false);
    expect(result.checks.route_registry).toMatchObject({
      status: 'failed',
      code: 'ROUTE_REGISTRY_UNAVAILABLE',
    });
    expect(JSON.stringify(result)).not.toContain('postgres://secret-route-registry');
  });

  it('fails Temporal and policy probes independently', async () => {
    const service = new RuntimeApiReadinessService({
      config: productionConfig,
      routeSource: new FakeRouteSource(),
      databaseProbe: async () => undefined,
      temporalProbe: async () => { throw new Error('temporal secret'); },
      tenantPolicyProbe: async () => { throw new Error('policy secret'); },
    });

    const result = await service.check();
    expect(result.ready).toBe(false);
    expect(result.checks.temporal.code).toBe('TEMPORAL_UNAVAILABLE');
    expect(result.checks.tenant_policy.code).toBe('TENANT_POLICY_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('fails DB probe independently', async () => {
    const service = new RuntimeApiReadinessService({
      config: productionConfig,
      routeSource: new FakeRouteSource(),
      databaseProbe: async () => { throw new Error('postgres://secret-db'); },
      temporalProbe: async () => undefined,
      tenantPolicyProbe: async () => undefined,
    });

    const result = await service.check();
    expect(result.ready).toBe(false);
    expect(result.checks.database.code).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('postgres://secret-db');
  });


  it('fails production config errors and probe timeouts', async () => {
    const invalidConfig = { ...productionConfig, RUNTIME_API_AUTH_MODE: 'disabled' as const };
    const service = new RuntimeApiReadinessService({
      config: invalidConfig,
      routeSource: new FakeRouteSource(),
      databaseProbe: async () => undefined,
      temporalProbe: async () => new Promise((resolve) => setTimeout(resolve, 20)),
      tenantPolicyProbe: async () => undefined,
      probeTimeoutMs: 1,
      cacheTtlMs: 0,
    });

    const result = await service.check();
    expect(result.ready).toBe(false);
    expect(result.checks.config.code).toBe('CONFIG_UNAVAILABLE');
    expect(result.checks.temporal.status).toBe('timeout');
  });
});
