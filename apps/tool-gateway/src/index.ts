import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type {
  RuntimeError,
  StandardErrorResponse,
  StandardSuccessResponse,
  ToolCommitResponse,
  ToolInvokeResponse,
  ToolPreviewResponse,
} from '@dar/contracts';
import { getAppPort, getBuildInfo, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import {
  ServiceAuthError,
  StaticServiceTokenVerifier,
  type ServicePermission,
} from '@dar/security';
import {
  AuditEventRepository,
  closeDb,
  createDb,
  HumanTaskRepository,
  IdempotencyRecordRepository,
  TenantRuntimePolicySnapshotRepository,
  ToolCallLogRepository,
  type Database,
} from '@dar/db';
import type { RuntimeConfig } from '@dar/config';
import type { Kysely } from 'kysely';
import { DbAuditStore } from './modules/audit.js';
import { DbToolManifestRegistry, type ToolManifestRegistry } from './modules/tool-registry.js';
import { DbHumanTaskLookupStore, ToolService, type TenantPolicySnapshotLookupStore } from './modules/tool-service.js';
import { ToolGatewayReadinessService, type ToolGatewayReadinessResult } from './modules/readiness/tool-gateway-readiness-service.js';

const appName = 'tool-gateway' as const;
const logger = createLogger(appName);

function success<T>(data: T): StandardSuccessResponse<T> {
  return { success: true, data, error: null };
}

function failure(error: unknown): StandardErrorResponse {
  if (error instanceof ZodError) {
    return {
      success: false,
      data: null,
      error: { code: 'VALIDATION_FAILED', message: '请求参数不合法', details: { issues: error.issues } },
    };
  }

  return {
    success: false,
    data: null,
    error: { code: 'INTERNAL_ERROR', message: '服务处理失败' },
  };
}

function authFailure(error: ServiceAuthError): StandardErrorResponse {
  return {
    success: false,
    data: null,
    error: {
      code: error.code,
      message: error.message,
      ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
    },
  };
}

function runtimeFailure(error: RuntimeError): StandardErrorResponse {
  return {
    success: false,
    data: null,
    error,
  };
}

function deniedStatusCode(result: ToolInvokeResponse | ToolPreviewResponse | ToolCommitResponse): number {
  const code = result.error?.code;
  if (code === 'TOOL_NOT_FOUND' || code === 'TOOL_CALL_NOT_FOUND') {
    return 404;
  }
  if (code === 'TENANT_POLICY_HASH_MISMATCH' || code === 'EXECUTION_PLAN_HASH_MISMATCH') {
    return 409;
  }
  if (
    code === 'TOOL_DENIED_BY_TENANT_POLICY'
    || code === 'TENANT_RUNTIME_POLICY_NOT_FOUND'
    || code === 'TENANT_POLICY_SNAPSHOT_CONTEXT_MISSING'
    || code === 'TENANT_POLICY_SNAPSHOT_STORE_UNAVAILABLE'
    || code === 'TENANT_POLICY_SNAPSHOT_TENANT_MISMATCH'
  ) {
    return 403;
  }
  return 400;
}

function deniedError(result: ToolInvokeResponse | ToolPreviewResponse | ToolCommitResponse): RuntimeError {
  return {
    code: result.error?.code ?? 'TOOL_INVOKE_DENIED',
    message: result.error?.message ?? '工具调用被拒绝',
    details: {
      audit_event_id: result.audit_event_id,
      idempotency_key: result.idempotency_key,
      tool_name: result.tool_name,
      tool_version: result.tool_version,
      ...('tool_call_id' in result ? { tool_call_id: result.tool_call_id } : {}),
    },
  };
}

export function buildServer(toolService = new ToolService(), config: RuntimeConfig = loadConfig()): FastifyInstance {
  return buildServerWithReadiness(toolService, config);
}

export interface ToolGatewayReadinessChecker {
  check(): Promise<ToolGatewayReadinessResult>;
}

export function buildServerWithReadiness(
  toolService = new ToolService(),
  config: RuntimeConfig = loadConfig(),
  readiness?: ToolGatewayReadinessChecker,
): FastifyInstance {
  const server = Fastify({ logger: false });
  const serviceVerifier = new StaticServiceTokenVerifier({
    authMode: config.TOOL_GATEWAY_AUTH_MODE,
    nodeEnv: config.NODE_ENV,
    tokens: {
      'runtime-worker': config.TOOL_GATEWAY_RUNTIME_WORKER_TOKEN,
      'control-plane': config.TOOL_GATEWAY_CONTROL_PLANE_TOKEN,
    },
  });

  function authorize(request: { headers: Record<string, string | string[] | undefined> }, permission: ServicePermission): void {
    serviceVerifier.verify(request.headers, permission);
  }

  server.get('/healthz', async () => ({
    status: 'ok',
    app: appName,
  }));

  server.get('/version', async () => getBuildInfo(appName, config));

  server.get('/readyz', async (_request, reply) => {
    if (readiness) {
      const result = await readiness.check();
      reply.code(result.ready ? 200 : 503);
      return {
        status: result.ready ? 'ready' : 'not_ready',
        app: appName,
        ...result,
      };
    }
    return {
      status: 'ready',
      app: appName,
      checks: {
        config: 'ok',
        registry: 'ok',
      },
    };
  });

  server.get('/v1/tools', async (request, reply) => {
    try {
      authorize(request, 'tool_manifest:read');
      const { tenant_id: tenantId } = request.query as { tenant_id?: string };
      return success(await toolService.listTools(tenantId));
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(500);
      return failure(error);
    }
  });

  server.get('/v1/tools/:toolName', async (request, reply) => {
    try {
      authorize(request, 'tool_manifest:read');
      const { toolName } = request.params as { toolName: string };
      const { tenant_id: tenantId } = request.query as { tenant_id?: string };
      const manifest = await toolService.getTool(toolName, tenantId);
      if (!manifest) {
        reply.code(404);
        return { success: false, data: null, error: { code: 'TOOL_NOT_FOUND', message: '工具未注册' } };
      }
      return success(manifest);
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(500);
      return failure(error);
    }
  });

  server.post('/v1/tools/:toolName/invoke', async (request, reply) => {
    const { toolName } = request.params as { toolName: string };
    try {
      authorize(request, 'tool:invoke');
      const result = await toolService.invoke(toolName, request.body);
      if (result.status === 'denied') {
        reply.code(deniedStatusCode(result));
        logger.info(
          {
            request_id: (request.body as { request_id?: string } | undefined)?.request_id,
            tenant_id: (request.body as { tenant_id?: string } | undefined)?.tenant_id,
            user_id: ((request.body as { user_context?: Record<string, unknown> } | undefined)?.user_context?.user_id as string | undefined),
            task_run_id: ((request.body as { task_context?: Record<string, unknown> } | undefined)?.task_context?.task_run_id as string | undefined),
            tool_name: toolName,
            status: result.status,
            error_code: result.error?.code,
          },
          'tool invoke denied',
        );
        return runtimeFailure(deniedError(result));
      }
      logger.info(
        {
          request_id: (request.body as { request_id?: string } | undefined)?.request_id,
          tenant_id: (request.body as { tenant_id?: string } | undefined)?.tenant_id,
          user_id: ((request.body as { user_context?: Record<string, unknown> } | undefined)?.user_context?.user_id as string | undefined),
          task_run_id: ((request.body as { task_context?: Record<string, unknown> } | undefined)?.task_context?.task_run_id as string | undefined),
          tool_name: toolName,
        },
        'tool invoked',
      );
      return success(result);
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(error instanceof ZodError ? 400 : 500);
      return failure(error);
    }
  });

  server.post('/v1/tools/:toolName/preview', async (request, reply) => {
    const { toolName } = request.params as { toolName: string };
    try {
      authorize(request, 'tool:preview');
      const result = await toolService.preview(toolName, request.body);
      if (result.status === 'denied') {
        reply.code(deniedStatusCode(result));
        return runtimeFailure(deniedError(result));
      }
      return success(result);
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(error instanceof ZodError ? 400 : 500);
      return failure(error);
    }
  });

  server.post('/v1/tools/:toolName/commit', async (request, reply) => {
    const { toolName } = request.params as { toolName: string };
    try {
      authorize(request, 'tool:commit');
      const result = await toolService.commit(toolName, request.body);
      if (result.status === 'denied' || result.status === 'failed') {
        reply.code(deniedStatusCode(result));
        return runtimeFailure(deniedError(result));
      }
      return success(result);
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(error instanceof ZodError ? 400 : 500);
      return failure(error);
    }
  });

  server.get('/v1/audit-events', async (request, reply) => {
    try {
      authorize(request, 'audit:read');
      return success(await toolService.listAuditEvents(request.query));
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(500);
      return failure(error);
    }
  });

  server.get('/v1/tool-calls', async (request, reply) => {
    try {
      authorize(request, 'tool_call:read');
      return success(await toolService.listToolCalls(request.query));
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(500);
      return failure(error);
    }
  });

  server.get('/v1/tool-calls/:toolCallId', async (request, reply) => {
    try {
      authorize(request, 'tool_call:read');
      const { toolCallId } = request.params as { toolCallId: string };
      const toolCall = await toolService.getToolCall(toolCallId);
      if (!toolCall) {
        reply.code(404);
        return {
          success: false,
          data: null,
          error: { code: 'TOOL_CALL_NOT_FOUND', message: '工具调用记录不存在' },
        };
      }
      return success(toolCall);
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(500);
      return failure(error);
    }
  });

  server.get('/v1/idempotency-records/:idempotencyKey', async (request, reply) => {
    try {
      if (!config.TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED) {
        reply.code(404);
        return {
          success: false,
          data: null,
          error: { code: 'DEBUG_ENDPOINT_DISABLED', message: 'Debug endpoint is disabled' },
        };
      }
      authorize(request, 'idempotency:debug');
      const { idempotencyKey } = request.params as { idempotencyKey: string };
      const record = await toolService.getIdempotencyRecord(idempotencyKey);
      if (!record) {
        reply.code(404);
        return {
          success: false,
          data: null,
          error: { code: 'IDEMPOTENCY_RECORD_NOT_FOUND', message: '幂等记录不存在' },
        };
      }
      return success(record);
    } catch (error) {
      if (error instanceof ServiceAuthError) {
        reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403);
        return authFailure(error);
      }
      reply.code(500);
      return failure(error);
    }
  });

  return server;
}

