import {
  runTaskRequestSchema,
  runTaskResponseSchema,
  routerPreviewResponseSchema,
  type RouteSpec,
  type RunTaskRequest,
  type RunTaskResponse,
  type RouterPreviewResponse,
} from '@dar/contracts';
import { buildTaskWorkflowId } from '@dar/temporal';
import { defaultRouteSpecs, DEFAULT_AGENT_ID } from '../router/route-registry.js';
import { routeByRules } from '../router/rule-router.js';
import { createRequestId, createTaskRunId } from './task-id.js';

export interface NormalizedRunTaskRequest extends RunTaskRequest {
  request_id: string;
  tenant_id: string;
  user_id: string;
}

export function normalizeRunTaskRequest(input: unknown): NormalizedRunTaskRequest {
  const parsed = runTaskRequestSchema.parse(input);

  return {
    ...parsed,
    request_id: parsed.request_id ?? createRequestId(),
    tenant_id: parsed.tenant_id ?? 'default',
    user_id: parsed.user_id ?? 'anonymous',
  };
}

export function previewRoute(
  input: unknown,
  routes: RouteSpec[] = defaultRouteSpecs,
): RouterPreviewResponse {
  const normalized = normalizeRunTaskRequest(input);
  const result = routeByRules(
    {
      input: normalized.input,
      channel: normalized.channel,
      roles: normalized.roles,
    },
    routes,
  );

  return routerPreviewResponseSchema.parse(result);
}

export function createTaskRunPreview(
  input: unknown,
  routes: RouteSpec[] = defaultRouteSpecs,
): RunTaskResponse {
  const normalized = normalizeRunTaskRequest(input);
  const routeResult = routeByRules(
    {
      input: normalized.input,
      channel: normalized.channel,
      roles: normalized.roles,
    },
    routes,
  );

  const taskRunId = createTaskRunId();
  const workflowId = buildTaskWorkflowId(normalized.tenant_id, taskRunId);
  const decision = routeResult.route_decision;

  const base = {
    task_run_id: taskRunId,
    workflow_id: workflowId,
    route_decision: decision,
  };

  if (decision.decision === 'matched') {
    return runTaskResponseSchema.parse({
      ...base,
      status: 'queued',
      flow_id: decision.flow_id,
      flow_version: decision.flow_version,
    });
  }

  if (decision.decision === 'agent_fallback') {
    return runTaskResponseSchema.parse({
      ...base,
      status: 'queued',
      agent_id: decision.agent_id || DEFAULT_AGENT_ID,
    });
  }

  return runTaskResponseSchema.parse({
    ...base,
    status: 'created',
  });
}
