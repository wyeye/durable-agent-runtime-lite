import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RuntimeConfig } from '@dar/config';
import { getRuntimeApiUrl, getToolGatewayUrl, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { closeDb, createDb, type Database } from '@dar/db';
import { sql, type Kysely } from 'kysely';
import { RuntimeApiClient, type RuntimeApiOperationsClient } from './clients/runtime-api-client.js';
import { ToolGatewayClient, type ToolGatewayOperationsClient } from './clients/tool-gateway-client.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { openApiPlugin } from './plugins/openapi.js';
import { staticFilesPlugin } from './plugins/static-files.js';
import { healthRoutes } from './routes/health.js';
import { operationsRoutes } from './routes/operations.js';
import { registryRoutes } from './routes/registry.js';
import { RegistryApiService, type RegistryApi } from './services/registry-api-service.js';

export interface ControlPlaneAppOptions {
  config?: RuntimeConfig;
  db?: Kysely<Database>;
  runtimeApiClient?: RuntimeApiOperationsClient;
  toolGatewayClient?: ToolGatewayOperationsClient;
  registryService?: RegistryApi;
  readyCheck?: () => Promise<void>;
  staticRoot?: string;
}

export interface ControlPlaneAppHandle {
  app: FastifyInstance;
  close(): Promise<void>;
}

const appName = 'control-plane' as const;
const logger = createLogger(appName);

export async function createApp(options: ControlPlaneAppOptions = {}): Promise<ControlPlaneAppHandle> {
  const config = options.config ?? loadConfig();
  validateControlPlaneConfig(config);
  const needsDb = !options.db && (!options.registryService || !options.readyCheck);
  const createdDb = needsDb ? createDb({ databaseUrl: config.DATABASE_URL }) : undefined;
  const db = options.db ?? createdDb;
  const app = Fastify({ logger: false });
  const registryService: RegistryApi = options.registryService ?? new RegistryApiService(requireDb(db));
  const runtimeApiClient = options.runtimeApiClient ?? new RuntimeApiClient(getRuntimeApiUrl(config));
  const toolGatewayClient = options.toolGatewayClient ?? new ToolGatewayClient(
    getToolGatewayUrl(config),
    undefined,
    config.CONTROL_PLANE_TOOL_GATEWAY_TOKEN,
  );

  if (createdDb) {
    app.addHook('onClose', async () => {
      await closeDb(createdDb);
    });
  }

  await errorHandlerPlugin(app);
  await openApiPlugin(app, { config });
  await authPlugin(app, { config });
  await healthRoutes(app, {
    config,
    readyCheck: options.readyCheck ?? (async () => { await sql`select 1`.execute(requireDb(db)); }),
  });
  await registryRoutes(app, { service: registryService });
  await operationsRoutes(app, { registryService, runtimeApiClient, toolGatewayClient });

  app.addHook('onResponse', async (request, reply) => {
    logger.info({
      request_id: request.headers['x-request-id'],
      tenant_id: request.authContext?.tenant_id,
      user_id: request.authContext?.user_id,
      method: request.method,
      path: request.url,
      status_code: reply.statusCode,
    }, 'control-plane request completed');
  });

  if (config.NODE_ENV === 'production' || options.staticRoot) {
    await staticFilesPlugin(app, { rootDir: options.staticRoot ?? defaultStaticRoot() });
  }

  return {
    app,
    close: async () => {
      await app.close();
    },
  };
}

export async function buildServer(options: ControlPlaneAppOptions = {}): Promise<FastifyInstance> {
  const handle = await createApp(options);
  return handle.app;
}

function validateControlPlaneConfig(config: RuntimeConfig): void {
  const isProduction = config.NODE_ENV === 'production' || config.APP_ENV === 'production';
  if (isProduction && config.CONTROL_PLANE_AUTH_MODE !== 'header') {
    throw new Error('CONTROL_PLANE_AUTH_MODE=header is required in production');
  }
  if (isProduction && !config.RUNTIME_API_URL) {
    throw new Error('RUNTIME_API_URL is required in production');
  }
  if (isProduction && !config.TOOL_GATEWAY_URL && !config.TOOL_GATEWAY_BASE_URL) {
    throw new Error('TOOL_GATEWAY_URL is required in production');
  }
  if (isProduction && !config.CONTROL_PLANE_TOOL_GATEWAY_TOKEN) {
    throw new Error('CONTROL_PLANE_TOOL_GATEWAY_TOKEN is required in production');
  }
}

function defaultStaticRoot(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return join(current, '..', '..', 'public');
}

function requireDb(db: Kysely<Database> | undefined): Kysely<Database> {
  if (!db) {
    throw new Error('Database handle is required for control-plane registry operations');
  }
  return db;
}
