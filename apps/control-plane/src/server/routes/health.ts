import type { FastifyInstance } from 'fastify';
import { getBuildInfo, type RuntimeConfig } from '@dar/config';

export async function healthRoutes(
  server: FastifyInstance,
  options: { config: RuntimeConfig; readyCheck: () => Promise<void> },
): Promise<void> {
  server.get('/healthz', async () => ({
    status: 'ok',
    app: 'control-plane',
  }));

  server.get('/version', async () => getBuildInfo('control-plane', options.config));

  server.get('/readyz', async (request, reply) => {
    try {
      await options.readyCheck();
      return {
        status: 'ready',
        app: 'control-plane',
        checks: {
          config: 'ok',
          database: 'ok',
        },
      };
    } catch {
      reply.code(503);
      return {
        status: 'not_ready',
        app: 'control-plane',
        checks: {
          config: 'ok',
          database: 'unavailable',
        },
      };
    }
  });
}
