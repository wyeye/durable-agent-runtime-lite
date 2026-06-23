import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { StandardErrorResponse, StandardSuccessResponse } from '@dar/contracts';
import { getAppPort, getBuildInfo, loadConfig } from '@dar/config';
import { createLogger, logErrorEvent, logEvent } from '@dar/logger';
import {
  errorResponse,
  installFastifyLocale,
  requestLocale,
  successResponse,
  zodErrorResponse,
} from '@dar/i18n';
import { AuthError } from '@dar/security';
import { EvaluationRepositoryError, TenantRuntimePolicyError } from '@dar/db';
import { HumanTaskService } from './modules/human-task/human-task-service.js';
import { createRuntimeApiTaskService, TaskService } from './modules/task/task-service.js';
import { AgentRunService } from './modules/task/agent-run-service.js';
import { EvaluationRunService } from './modules/evaluation/evaluation-run-service.js';
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
  return successResponse(data, responseOptions(traceId)) as StandardSuccessResponse<T>;
}

function toErrorResponse(error: unknown, traceId?: string, locale?: unknown): StandardErrorResponse {
  if (error instanceof ZodError) {
    return zodErrorResponse(error, responseOptions(traceId, locale)) as StandardErrorResponse;
  }
  if (error instanceof AuthError) {
    return errorResponse({
      code: error.code,
      ...detailsOf(error.details),
    }, responseOptions(traceId, locale)) as StandardErrorResponse;
  }
  if (error instanceof TenantRuntimePolicyError) {
    return errorResponse({
      code: error.code,
      ...detailsOf(error.details),
    }, responseOptions(traceId, locale)) as StandardErrorResponse;
  }
  if (error instanceof EvaluationRepositoryError) {
    return errorResponse({
      code: error.code,
      ...detailsOf(error.details),
    }, responseOptions(traceId, locale)) as StandardErrorResponse;
  }
  if (error instanceof Error && error.message.startsWith('ROUTER_EMBEDDING_UNAVAILABLE')) {
    return errorResponse({
      code: 'ROUTER_EMBEDDING_UNAVAILABLE',
    }, responseOptions(traceId, locale)) as StandardErrorResponse;
  }
  if (error instanceof Error && error.message.startsWith('ROUTER_EMBEDDING_MODEL')) {
    return errorResponse({
      code: 'ROUTER_EMBEDDING_MODEL_INVALID',
    }, responseOptions(traceId, locale)) as StandardErrorResponse;
  }

  return errorResponse({ code: 'INTERNAL_ERROR' }, responseOptions(traceId, locale)) as StandardErrorResponse;
}

function responseOptions(traceId?: string, locale?: unknown): { traceId?: string; locale?: unknown } {
  return {
    ...(traceId ? { traceId } : {}),
    ...(locale ? { locale } : {}),
  };
}

