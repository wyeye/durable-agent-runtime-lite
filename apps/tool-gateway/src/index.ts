import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { RuntimeError, StandardErrorResponse, StandardSuccessResponse, ToolInvokeResponse } from '@dar/contracts';
import { getAppPort, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { ToolService } from './modules/tool-service.js';

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
    error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : '服务处理失败' },
  };
}

function runtimeFailure(error: RuntimeError): StandardErrorResponse {
  return {
    success: false,
    data: null,
    error,
  };
}

function deniedStatusCode(result: ToolInvokeResponse): number {
  return result.error?.code === 'TOOL_NOT_FOUND' ? 404 : 400;
}

function deniedError(result: ToolInvokeResponse): RuntimeError {
  return {
    code: result.error?.code ?? 'TOOL_INVOKE_DENIED',
    message: result.error?.message ?? '工具调用被拒绝',
    details: {
      audit_event_id: result.audit_event_id,
      idempotency_key: result.idempotency_key,
      tool_name: result.tool_name,
      tool_version: result.tool_version,
    },
  };
}

export function buildServer(toolService = new ToolService()): FastifyInstance {
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
      registry: 'ok',
    },
  }));

  server.get('/v1/tools', async () => success(await toolService.listTools()));

  server.get('/v1/tools/:toolName', async (request, reply) => {
    const { toolName } = request.params as { toolName: string };
    const manifest = await toolService.getTool(toolName);
    if (!manifest) {
      reply.code(404);
      return { success: false, data: null, error: { code: 'TOOL_NOT_FOUND', message: '工具未注册' } };
    }
    return success(manifest);
  });

  server.post('/v1/tools/:toolName/invoke', async (request, reply) => {
    const { toolName } = request.params as { toolName: string };
    try {
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
      reply.code(error instanceof ZodError ? 400 : 500);
      return failure(error);
    }
  });

  server.get('/v1/audit-events', async () => success(toolService.listAuditEvents()));

  return server;
}

export async function start(): Promise<void> {
  const config = loadConfig();
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
