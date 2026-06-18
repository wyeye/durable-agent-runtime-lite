import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import {
  cloneVersionRequestSchema,
  createDraftRequestSchema,
  disableResourceRequestSchema,
  grayResourceRequestSchema,
  publishResourceRequestSchema,
  registryListRequestSchema,
  rollbackResourceRequestSchema,
  updateDraftRequestSchema,
  validateResourceRequestSchema,
  type RegistryResourceType,
} from '@dar/contracts';
import type { RegistryApi } from '../services/registry-api-service.js';
import { parseVersionParam } from '../services/registry-api-service.js';
import { authOf, requirePermission } from '../plugins/auth.js';
import { jsonSchema, ok, requestIdOf } from '../utils/http.js';

export interface RegistryRouteOptions {
  resourceType: RegistryResourceType;
  plural: string;
  idParam: string;
  service: RegistryApi;
}

export async function registerRegistryResourceRoutes(
  server: FastifyInstance,
  options: RegistryRouteOptions,
): Promise<void> {
  const base = `/api/v1/${options.plural}`;
  const idPath = `${base}/:${options.idParam}`;

  server.get(base, {
    schema: { querystring: jsonSchema(registryListRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.list(options.resourceType, request.query, { tenantId: auth.tenant_id }), auth.request_id);
  });

  server.post(base, {
    schema: { body: jsonSchema(createDraftRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:write');
    const body = createDraftRequestSchema.parse(request.body);
    return ok(await options.service.createDraft(options.resourceType, body.spec, actor(auth, requestIdOf(request))));
  });

  server.get(`${idPath}/versions`, async (request) => {
    const auth = requirePermission(request, 'registry:read');
    const resourceId = resourceIdOf(request.params, options.idParam);
    return ok(await options.service.listVersions(options.resourceType, resourceId, { tenantId: auth.tenant_id }), auth.request_id);
  });

  server.get(`${idPath}/versions/:version`, async (request) => {
    const auth = requirePermission(request, 'registry:read');
    const resourceId = resourceIdOf(request.params, options.idParam);
    const version = parseVersionParam(versionOf(request.params));
    return ok(await options.service.getVersion(options.resourceType, resourceId, version, { tenantId: auth.tenant_id }), auth.request_id);
  });

  server.put(`${idPath}/versions/:version`, {
    schema: { body: jsonSchema(updateDraftRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:write');
    const body = updateDraftRequestSchema.parse(request.body);
    const resourceId = resourceIdOf(request.params, options.idParam);
    const version = parseVersionParam(versionOf(request.params));
    return ok(await options.service.updateDraft(options.resourceType, resourceId, version, body, actor(auth, requestIdOf(request))));
  });

  server.post(`${idPath}/versions/:version/clone`, {
    schema: { body: jsonSchema(cloneVersionRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:write');
    const parsedBody = cloneVersionRequestSchema.parse(request.body ?? {});
    const body = parsedBody.version !== undefined ? { version: parsedBody.version } : {};
    const resourceId = resourceIdOf(request.params, options.idParam);
    const version = parseVersionParam(versionOf(request.params));
    return ok(await options.service.cloneVersion(options.resourceType, resourceId, version, body, actor(auth, requestIdOf(request))));
  });

  server.post(`${idPath}/versions/:version/validate`, {
    schema: { body: jsonSchema(validateResourceRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:validate');
    validateResourceRequestSchema.parse(request.body ?? {});
    const resourceId = resourceIdOf(request.params, options.idParam);
    const version = parseVersionParam(versionOf(request.params));
    return ok({ validation: await options.service.validate(options.resourceType, resourceId, version, { tenantId: auth.tenant_id }) }, auth.request_id);
  });

  registerReleaseAction(server, options, 'publish', publishResourceRequestSchema, 'registry:publish', async (body, auth, request) =>
    options.service.publish(options.resourceType, resourceIdOf(request.params, options.idParam), parseVersionParam(versionOf(request.params)), body, actor(auth, requestIdOf(request))),
  );
  registerReleaseAction(server, options, 'gray', grayResourceRequestSchema, 'registry:gray', async (body, auth, request) =>
    options.service.gray(options.resourceType, resourceIdOf(request.params, options.idParam), parseVersionParam(versionOf(request.params)), body, actor(auth, requestIdOf(request))),
  );
  registerReleaseAction(server, options, 'deprecate', publishResourceRequestSchema, 'registry:deprecate', async (body, auth, request) =>
    options.service.deprecate(options.resourceType, resourceIdOf(request.params, options.idParam), parseVersionParam(versionOf(request.params)), body, actor(auth, requestIdOf(request))),
  );
  registerReleaseAction(server, options, 'disable', disableResourceRequestSchema, 'registry:disable', async (body, auth, request) =>
    options.service.disable(options.resourceType, resourceIdOf(request.params, options.idParam), parseVersionParam(versionOf(request.params)), body, actor(auth, requestIdOf(request))),
  );

  server.post(`${idPath}/rollback`, {
    schema: { body: jsonSchema(rollbackResourceRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:rollback');
    const body = rollbackResourceRequestSchema.parse(request.body);
    const resourceId = resourceIdOf(request.params, options.idParam);
    return ok(await options.service.rollback(options.resourceType, resourceId, body, actor(auth, requestIdOf(request))));
  });

  server.get(`${idPath}/releases`, async (request) => {
    const auth = requirePermission(request, 'release:read');
    const resourceId = resourceIdOf(request.params, options.idParam);
    return ok(await options.service.releaseHistory(options.resourceType, resourceId, { tenantId: auth.tenant_id }), auth.request_id);
  });
}

function registerReleaseAction<TBody>(
  server: FastifyInstance,
  options: RegistryRouteOptions,
  action: string,
  schema: ZodType<TBody>,
  permission: Parameters<typeof requirePermission>[1],
  callback: (body: TBody, auth: ReturnType<typeof authOf>, request: FastifyRequest) => Promise<unknown>,
): void {
  server.post(`/api/v1/${options.plural}/:${options.idParam}/versions/:version/${action}`, {
    schema: { body: jsonSchema(schema) },
  }, async (request) => {
    const auth = requirePermission(request, permission);
    const body = schema.parse(request.body);
    return ok(await callback(body, auth, request));
  });
}

function resourceIdOf(params: unknown, idParam: string): string {
  const value = (params as Record<string, unknown>)[idParam];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing route param: ${idParam}`);
  }
  return value;
}

function versionOf(params: unknown): string {
  const value = (params as Record<string, unknown>).version;
  if (typeof value !== 'string') {
    throw new Error('Missing route param: version');
  }
  return value;
}

function actor(auth: ReturnType<typeof authOf>, requestId?: string) {
  const traceId = requestId ?? auth.request_id;
  return {
    tenantId: auth.tenant_id,
    operatorId: auth.user_id,
    ...(traceId ? { requestId: traceId } : {}),
  };
}
