import type { FastifyInstance } from 'fastify';
import {
  humanTaskDecisionRequestSchema,
  humanTaskQuerySchema,
  agentRunQuerySchema,
  agentStepQuerySchema,
  operationAuditQuerySchema,
  taskRunQuerySchema,
  tenantAgentAdmissionQuerySchema,
  tenantPolicySnapshotQuerySchema,
  toolCallQuerySchema,
} from '@dar/contracts';
import type { RuntimeApiOperationsClient } from '../clients/runtime-api-client.js';
import type { ToolGatewayOperationsClient } from '../clients/tool-gateway-client.js';
import type { RegistryApi } from '../services/registry-api-service.js';
import { requirePermission } from '../plugins/auth.js';
import { jsonSchema, ok, requestIdOf } from '../utils/http.js';

export interface OperationsRoutesOptions {
  registryService: RegistryApi;
  runtimeApiClient: RuntimeApiOperationsClient;
  toolGatewayClient: ToolGatewayOperationsClient;
}

export async function operationsRoutes(server: FastifyInstance, options: OperationsRoutesOptions): Promise<void> {
  server.get('/api/v1/operations/dashboard', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const headers = forward(auth, requestIdOf(request));
    const [counts, humanTasks, runningTasks, waitingTasks, failedTasks, recentReleases] = await Promise.all([
      options.registryService.registryCounts(auth.tenant_id),
      options.runtimeApiClient.listHumanTasks(withTenant({ tenant_id: auth.tenant_id, status: 'pending', page_size: '100' }), headers),
      options.runtimeApiClient.listTaskRuns(withTenant({ tenant_id: auth.tenant_id, status: 'running', page_size: '100' }), headers),
      options.runtimeApiClient.listTaskRuns(withTenant({ tenant_id: auth.tenant_id, status: 'waiting_human', page_size: '100' }), headers),
      options.runtimeApiClient.listTaskRuns(withTenant({ tenant_id: auth.tenant_id, status: 'failed', page_size: '10' }), headers),
      options.registryService.listReleases({ tenantId: auth.tenant_id, page: 1, pageSize: 10 }),
    ]);
    return ok({
      registry_counts: counts,
      pending_human_task_count: humanTasks.human_tasks.length,
      running_task_count: runningTasks.length,
      waiting_human_task_count: waitingTasks.length,
      failed_task_count: failedTasks.length,
      recent_releases: recentReleases.items,
      recent_failed_tasks: failedTasks,
    }, auth.request_id);
  });

  server.get('/api/v1/operations/human-tasks', {
    schema: { querystring: jsonSchema(humanTaskQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const query = humanTaskQuerySchema.parse(request.query);
    return ok(await options.runtimeApiClient.listHumanTasks(withTenant({ ...query, tenant_id: auth.tenant_id }), forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/operations/human-tasks/:humanTaskId', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const { humanTaskId } = request.params as { humanTaskId: string };
    return ok(await options.runtimeApiClient.getHumanTask(humanTaskId, withTenant({ tenant_id: auth.tenant_id }), forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.post('/api/v1/operations/human-tasks/:humanTaskId/approve', {
    schema: { body: jsonSchema(humanTaskDecisionRequestSchema.partial({ tenant_id: true, user_id: true })) },
  }, async (request) => {
    const auth = requirePermission(request, 'human_task:decide');
    const { humanTaskId } = request.params as { humanTaskId: string };
    const body = {
      ...asObject(request.body),
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      request_id: requestIdOf(request) ?? auth.request_id,
    };
    return ok(await options.runtimeApiClient.approveHumanTask(humanTaskId, body, forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.post('/api/v1/operations/human-tasks/:humanTaskId/reject', {
    schema: { body: jsonSchema(humanTaskDecisionRequestSchema.partial({ tenant_id: true, user_id: true })) },
  }, async (request) => {
    const auth = requirePermission(request, 'human_task:decide');
    const { humanTaskId } = request.params as { humanTaskId: string };
    const body = {
      ...asObject(request.body),
      tenant_id: auth.tenant_id,
      user_id: auth.user_id,
      request_id: requestIdOf(request) ?? auth.request_id,
    };
    return ok(await options.runtimeApiClient.rejectHumanTask(humanTaskId, body, forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/operations/task-runs', {
    schema: { querystring: jsonSchema(taskRunQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const query = taskRunQuerySchema.parse(request.query);
    return ok(await options.runtimeApiClient.listTaskRuns(withTenant({ ...query, tenant_id: auth.tenant_id }), forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/operations/task-runs/:taskRunId', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const { taskRunId } = request.params as { taskRunId: string };
    return ok(await options.runtimeApiClient.getTaskRun(taskRunId, forward(auth, requestIdOf(request)), auth.tenant_id), auth.request_id);
  });

  server.get('/api/v1/operations/agent-runs', {
    schema: { querystring: jsonSchema(agentRunQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const query = agentRunQuerySchema.parse(request.query);
    return ok(await options.runtimeApiClient.listAgentRuns(withTenant({ ...query, tenant_id: auth.tenant_id }), forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/operations/agent-runs/:agentRunId', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const { agentRunId } = request.params as { agentRunId: string };
    return ok(await options.runtimeApiClient.getAgentRun(agentRunId, withTenant({ tenant_id: auth.tenant_id }), forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/operations/agent-runs/:agentRunId/steps', {
    schema: { querystring: jsonSchema(agentStepQuerySchema.omit({ agent_run_id: true })) },
  }, async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const { agentRunId } = request.params as { agentRunId: string };
    const query = agentStepQuerySchema.omit({ agent_run_id: true }).parse(request.query);
    return ok(await options.runtimeApiClient.listAgentSteps(agentRunId, withTenant({ ...query, tenant_id: auth.tenant_id }), forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/operations/audit-events', {
    schema: { querystring: jsonSchema(operationAuditQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const query = operationAuditQuerySchema.parse(request.query);
    return ok(await options.toolGatewayClient.listAuditEvents(withTenant({ ...query, tenant_id: auth.tenant_id }), forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/operations/tool-calls', {
    schema: { querystring: jsonSchema(toolCallQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const query = toolCallQuerySchema.parse(request.query);
    return ok(await options.toolGatewayClient.listToolCalls(withTenant({ ...query, tenant_id: auth.tenant_id }), forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/operations/tool-calls/:toolCallId', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const { toolCallId } = request.params as { toolCallId: string };
    return ok(await options.toolGatewayClient.getToolCall(toolCallId, forward(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/tenant-runtime-policy-snapshots', {
    schema: { querystring: jsonSchema(tenantPolicySnapshotQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const query = tenantPolicySnapshotQuerySchema.parse(request.query);
    return ok(await options.registryService.listTenantPolicySnapshots({ ...query, tenant_id: auth.tenant_id }, { tenantId: auth.tenant_id }), auth.request_id);
  });

  server.get('/api/v1/tenant-runtime-policy-snapshots/:snapshotId', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const { snapshotId } = request.params as { snapshotId: string };
    return ok(await options.registryService.getTenantPolicySnapshot(snapshotId, { tenantId: auth.tenant_id }), auth.request_id);
  });

  server.get('/api/v1/tenant-agent-admissions', {
    schema: { querystring: jsonSchema(tenantAgentAdmissionQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const query = tenantAgentAdmissionQuerySchema.parse(request.query);
    return ok(await options.registryService.listTenantAgentAdmissions({ ...query, tenant_id: auth.tenant_id }, { tenantId: auth.tenant_id }), auth.request_id);
  });

  server.get('/api/v1/tenant-agent-admissions/:admissionId', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    const { admissionId } = request.params as { admissionId: string };
    return ok(await options.registryService.getTenantAgentAdmission(admissionId, { tenantId: auth.tenant_id }), auth.request_id);
  });
}

function forward(auth: { user_id: string; tenant_id: string; roles: string[] }, requestId?: string) {
  return {
    userId: auth.user_id,
    tenantId: auth.tenant_id,
    roles: auth.roles,
    ...(requestId ? { requestId } : {}),
  };
}

function withTenant(values: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  return params;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