function detailsOf(details: Record<string, unknown>): { details?: Record<string, unknown> } {
  return Object.keys(details).length > 0 ? { details } : {};
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
  if (error instanceof EvaluationRepositoryError) {
    if (error.code.endsWith('_NOT_FOUND')) {
      return 404;
    }
    if (error.code.includes('REQUIRED') || error.code.includes('MISMATCH') || error.code === 'TENANT_REQUIRED') {
      return 400;
    }
    return 409;
  }
  if (error instanceof Error && error.message.startsWith('ROUTER_EMBEDDING_UNAVAILABLE')) {
    return 503;
  }
  if (error instanceof Error && error.message.startsWith('ROUTER_EMBEDDING_MODEL')) {
    return 503;
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
  evaluationRunService: EvaluationRunService | undefined = undefined,
  config = loadConfig(),
): FastifyInstance {
  const server = Fastify({ logger: false });
  installFastifyLocale(server);
  runtimeAuthPlugin(server, { config });

  server.get('/healthz', async (request) => ({
    status: 'ok',
    app: appName,
    message_key: 'common.health.processAlive',
    message: request.t('common.health.processAlive'),
    locale: request.locale,
  }));

  server.get('/version', async (request) => ({
    ...getBuildInfo(appName, config),
    message_key: 'common.health.versionReady',
    message: request.t('common.health.versionReady'),
    locale: request.locale,
  }));

  server.get('/readyz', async (request, reply) => {
    if ('check' in readiness) {
      const result = await readiness.check();
      reply.code(result.ready ? 200 : 503);
      return {
        status: result.ready ? 'ready' : 'not_ready',
        app: appName,
        message_key: result.ready ? 'common.readiness.serviceReady' : 'common.readiness.serviceNotReady',
        message: request.t(result.ready ? 'common.readiness.serviceReady' : 'common.readiness.serviceNotReady'),
        locale: request.locale,
        ...result,
      };
    }
    return {
      status: 'ready',
      app: appName,
      message_key: 'common.readiness.serviceReady',
      message: request.t('common.readiness.serviceReady'),
      locale: request.locale,
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
      return toSuccessResponse(await taskService.preview(withRequestLocale(withAuthBody(request, request.body, auth), request)), traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId, requestLocale(request));
    }
  });

  server.post('/v1/tasks', async (request, reply) => {
    const traceId = getTraceId(request.body);

    try {
      const auth = requireWriteAuth(request);
      return toSuccessResponse(await taskService.create(withRequestLocale(withAuthBody(request, request.body, auth), request)), traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId, requestLocale(request));
    }
  });

  server.get('/v1/tasks', async (request, reply) => {
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await taskService.list(withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
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
        return errorResponse({ code: 'TASK_RUN_NOT_FOUND' }, { locale: requestLocale(request) });
      }
      return toSuccessResponse(taskRun);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.post('/v1/agent-tasks', async (request, reply) => {
    const traceId = getTraceId(request.body);
    try {
      const auth = requireWriteAuth(request);
      return toSuccessResponse(await taskService.createAgentTask(withRequestLocale(withAuthBody(request, request.body, auth), request)), traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId, requestLocale(request));
    }
  });

  server.post('/v1/evaluation-runs', async (request, reply) => {
    const traceId = getTraceId(request.body);
    try {
      if (!evaluationRunService) {
        reply.code(503);
        return toErrorResponse(new EvaluationRepositoryError(
          'EVALUATION_RUNTIME_UNAVAILABLE',
          'Evaluation runtime requires database-backed runtime-api',
        ), traceId, requestLocale(request));
      }
      const auth = requireWriteAuth(request);
      return toSuccessResponse(await evaluationRunService.create(withRequestLocale(withAuthBody(request, request.body, auth), request)), traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId, requestLocale(request));
    }
  });

  server.get('/v1/evaluation-runs', async (request, reply) => {
    try {
      if (!evaluationRunService) {
        reply.code(503);
        return toErrorResponse(new EvaluationRepositoryError(
          'EVALUATION_RUNTIME_UNAVAILABLE',
          'Evaluation runtime requires database-backed runtime-api',
        ), undefined, requestLocale(request));
      }
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await evaluationRunService.list(withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.get('/v1/evaluation-runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      if (!evaluationRunService) {
        reply.code(503);
        return toErrorResponse(new EvaluationRepositoryError(
          'EVALUATION_RUNTIME_UNAVAILABLE',
          'Evaluation runtime requires database-backed runtime-api',
        ), undefined, requestLocale(request));
      }
      const auth = request.authContext ? readAuth(request) : undefined;
      const run = await evaluationRunService.get(runId, withAuthQuery(request.query, auth));
      if (!run) {
        reply.code(404);
        return errorResponse({ code: 'EVALUATION_RUN_NOT_FOUND' }, { locale: requestLocale(request) });
      }
      return toSuccessResponse(run);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.get('/v1/evaluation-runs/:runId/results', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    try {
      if (!evaluationRunService) {
        reply.code(503);
        return toErrorResponse(new EvaluationRepositoryError(
          'EVALUATION_RUNTIME_UNAVAILABLE',
          'Evaluation runtime requires database-backed runtime-api',
        ), undefined, requestLocale(request));
      }
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse({
        evaluation_run_id: runId,
        results: await evaluationRunService.listResults(runId, withAuthQuery(request.query, auth)),
      });
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.post('/v1/evaluation-runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const traceId = getTraceId(request.body);
    try {
      if (!evaluationRunService) {
        reply.code(503);
        return toErrorResponse(new EvaluationRepositoryError(
          'EVALUATION_RUNTIME_UNAVAILABLE',
          'Evaluation runtime requires database-backed runtime-api',
        ), traceId, requestLocale(request));
      }
      const auth = requireWriteAuth(request);
      return toSuccessResponse(await evaluationRunService.cancel(runId, withRequestLocale(withAuthBody(request, request.body, auth), request)), traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId, requestLocale(request));
    }
  });

  server.get('/v1/agent-runs', async (request, reply) => {
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await agentRunService.list(withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.get('/v1/agent-runs/:agentRunId', async (request, reply) => {
    const { agentRunId } = request.params as { agentRunId: string };
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      const result = await agentRunService.get(agentRunId, withAuthQuery(request.query, auth));
      if (!result) {
        reply.code(404);
        return errorResponse({ code: 'AGENT_RUN_NOT_FOUND' }, { locale: requestLocale(request) });
      }
      return toSuccessResponse(result);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.get('/v1/agent-runs/:agentRunId/steps', async (request, reply) => {
    const { agentRunId } = request.params as { agentRunId: string };
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await agentRunService.listSteps(agentRunId, withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.get('/v1/human-tasks', async (request, reply) => {
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      return toSuccessResponse(await humanTaskService.list(withAuthQuery(request.query, auth)));
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.get('/v1/human-tasks/:humanTaskId', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    try {
      const auth = request.authContext ? readAuth(request) : undefined;
      const result = await humanTaskService.get(humanTaskId, withAuthQuery(request.query, auth));
      if (!result) {
        reply.code(404);
        return errorResponse({ code: 'HUMAN_TASK_NOT_FOUND' }, { locale: requestLocale(request) });
      }
      return toSuccessResponse(result);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, undefined, requestLocale(request));
    }
  });

  server.post('/v1/human-tasks/:humanTaskId/approve', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    const traceId = getTraceId(request.body);
    try {
      const auth = requireDecisionAuth(request);
      const result = await humanTaskService.approve(humanTaskId, withRequestLocale(withAuthBody(request, request.body, auth), request));
      if (!result) {
        reply.code(404);
        return errorResponse({ code: 'HUMAN_TASK_NOT_FOUND' }, { locale: requestLocale(request) });
      }
      return toSuccessResponse(result, traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId, requestLocale(request));
    }
  });

  server.post('/v1/human-tasks/:humanTaskId/reject', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    const traceId = getTraceId(request.body);
    try {
      const auth = requireDecisionAuth(request);
      const result = await humanTaskService.reject(humanTaskId, withRequestLocale(withAuthBody(request, request.body, auth), request));
      if (!result) {
        reply.code(404);
        return errorResponse({ code: 'HUMAN_TASK_NOT_FOUND' }, { locale: requestLocale(request) });
      }
      return toSuccessResponse(result, traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId, requestLocale(request));
    }
  });

  server.post('/v1/human-tasks/:humanTaskId/respond', async (request, reply) => {
    const { humanTaskId } = request.params as { humanTaskId: string };
    const traceId = getTraceId(request.body);
    try {
      const auth = requireWriteAuth(request);
      const result = await humanTaskService.respond(humanTaskId, withRequestLocale(withAuthBody(request, request.body, auth), request));
      if (!result) {
        reply.code(404);
        return errorResponse({ code: 'HUMAN_TASK_NOT_FOUND' }, { locale: requestLocale(request) });
      }
      return toSuccessResponse(result, traceId);
    } catch (error) {
      reply.code(errorStatus(error));
      return toErrorResponse(error, traceId, requestLocale(request));
    }
  });

  return server;
}

function withRequestLocale<T>(body: T, request: { locale?: 'zh-CN' }): T & { request_locale: 'zh-CN' } {
  return {
    ...(body && typeof body === 'object' ? body : {}),
    request_locale: request.locale ?? 'zh-CN',
  } as T & { request_locale: 'zh-CN' };
}

export async function start(): Promise<void> {
  const config = loadConfig();
  const { taskService, humanTaskService, agentRunService, evaluationRunService, close, db, routeSource } = createRuntimeApiTaskService(config);
  const readiness = new RuntimeApiReadinessService({
    config,
    ...(db ? { db } : {}),
    ...(routeSource ? { routeSource } : {}),
  });
  const server = buildServer(taskService, readiness, humanTaskService, agentRunService, evaluationRunService, config);
  const port = getAppPort(appName, config);

  server.addHook('onClose', async () => {
    await close();
  });

  await server.listen({ host: config.HOST, port });
  logEvent(logger, 'info', 'app.started', { service: appName }, { app: appName, port, host: config.HOST });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    logErrorEvent(logger, 'app.startup_failed', error, { service: appName }, { app: appName });
    process.exit(1);
  });
}
