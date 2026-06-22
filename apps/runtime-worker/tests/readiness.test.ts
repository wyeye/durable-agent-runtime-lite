import { describe, expect, it } from 'vitest';
import { loadConfig, type RuntimeConfig } from '@dar/config';
import { buildServer } from '../src/index.js';
import type { TemporalWorkerHandle } from '../src/worker.js';

describe('runtime-worker readiness', () => {
  it('returns build metadata without exposing configuration secrets', async () => {
    const server = buildServer({
      mode: 'temporal',
      state: { status: 'running', ready: true },
    }, { ...config(), APP_VERSION: '9.9.9-test', BUILD_SHA: 'abc123', BUILD_TIME: '2026-01-01T00:00:00Z' });

    const response = await server.inject({ method: 'GET', url: '/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: 'runtime-worker',
      version: '9.9.9-test',
      build_sha: 'abc123',
      build_time: '2026-01-01T00:00:00Z',
      message_key: 'common.health.versionReady',
      message: '服务版本信息可用。',
      locale: 'zh-CN',
    });
    expect(Date.parse(response.json().process_started_at)).not.toBeNaN();
    expect(response.headers['content-language']).toBe('zh-CN');
    expect(response.headers.vary).toContain('Accept-Language');
    expect(response.body).not.toContain('dev-only-placeholder');

    await server.close();
  });

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

  it('reports evaluation worker readiness and task queue coverage', async () => {
    const readyServer = buildServer({
      mode: 'temporal',
      taskQueue: 'runtime-worker-main',
      taskQueues: ['runtime-worker-main', 'evaluation-worker-main'],
      evaluationTaskQueue: 'evaluation-worker-main',
      state: { status: 'running', ready: true },
      evaluationState: { status: 'running', ready: true },
      shutdown: async () => undefined,
    }, { ...config(), EVALUATION_WORKER_ENABLED: true });

    const ready = await readyServer.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ready',
      checks: {
        evaluation_worker_enabled: true,
        evaluation_task_queue: 'evaluation-worker-main',
        evaluation_worker_status: 'running',
        task_queues: ['runtime-worker-main', 'evaluation-worker-main'],
      },
    });

    await readyServer.close();

    const notReadyServer = buildServer({
      mode: 'temporal',
      taskQueue: 'runtime-worker-main',
      taskQueues: ['runtime-worker-main'],
      state: { status: 'running', ready: true },
      shutdown: async () => undefined,
    }, { ...config(), EVALUATION_WORKER_ENABLED: true });

    const notReady = await notReadyServer.inject({ method: 'GET', url: '/readyz' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        evaluation_worker_enabled: true,
        evaluation_task_queue: 'evaluation-worker-main',
        evaluation_worker_status: 'disabled',
      },
    });

    await notReadyServer.close();
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

  it('reports not_ready when production Model Gateway uses an invalid credential master key', async () => {
    const server = buildServer({
      mode: 'temporal',
      state: { status: 'running', ready: true },
    }, {
      ...config(),
      NODE_ENV: 'production',
      APP_ENV: 'production',
      PI_AGENT_MODE: 'model_gateway',
      MODEL_CREDENTIAL_MASTER_KEY: 'not-base64',
      MODEL_GATEWAY_ALLOW_INSECURE_HTTP: false,
    });

    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        pi_agent_mode: 'model_gateway',
        pi_agent: 'not_ready',
        pi_error: 'MODEL_CREDENTIAL_MASTER_KEY must be a base64 encoded 32-byte key',
      },
    });

    await server.close();
  });

  it('reports not_ready when production Model Gateway allows insecure HTTP', async () => {
    const server = buildServer({
      mode: 'temporal',
      state: { status: 'running', ready: true },
    }, {
      ...config(),
      NODE_ENV: 'production',
      APP_ENV: 'production',
      PI_AGENT_MODE: 'model_gateway',
      MODEL_GATEWAY_ALLOW_INSECURE_HTTP: true,
    });

    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: {
        pi_error: 'Production Model Gateway must not allow insecure HTTP',
      },
    });

    await server.close();
  });
});

function config(): RuntimeConfig {
  return {
    ...loadConfig({}),
    NODE_ENV: 'development',
    APP_ENV: 'local',
    APP_VERSION: '0.8.0',
    BUILD_SHA: 'test-sha',
    BUILD_TIME: '2026-01-01T00:00:00Z',
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    VALKEY_URL: 'redis://localhost:16380',
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    MODEL_GATEWAY_BASE_URL: 'http://localhost:4100',
    MODEL_GATEWAY_API_KEY: 'dev-only-placeholder',
    MODEL_GATEWAY_MODEL: 'dar-local-model',
    MODEL_GATEWAY_PROFILE_ID: 'local-dev',
    MODEL_GATEWAY_MODE: 'disabled',
    MODEL_GATEWAY_PROTOCOL: 'dar_generate',
    MODEL_GATEWAY_TIMEOUT_MS: 30_000,
    MODEL_GATEWAY_MAX_RETRIES: 1,
    MODEL_GATEWAY_MAX_RESPONSE_BYTES: 1_000_000,
    MODEL_CALL_LEDGER_MAX_RESPONSE_BYTES: 1_048_576,
    MODEL_GATEWAY_ALLOW_INSECURE_HTTP: true,
    MODEL_GATEWAY_IDEMPOTENCY_HEADER: 'Idempotency-Key',
    MODEL_GATEWAY_USER_AGENT: 'durable-agent-runtime-lite/runtime-worker',
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
