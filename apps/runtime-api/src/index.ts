import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { StandardErrorResponse, StandardSuccessResponse } from '@dar/contracts';
import { getAppPort, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { HumanTaskService } from './modules/human-task/human-task-service.js';
import { createRuntimeApiTaskService, TaskService } from './modules/task/task-service.js';

const appName = 'runtime-api' as const;
const logger = createLogger(appName);

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

export interface RuntimeApiReadiness {
  routeSource: 'db' | 'memory';
  workflowStarter: 'mock' | 'temporal';
}

export function buildServer(
  taskService = new TaskService(),
  readiness: RuntimeApiReadiness = { routeSource: 'memory', workflowStarter: 'mock' },
  humanTaskService = new HumanTaskService(),
): FastifyInstance {
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
      router: 'ok',
      route_source: readiness.routeSource,
      workflow_starter: readiness.workflowStarter,
    },
  }));

  server.post('/v1/router/preview', async (request, reply) => {
    const traceId = getTraceId(request.body);

    try {
      return toSuccessResponse(await taskService.preview(request.body), traceId);
    } catch (error) {
      reply.code(error instanceof ZodError ? 400 : 500);
      return toErrorResponse(error, traceId);
    }
  });

  server.post('/v1/tasks', async (request, reply) => {
    const traceId = getTraceId(request.body);

    try {
      return toSuccessResponse(await taskService.create(request.body), traceId);
    } catch (error) {
      reply.code(error instanceof ZodError ? 400 : 500);
      return toErrorResponse(error, traceId);
    }
  });

  server.get('/v1/tasks/:taskRunId', async (request, reply) => {
    const { taskRunId } = request.params as { taskRunId: string };
    const taskRun = await taskService.get(taskRunId);
    if (!taskRun) {
      reply.code(404);
      return {
        success: false,
        data: null,
        error: { code: 'TASK_RUN_NOT_FOUND', message: '任务不存在' },
      };
    }

    return toSuccessResponse(taskRun);
  });

  server.get('/v1/human-tasks', async (request, reply) => {
    try {
      return toSuccessResponse(await humanTaskService.list(request.query));
    } catch (error) {
      reply.code(error instanceof ZodError ? 400 : 500);
      return toErrorResponse(error);
    }
  });

  server.get('/v1/human-tasks/:humanTaskId', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    try {
      const result = await humanTaskService.get(humanTaskId, request.query);
      if (!result) {
        reply.code(404);
        return {
          success: false,
          data: null,
          error: { code: 'HUMAN_TASK_NOT_FOUND', message: '人工任务不存在' },
        };
      }
      return toSuccessResponse(result);
    } catch (error) {
      reply.code(error instanceof ZodError ? 400 : 500);
      return toErrorResponse(error);
    }
  });

  server.post('/v1/human-tasks/:humanTaskId/approve', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    const traceId = getTraceId(request.body);
    try {
      const result = await humanTaskService.approve(humanTaskId, request.body);
      if (!result) {
        reply.code(404);
        return {
          success: false,
          data: null,
          error: { code: 'HUMAN_TASK_NOT_FOUND', message: '人工任务不存在' },
        };
      }
      return toSuccessResponse(result, traceId);
    } catch (error) {
      reply.code(error instanceof ZodError ? 400 : 500);
      return toErrorResponse(error, traceId);
    }
  });

  server.post('/v1/human-tasks/:humanTaskId/reject', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    const traceId = getTraceId(request.body);
    try {
      const result = await humanTaskService.reject(humanTaskId, request.body);
      if (!result) {
        reply.code(404);
        return {
          success: false,
          data: null,
          error: { code: 'HUMAN_TASK_NOT_FOUND', message: '人工任务不存在' },
        };
      }
      return toSuccessResponse(result, traceId);
    } catch (error) {
      reply.code(error instanceof ZodError ? 400 : 500);
      return toErrorResponse(error, traceId);
    }
  });

  return server;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const { taskService, humanTaskService, close } = createRuntimeApiTaskService(config);
  const server = buildServer(taskService, {
    routeSource: config.RUNTIME_API_ROUTE_SOURCE,
    workflowStarter: config.RUNTIME_API_WORKFLOW_STARTER,
  }, humanTaskService);
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
