import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { getAppPort, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { createTaskRunPreview, previewRoute } from './modules/task/task-service.js';

const appName = 'runtime-api' as const;
const logger = createLogger(appName);

interface StandardSuccessResponse<T> {
  success: true;
  data: T;
  error: null;
  trace_id?: string;
}

interface StandardErrorResponse {
  success: false;
  data: null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  trace_id?: string;
}

function toSuccessResponse<T>(data: T, traceId?: string): StandardSuccessResponse<T> {
  return traceId
    ? { success: true, data, error: null, trace_id: traceId }
    : { success: true, data, error: null };
}

function toErrorResponse(error: unknown, traceId?: string): StandardErrorResponse {
  if (error instanceof ZodError) {
    const response: StandardErrorResponse = {
      success: false,
      data: null,
      error: {
        code: 'VALIDATION_FAILED',
        message: '请求参数不合法',
        details: { issues: error.issues },
      },
    };

    if (traceId) {
      response.trace_id = traceId;
    }

    return response;
  }

  const response: StandardErrorResponse = {
    success: false,
    data: null,
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务处理失败',
    },
  };

  if (traceId) {
    response.trace_id = traceId;
  }

  return response;
}

function getTraceId(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'trace_id' in body) {
    const traceId = (body as { trace_id?: unknown }).trace_id;
    return typeof traceId === 'string' ? traceId : undefined;
  }

  return undefined;
}

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
    },
  }));

  server.post('/v1/router/preview', async (request, reply) => {
    const traceId = getTraceId(request.body);

    try {
      return toSuccessResponse(previewRoute(request.body), traceId);
    } catch (error) {
      reply.code(error instanceof ZodError ? 400 : 500);
      return toErrorResponse(error, traceId);
    }
  });

  server.post('/v1/tasks', async (request, reply) => {
    const traceId = getTraceId(request.body);

    try {
      return toSuccessResponse(createTaskRunPreview(request.body), traceId);
    } catch (error) {
      reply.code(error instanceof ZodError ? 400 : 500);
      return toErrorResponse(error, traceId);
    }
  });

  return server;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const server = buildServer();
  const port = getAppPort(appName, config);

  await server.listen({ host: '0.0.0.0', port });
  logger.info({ app: appName, port }, `${appName} listening`);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    logger.error({ err: error }, `${appName} startup failed`);
    process.exit(1);
  });
}
