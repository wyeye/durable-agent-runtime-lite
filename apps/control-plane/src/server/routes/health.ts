import type { FastifyInstance } from 'fastify';
import { getBuildInfo, type RuntimeConfig } from '@dar/config';

export async function healthRoutes(
  server: FastifyInstance,
  options: { config: RuntimeConfig; readyCheck: () => Promise<void> },
): Promise<void> {
  server.get('/healthz', async (request) => ({
    status: 'ok',
    app: 'control-plane',
    message_key: 'common.health.processAlive',
    message: request.t('common.health.processAlive'),
    locale: request.locale,
  }));

  server.get('/version', async (request) => ({
    ...getBuildInfo('control-plane', options.config),
    message_key: 'common.health.versionReady',
    message: request.t('common.health.versionReady'),
    locale: request.locale,
  }));

  server.get('/readyz', async (request, reply) => {
    try {
      await options.readyCheck();
      return {
        status: 'ready',
        app: 'control-plane',
        message_key: 'common.readiness.serviceReady',
        message: request.t('common.readiness.serviceReady'),
        locale: request.locale,
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
        message_key: 'common.readiness.serviceNotReady',
        message: request.t('common.readiness.serviceNotReady'),
        locale: request.locale,
        checks: {
          config: 'ok',
          database: 'unavailable',
        },
      };
    }
  });
}
