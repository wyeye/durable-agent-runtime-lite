import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { getAppPort, loadConfig, type RuntimeConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { startTemporalWorker, type TemporalWorkerHandle } from './worker.js';

const appName = 'runtime-worker' as const;
const logger = createLogger(appName);

export function buildServer(
  worker: Pick<TemporalWorkerHandle, 'mode' | 'state'> = {
    mode: 'mock',
    state: { status: 'running', ready: true },
  },
  config: RuntimeConfig = loadConfig(),
): FastifyInstance {
  const server = Fastify({ logger: false });

  server.get('/healthz', async () => ({
    status: 'ok',
    app: appName,
  }));

  server.get('/readyz', async (_request, reply) => {
    const piReady = piReadiness(config);
    if (!worker.state.ready || !piReady.ready) {
      reply.code(503);
    }
    return {
      status: worker.state.ready && piReady.ready ? 'ready' : 'not_ready',
      app: appName,
      checks: {
        config: 'ok',
        temporal_worker: worker.mode,
        worker_status: worker.state.status,
        pi_agent_mode: config.PI_AGENT_MODE,
        pi_agent: piReady.status,
        model_gateway_profile: config.MODEL_GATEWAY_PROFILE_ID,
        ...(worker.state.error ? { worker_error: worker.state.error } : {}),
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

function piReadiness(config: RuntimeConfig): { ready: boolean; status: string; error?: string } {
  const production = config.NODE_ENV === 'production' || config.APP_ENV === 'production';
  if (production && config.PI_AGENT_MODE !== 'model_gateway') {
    return {
      ready: false,
      status: 'not_ready',
      error: 'PI_AGENT_MODE=model_gateway is required in production',
    };
  }
  if (
    config.PI_AGENT_MODE === 'model_gateway' &&
    (!config.MODEL_GATEWAY_BASE_URL || !config.MODEL_GATEWAY_API_KEY)
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error: 'Model Gateway configuration is incomplete',
    };
  }
  if (
    production &&
    config.PI_AGENT_MODE === 'model_gateway' &&
    /^dev-only-|placeholder/iu.test(config.MODEL_GATEWAY_API_KEY)
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error: 'Production Model Gateway API key must be provided by secret management',
    };
  }
  if (
    production &&
    config.PI_AGENT_MODE === 'model_gateway' &&
    config.MODEL_GATEWAY_PROFILE_ID === 'local-ollama'
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error: 'local-ollama Model Gateway profile is development/test only',
    };
  }
  if (
    production &&
    config.PI_AGENT_MODE === 'model_gateway' &&
    config.MODEL_GATEWAY_API_KEY === 'ollama'
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error: 'Ollama compatibility API key is development/test only',
    };
  }
  if (
    production &&
    config.PI_AGENT_MODE === 'model_gateway' &&
    !config.MODEL_GATEWAY_ALLOW_INSECURE_HTTP &&
    !config.MODEL_GATEWAY_BASE_URL.startsWith('https://')
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error:
        'Production Model Gateway URL must use HTTPS unless insecure HTTP is explicitly allowed',
    };
  }
  if (
    production &&
    config.PI_AGENT_MODE === 'model_gateway' &&
    config.MODEL_GATEWAY_ALLOW_INSECURE_HTTP
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error: 'Production Model Gateway must not allow insecure HTTP',
    };
  }
  if (
    production &&
    config.PI_AGENT_MODE === 'model_gateway' &&
    config.MODEL_GATEWAY_MODE !== 'openai_compatible'
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error: 'MODEL_GATEWAY_MODE=openai_compatible is required in production',
    };
  }
  if (
    production &&
    config.PI_AGENT_MODE === 'model_gateway' &&
    config.MODEL_GATEWAY_PROTOCOL !== 'openai_chat_completions'
  ) {
    return {
      ready: false,
      status: 'not_ready',
      error: 'MODEL_GATEWAY_PROTOCOL=openai_chat_completions is required in production',
    };
  }
  return { ready: true, status: config.PI_AGENT_MODE };
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    logger.error({ err: error }, `${appName} startup failed`);
    process.exit(1);
  });
}