export interface ToolGatewayServiceHandle {
  toolService: ToolService;
  db?: Kysely<Database>;
  registry?: ToolManifestRegistry;
  tenantPolicySnapshotStore?: TenantPolicySnapshotLookupStore;
  close(): Promise<void>;
}

export function createToolGatewayService(config: RuntimeConfig = loadConfig()): ToolGatewayServiceHandle {
  if (isProductionRuntime(config) && config.TOOL_GATEWAY_REGISTRY_SOURCE !== 'db') {
    throw new Error('TOOL_GATEWAY_REGISTRY_SOURCE=db is required in production');
  }
  if (isProductionRuntime(config) && config.TOOL_GATEWAY_AUTH_MODE !== 'service_token') {
    throw new Error('TOOL_GATEWAY_AUTH_MODE=service_token is required in production');
  }
  if (isProductionRuntime(config) && config.TENANT_RUNTIME_POLICY_MODE !== 'required') {
    throw new Error('TENANT_RUNTIME_POLICY_MODE=required is required in production');
  }
  if (isProductionRuntime(config)) {
    new StaticServiceTokenVerifier({
      authMode: config.TOOL_GATEWAY_AUTH_MODE,
      nodeEnv: config.NODE_ENV,
      tokens: {
        'runtime-worker': config.TOOL_GATEWAY_RUNTIME_WORKER_TOKEN,
        'control-plane': config.TOOL_GATEWAY_CONTROL_PLANE_TOKEN,
      },
    }).validateConfiguration();
  }

  if (config.TOOL_GATEWAY_REGISTRY_SOURCE === 'db') {
    const db: Kysely<Database> = createDb({ databaseUrl: config.DATABASE_URL });
    const registry = new DbToolManifestRegistry(db);
    const tenantPolicySnapshotStore = new TenantRuntimePolicySnapshotRepository(db);
    return {
      toolService: new ToolService({
        registry,
        auditStore: new DbAuditStore(new AuditEventRepository(db)),
        idempotencyRepository: new IdempotencyRecordRepository(db),
        toolCallLogStore: new ToolCallLogRepository(db),
        humanTaskStore: new DbHumanTaskLookupStore(new HumanTaskRepository(db)),
        tenantPolicySnapshotStore,
        tenantPolicyMode: config.TENANT_RUNTIME_POLICY_MODE,
      }),
      db,
      registry,
      tenantPolicySnapshotStore,
      close: async () => closeDb(db),
    };
  }

  return {
    toolService: new ToolService(),
    close: async () => undefined,
  };
}

function isProductionRuntime(config: RuntimeConfig): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const { toolService, close, db, registry, tenantPolicySnapshotStore } = createToolGatewayService(config);
  const readiness = new ToolGatewayReadinessService({
    config,
    ...(db ? { db } : {}),
    ...(registry ? { registry } : {}),
    ...(tenantPolicySnapshotStore ? { tenantPolicySnapshotStore } : {}),
  });
  const server = buildServerWithReadiness(toolService, config, readiness);
  const port = getAppPort(appName, config);

  server.addHook('onClose', async () => {
    await close();
  });

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
