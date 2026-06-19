import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { releaseListRequestSchema } from '@dar/contracts';
import type { RegistryApi } from '../services/registry-api-service.js';
import { authOf, requirePermission } from '../plugins/auth.js';
import { jsonSchema, ok, requestIdOf } from '../utils/http.js';
import { registerRegistryResourceRoutes } from './registry-resource.js';

const flowRoutePublishSchema = z.object({
  flow_id: z.string().min(1),
  flow_version: z.number().int().positive(),
  route_id: z.string().min(1),
  route_version: z.number().int().positive(),
  release_note: z.string().min(1),
  metadata_json: z.record(z.string(), z.unknown()).default({}),
});

export async function registryRoutes(server: FastifyInstance, options: { service: RegistryApi }): Promise<void> {
  await registerRegistryResourceRoutes(server, {
    resourceType: 'flow',
    plural: 'flows',
    idParam: 'flowId',
    service: options.service,
  });
  await registerRegistryResourceRoutes(server, {
    resourceType: 'route',
    plural: 'routes',
    idParam: 'routeId',
    service: options.service,
  });
  await registerRegistryResourceRoutes(server, {
    resourceType: 'tool',
    plural: 'tools',
    idParam: 'toolName',
    service: options.service,
  });
  await registerRegistryResourceRoutes(server, {
    resourceType: 'agent',
    plural: 'agents',
    idParam: 'agentId',
    service: options.service,
  });
  await registerRegistryResourceRoutes(server, {
    resourceType: 'prompt',
    plural: 'prompts',
    idParam: 'promptId',
    service: options.service,
  });
  await registerRegistryResourceRoutes(server, {
    resourceType: 'tenant_runtime_policy',
    plural: 'tenant-runtime-policies',
    idParam: 'tenantId',
    service: options.service,
  });
  await registerRegistryResourceRoutes(server, {
    resourceType: 'model_policy',
    plural: 'model-policies',
    idParam: 'modelPolicyId',
    service: options.service,
  });

  server.post('/api/v1/releases/flow-route', {
    schema: { body: jsonSchema(flowRoutePublishSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:publish');
    const body = flowRoutePublishSchema.parse(request.body);
    const requestId = requestIdOf(request) ?? auth.request_id;
    return ok(await options.service.publishFlowWithRoute(body, {
      tenantId: auth.tenant_id,
      operatorId: auth.user_id,
      ...(requestId ? { requestId } : {}),
    }), auth.request_id);
  });

  server.get('/api/v1/releases', {
    schema: { querystring: jsonSchema(releaseListRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'release:read');
    const query = releaseListRequestSchema.parse(request.query);
    return ok(await options.service.listReleases({
      tenantId: auth.tenant_id,
      ...(query.resource_type ? { resourceType: query.resource_type } : {}),
      ...(query.resource_id ? { resourceId: query.resource_id } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.operator_id ? { operatorId: query.operator_id } : {}),
      ...(query.start_time ? { startTime: query.start_time } : {}),
      ...(query.end_time ? { endTime: query.end_time } : {}),
      page: query.page,
      pageSize: query.page_size,
    }), auth.request_id);
  });

  server.get('/api/v1/releases/:releaseId', async (request) => {
    const auth = requirePermission(request, 'release:read');
    const { releaseId } = request.params as { releaseId: string };
    return ok(await options.service.getRelease(releaseId), auth.request_id);
  });

  server.get('/api/v1/whoami', async (request) => ok(authOf(request)));
}
