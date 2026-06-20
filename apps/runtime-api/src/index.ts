import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { StandardErrorResponse, StandardSuccessResponse } from '@dar/contracts';
import { getAppPort, getBuildInfo, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { AuthError } from '@dar/security';
import { TenantRuntimePolicyError } from '@dar/db';
import { HumanTaskService } from './modules/human-task/human-task-service.js';
import { createRuntimeApiTaskService, TaskService } from './modules/task/task-service.js';
import { AgentRunService } from './modules/task/agent-run-service.js';
import { RuntimeApiReadinessService, type ReadinessResult } from './modules/readiness/runtime-api-readiness-service.js';
import {
  readAuth,
  requireDecisionAuth,
  requireWriteAuth,
  runtimeAuthPlugin,
  withAuthBody,
  withAuthQuery,
} from './plugins/auth.js';

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
  if (error instanceof AuthError) {
    const response: StandardErrorResponse = {
      success: false,
      data: null,
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
      },
    };
    if (traceId) {
      response.trace_id = traceId;
    }
    return response;
  }
  if (error instanceof TenantRuntimePolicyError) {
    const response: StandardErrorResponse = {
      success: false,
      data: null,
      error: {
        code: error.code,
        message: error.message,
        ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
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

function errorStatus(error: unknown): number {
  if (error instanceof ZodError) {
    return 400;
  }
  if (error instanceof AuthError) {
    return error.code === 'UNAUTHORIZED' ? 401 : 403;
  }
  if (error instanceof TenantRuntimePolicyError) {
    return error.statusCode;
  }
  return 500;
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

export interface RuntimeApiReadinessChecker {
  check(): Promise<ReadinessResult>;
}

export function buildServer(
  taskService = new TaskService(),
  readiness: RuntimeApiReadiness | RuntimeApiReadinessChecker = { routeSource: 'memory', workflowStarter: 'mock' },
  humanTaskService = new HumanTaskService(),
  agentRunService = new AgentRunService(),
  config = loadConfig(),
): FastifyInstance {
  const server = Fastify({ logger: false });
  runtimeAuthPlugin(server, { config });

  server.get('/healthz', async () => ({
    status: 'ok',
    app: appName,
  }));

  server.get('/version', async () => getBuildInfo(appName, config));

  server.get('/readyz', async (_request, reply) => {
    if ('check' in readiness) {
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
        router: 'ok',
        route_source: readiness.routeSource,
        workflow_starter: readiness.workflowStarter,
      },
    };
  });

  server.post('/v1/router/preview', async (request, reply) => {
    const traceId = getTraceId(request.body);

    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await taskService.preview(withAuthBody(request, request.body, auth)), traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId);
    }
  });

  server.post('/v1/tasks', async (request, reply) => {
    const traceId = getTraceId(request.body);

    try {
      const auth = requireWriteAuth(request);
      return toSuccessResponse(await taskService.create(withAuthBody(request, request.body, auth)), traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId);
    }
  });

  server.get('/v1/tasks', async (request, reply) => {
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await taskService.list(withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error);
    }
  });

  server.get('/v1/tasks/:taskRunId', async (request, reply) => {
    const { taskRunId } = request.params as { taskRunId: string };
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      const query = withAuthQuery(request.query, auth);
      const taskRun = await taskService.get(taskRunId);
      const { tenant_id: tenantId } = query as { tenant_id?: string };
      if (!taskRun || (tenantId && taskRun.tenant_id !== tenantId)) {
        reply.code(404);
        return {
          success: false,
          data: null,
          error: { code: 'TASK_RUN_NOT_FOUND', message: '任务不存在' },
        };
      }
      return toSuccessResponse(taskRun);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error);
    }
  });

  server.post('/v1/agent-tasks', async (request, reply) => {
    const traceId = getTraceId(request.body);
    try {
      const auth = requireWriteAuth(request);
      return toSuccessResponse(await taskService.createAgentTask(withAuthBody(request, request.body, auth)), traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId);
    }
  });

  server.get('/v1/agent-runs', async (request, reply) => {
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await agentRunService.list(withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error);
    }
  });

  server.get('/v1/agent-runs/:agentRunId', async (request, reply) => {
    const { agentRunId } = request.params as { agentRunId: string };
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      const result = await agentRunService.get(agentRunId, withAuthQuery(request.query, auth));
      if (!result) {
        reply.code(404);
        return {
          success: false,
          data: null,
          error: { code: 'AGENT_RUN_NOT_FOUND', message: 'Agent run 不存在' },
        };
      }
      return toSuccessResponse(result);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error);
    }
  });

  server.get('/v1/agent-runs/:agentRunId/steps', async (request, reply) => {
    const { agentRunId } = request.params as { agentRunId: string };
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await agentRunService.listSteps(agentRunId, withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error);
    }
  });

  server.get('/v1/human-tasks', async (request, reply) => {
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await humanTaskService.list(withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error);
    }
  });

  server.get('/v1/human-tasks/:humanTaskId', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      const result = await humanTaskService.get(humanTaskId, withAuthQuery(request.query, auth));
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
      reply.code(errorStatus(error));
      return toErrorResponse(error);
    }
  });

  server.post('/v1/human-tasks/:humanTaskId/approve', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    const traceId = getTraceId(request.body);
    try {
      const auth = requireDecisionAuth(request);
      const result = await humanTaskService.approve(humanTaskId, withAuthBody(request, request.body, auth));
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
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId);
    }
  });

  server.post('/v1/human-tasks/:humanTaskId/reject', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    const traceId = getTraceId(request.body);
    try {
      const auth = requireDecisionAuth(request);
      const result = await humanTaskService.reject(humanTaskId, withAuthBody(request, request.body, auth));
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
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId);
    }
  });

  server.post('/v1/human-tasks/:humanTaskId/respond', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    const traceId = getTraceId(request.body);
    try {
      const auth = requireWriteAuth(request);
      const result = await humanTaskService.respond(humanTaskId, withAuthBody(request, request.body, auth));
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
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId);
    }
  });

  return server;
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const { taskService, humanTaskService, agentRunService, close, db, routeSource } = createRuntimeApiTaskService(config);
  const readiness = new RuntimeApiReadinessService({
    config,
    ...(db ? { db } : {}),
    ...(routeSource ? { routeSource } : {}),
  });
  const server = buildServer(taskService, readiness, humanTaskService, agentRunService, config);
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
