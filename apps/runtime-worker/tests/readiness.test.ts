import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@dar/config';
import { buildServer } from '../src/index.js';
import type { TemporalWorkerHandle } from '../src/worker.js';

describe('runtime-worker readiness', () => {
  it('returns not_ready after worker stops', async () => {
    const handle: TemporalWorkerHandle = {
      mode: 'mock',
      taskQueue: 'runtime-worker-main',
      state: { status: 'running', ready: true },
      shutdown: async () => undefined,
    };
    const server = buildServer(handle);

    const ready = await server.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', checks: { worker_status: 'running' } });

    handle.state.status = 'stopped';
    handle.state.ready = false;
    const stopped = await server.inject({ method: 'GET', url: '/readyz' });
    expect(stopped.statusCode).toBe(503);
    expect(stopped.json()).toMatchObject({ status: 'not_ready', checks: { worker_status: 'stopped' } });

    await server.close();
  });

  it('exposes failed worker state in readiness response', async () => {
    const server = buildServer({
      mode: 'temporal',
      state: { status: 'failed', ready: false, error: 'Temporal worker stopped unexpectedly' },
    });

    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        temporal_worker: 'temporal',
        worker_status: 'failed',
        worker_error: 'Temporal worker stopped unexpectedly',
      },
    });

    await server.close();
  });

  it('reports not_ready when production Pi mode is deterministic', async () => {
    const server = buildServer({
      mode: 'temporal',
      state: { status: 'running', ready: true },
    }, { ...config(), NODE_ENV: 'production', APP_ENV: 'production', PI_AGENT_MODE: 'deterministic' });

    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        pi_agent_mode: 'deterministic',
        pi_agent: 'not_ready',
        pi_error: 'PI_AGENT_MODE=model_gateway is required in production',
      },
    });

    await server.close();
  });
});

function config(): RuntimeConfig {
  return {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    APP_VERSION: '0.1.5',
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    VALKEY_URL: 'redis://localhost:16380',
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    MODEL_GATEWAY_BASE_URL: 'http://localhost:4100',
    MODEL_GATEWAY_API_KEY: 'dev-only-placeholder',
    MODEL_GATEWAY_MODEL: 'dar-local-model',
    MODEL_GATEWAY_TIMEOUT_MS: 30_000,
    MODEL_GATEWAY_MAX_RETRIES: 1,
    PI_AGENT_MODE: 'disabled',
    PI_CONTEXT_MAX_BYTES: 262_144,
    PI_SEGMENT_TIMEOUT_MS: 120_000,
    PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW: 20,
    JWT_ISSUER: 'http://localhost:3000',
    JWT_AUDIENCE: 'durable-agent-runtime-lite',
    LOG_LEVEL: 'info',
    CONTROL_PLANE_PORT: 3000,
    RUNTIME_API_PORT: 3001,
    RUNTIME_WORKER_PORT: 3002,
    TOOL_GATEWAY_PORT: 3003,
    RUNTIME_WORKER_MODE: 'mock',
    RUNTIME_API_WORKFLOW_STARTER: 'mock',
    RUNTIME_API_ROUTE_SOURCE: 'memory',
    TOOL_GATEWAY_REGISTRY_SOURCE: 'memory',
    CONTROL_PLANE_AUTH_MODE: 'header',
    CONTROL_PLANE_SWAGGER_ENABLED: true,
  };
}
