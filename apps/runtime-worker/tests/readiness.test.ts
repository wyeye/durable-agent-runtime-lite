import { describe, expect, it } from 'vitest';
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
});
