import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RuntimeConfig } from '@dar/config';
import { getRuntimeApiUrl, getToolGatewayUrl, loadConfig } from '@dar/config';
import { createLogger, logEvent } from '@dar/logger';
import { closeDb, createDb, type Database } from '@dar/db';
import { installFastifyLocale } from '@dar/i18n';
import { sql, type Kysely } from 'kysely';
import { RuntimeApiClient, type RuntimeApiOperationsClient } from './clients/runtime-api-client.js';
import { ToolGatewayClient, type ToolGatewayOperationsClient } from './clients/tool-gateway-client.js';
import { authPlugin } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { openApiPlugin } from './plugins/openapi.js';
import { staticFilesPlugin } from './plugins/static-files.js';
import { healthRoutes } from './routes/health.js';
import { evaluationRoutes } from './routes/evaluation.js';
import { operationsRoutes } from './routes/operations.js';
import { registryRoutes } from './routes/registry.js';
import { modelCatalogRoutes } from './routes/model-catalog.js';
import { EvaluationApiService, type EvaluationApi } from './services/evaluation-api-service.js';
import { ModelCatalogService, type ModelCatalogApi } from './services/model-catalog-service.js';
import { RegistryApiService, type RegistryApi } from './services/registry-api-service.js';

export interface ControlPlaneAppOptions {
  config?: RuntimeConfig;
  db?: Kysely<Database>;
  runtimeApiClient?: RuntimeApiOperationsClient;
  toolGatewayClient?: ToolGatewayOperationsClient;
  registryService?: RegistryApi;
  evaluationService?: EvaluationApi;
  modelCatalogService?: ModelCatalogApi;
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
  const needsDb = !options.db && (!options.registryService || !options.evaluationService || !options.modelCatalogService || !options.readyCheck);
  const createdDb = needsDb ? createDb({ databaseUrl: config.DATABASE_URL }) : undefined;
  const db = options.db ?? createdDb;
  const app = Fastify({ logger: false });
  const registryService: RegistryApi = options.registryService ?? new RegistryApiService(
    requireDb(db),
    { evaluationGateMode: config.EVALUATION_GATE_MODE },
  );
  const evaluationService: EvaluationApi = options.evaluationService ?? new EvaluationApiService(requireDb(db));
  const modelCatalogService: ModelCatalogApi = options.modelCatalogService ?? new ModelCatalogService(
    requireDb(db),
    config.MODEL_CREDENTIAL_MASTER_KEY,
  );
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

  installFastifyLocale(app);
  await errorHandlerPlugin(app);
  await openApiPlugin(app, { config });
  await authPlugin(app, { config });
  await healthRoutes(app, {
    config,
    readyCheck: options.readyCheck ?? (async () => { await sql`select 1`.execute(requireDb(db)); }),
  });
  await registryRoutes(app, { service: registryService });
  await modelCatalogRoutes(app, { service: modelCatalogService });
  await evaluationRoutes(app, { service: evaluationService });
  await operationsRoutes(app, { registryService, runtimeApiClient, toolGatewayClient });

  app.addHook('onResponse', async (request, reply) => {
    logEvent(logger, 'info', 'http.request_completed', { service: appName }, compactBindings({
      request_id: headerString(request.headers['x-request-id']),
      tenant_id: request.authContext?.tenant_id,
      user_id: request.authContext?.user_id,
      method: request.method,
      path: request.url,
      status_code: reply.statusCode,
    }));
  });

  if (shouldServeStaticFiles(config, options)) {
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

export function shouldServeStaticFiles(
  config: Pick<RuntimeConfig, 'NODE_ENV' | 'CONTROL_PLANE_STATIC_ENABLED'>,
  options: Pick<ControlPlaneAppOptions, 'staticRoot'> = {},
): boolean {
  return config.NODE_ENV === 'production' || config.CONTROL_PLANE_STATIC_ENABLED || Boolean(options.staticRoot);
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
  if (isProduction && config.EVALUATION_GATE_MODE !== 'required') {
    throw new Error('EVALUATION_GATE_MODE=required is required in production');
  }
  if (isProduction && !config.MODEL_CREDENTIAL_MASTER_KEY) {
    throw new Error('MODEL_CREDENTIAL_MASTER_KEY is required in production');
  }
}

function defaultStaticRoot(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  return join(current, '..', '..', 'public');
}

function requireDb(db: Kysely<Database> | undefined): Kysely<Database> {
  if (!db) {
    throw new Error('Database handle is required for control-plane services');
  }
  return db;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function compactBindings(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
