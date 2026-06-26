import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { getAppPort, getBuildInfo, loadConfig, type RuntimeConfig } from '@dar/config';
import { createLogger, logErrorEvent, logEvent } from '@dar/logger';
import { installFastifyLocale } from '@dar/i18n';
import { parseModelCredentialMasterKey } from '@dar/security';
import { startTemporalWorker, type TemporalWorkerHandle } from './worker.js';

const appName = 'runtime-worker' as const;
const logger = createLogger(appName);
const processStartedAt = new Date().toISOString();

export function buildServer(
  worker: Pick<TemporalWorkerHandle, 'mode' | 'state' | 'taskQueues' | 'evaluationTaskQueue' | 'evaluationState'> = {
    mode: 'mock',
    taskQueues: ['runtime-worker-main'],
    state: { status: 'running', ready: true },
  },
  config: RuntimeConfig = loadConfig(),
): FastifyInstance {
  const server = Fastify({ logger: false });
  installFastifyLocale(server);

  server.get('/healthz', async (request) => ({
    status: 'ok',
    app: appName,
    message_key: 'common.health.processAlive',
    message: request.t('common.health.processAlive'),
    locale: request.locale,
  }));

  server.get('/version', async (request) => ({
    ...getBuildInfo(appName, config),
    process_started_at: processStartedAt,
    message_key: 'common.health.versionReady',
    message: request.t('common.health.versionReady'),
    locale: request.locale,
  }));

  server.get('/readyz', async (request, reply) => {
    const piReady = piReadiness(config);
    const evaluationReady = !config.EVALUATION_WORKER_ENABLED || Boolean(worker.evaluationState?.ready);
    if (!worker.state.ready || !evaluationReady || !piReady.ready) {
      reply.code(503);
    }
    const ready = worker.state.ready && evaluationReady && piReady.ready;
    return {
      status: ready ? 'ready' : 'not_ready',
      app: appName,
      message_key: ready ? 'common.readiness.serviceReady' : 'common.readiness.serviceNotReady',
      message: request.t(ready ? 'common.readiness.serviceReady' : 'common.readiness.serviceNotReady'),
      locale: request.locale,
      checks: {
        config: 'ok',
        temporal_worker: worker.mode,
        worker_status: worker.state.status,
        task_queues: worker.taskQueues,
        evaluation_worker_enabled: config.EVALUATION_WORKER_ENABLED,
        evaluation_task_queue: config.EVALUATION_TASK_QUEUE,
        evaluation_worker_status: worker.evaluationState?.status ?? 'disabled',
        pi_agent_mode: 'model_gateway',
        pi_agent: piReady.status,
        ...(worker.state.error ? { worker_error: worker.state.error } : {}),
        ...(worker.evaluationState?.error ? { evaluation_worker_error: worker.evaluationState.error } : {}),
        ...(piReady.error ? { pi_error: piReady.error } : {}),
      },
    };
  });

  return server;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const workerHandle = await startTemporalWorker(config);
  const server = buildServer(workerHandle, config);
  const port = getAppPort(appName, config);
  let shuttingDown = false;

  await server.listen({ host: config.HOST, port });
  logEvent(logger, 'info', 'app.started', { service: appName }, { app: appName, port, host: config.HOST });

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logEvent(logger, 'info', 'app.shutdown_started', { service: appName }, { signal });
    await server.close();
    await workerHandle.shutdown();
    logEvent(logger, 'info', 'app.shutdown_completed', { service: appName }, { signal });
  }

  process.once('SIGTERM', () => {
    shutdown('SIGTERM').catch((error: unknown) => {
      logErrorEvent(logger, 'app.shutdown_failed', error, { service: appName }, { signal: 'SIGTERM' });
      process.exitCode = 1;
    });
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT').catch((error: unknown) => {
      logErrorEvent(logger, 'app.shutdown_failed', error, { service: appName }, { signal: 'SIGINT' });
      process.exitCode = 1;
    });
  });
}

function piReadiness(config: RuntimeConfig): { ready: boolean; status: string; error?: string } {
  const production = config.NODE_ENV === 'production' || config.APP_ENV === 'production';
  try {
    parseModelCredentialMasterKey(config.MODEL_CREDENTIAL_MASTER_KEY);
  } catch {
    return {
      ready: false,
      status: 'not_ready',
      error: 'MODEL_CREDENTIAL_MASTER_KEY must be a base64 encoded 32-byte key',
    };
  }
  if (
    production &&
    config.MODEL_GATEWAY_ALLOW_INSECURE_HTTP
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error: 'Production Model Gateway must not allow insecure HTTP',
    };
  }
  return { ready: true, status: 'model_gateway' };
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    logErrorEvent(logger, 'app.startup_failed', error, { service: appName }, { app: appName });
    process.exit(1);
  });
}
