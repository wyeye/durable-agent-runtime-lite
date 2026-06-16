import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { getAppPort, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { startTemporalWorker } from './worker.js';

const appName = 'runtime-worker' as const;
const logger = createLogger(appName);

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/healthz', async () => ({
    status: 'ok',
    app: appName,
  }));

  server.get('/readyz', async () => ({
    status: 'ready',
    app: appName,
    checks: {
      config: 'ok',
      temporal_worker: 'mock',
    },
  }));

  return server;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  await startTemporalWorker(config);
  const server = buildServer();
  const port = getAppPort(appName, config);

  await server.listen({ host: config.HOST, port });
  logger.info({ app: appName, port, host: config.HOST }, `${appName} listening`);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    logger.error({ err: error }, `${appName} startup failed`);
    process.exit(1);
  });
}
