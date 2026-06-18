import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { getAppPort, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { startTemporalWorker, type TemporalWorkerHandle } from './worker.js';

const appName = 'runtime-worker' as const;
const logger = createLogger(appName);

export function buildServer(worker: Pick<TemporalWorkerHandle, 'mode' | 'state'> = {
  mode: 'mock',
  state: { status: 'running', ready: true },
}): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/healthz', async () => ({
    status: 'ok',
    app: appName,
  }));

  server.get('/readyz', async (_request, reply) => {
    if (!worker.state.ready) {
      reply.code(503);
    }
    return {
      status: worker.state.ready ? 'ready' : 'not_ready',
      app: appName,
      checks: {
        config: 'ok',
        temporal_worker: worker.mode,
        worker_status: worker.state.status,
        ...(worker.state.error ? { worker_error: worker.state.error } : {}),
      },
    };
  });

  return server;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const workerHandle = await startTemporalWorker(config);
  const server = buildServer(workerHandle);
  const port = getAppPort(appName, config);
  let shuttingDown = false;

  await server.listen({ host: config.HOST, port });
  logger.info({ app: appName, port, host: config.HOST }, `${appName} listening`);

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'runtime-worker graceful shutdown started');
    await server.close();
    await workerHandle.shutdown();
    logger.info({ signal }, 'runtime-worker graceful shutdown completed');
  }

  process.once('SIGTERM', () => {
    shutdown('SIGTERM').catch((error: unknown) => {
      logger.error({ err: error }, 'runtime-worker shutdown failed');
      process.exitCode = 1;
    });
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT').catch((error: unknown) => {
      logger.error({ err: error }, 'runtime-worker shutdown failed');
      process.exitCode = 1;
    });
  });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    logger.error({ err: error }, `${appName} startup failed`);
    process.exit(1);
  });
}
