import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  modelDefinitionCreateDraftRequestSchema,
  modelDefinitionQuerySchema,
  modelDefinitionPublishRequestSchema,
  modelDefinitionUpdateDraftRequestSchema,
  modelGatewayConnectionTestRequestSchema,
  modelGatewayCredentialRotateRequestSchema,
  modelGatewayProfileCreateRequestSchema,
  modelGatewayProfileQuerySchema,
  modelGatewayProfilePublishRequestSchema,
  modelGatewayProfileUpdateDraftRequestSchema,
} from '@dar/contracts';
import type { ModelCatalogApi } from '../services/model-catalog-service.js';
import { authOf, requirePermission } from '../plugins/auth.js';
import { jsonSchema, ok, requestIdOf } from '../utils/http.js';
import { parseVersionParam } from '../services/registry-api-service.js';

const cloneRequestSchema = z.object({ version: z.number().int().positive().optional() });

export async function modelCatalogRoutes(server: FastifyInstance, options: { service: ModelCatalogApi }): Promise<void> {
  server.get('/api/v1/model-gateways', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok({ items: await options.service.listGateways(modelGatewayProfileQuerySchema.parse(request.query)) }, auth.request_id);
  });

  server.post('/api/v1/model-gateways', {
    schema: { body: jsonSchema(modelGatewayProfileCreateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    return ok(await options.service.createGateway(request.body, actor(request)), auth.request_id);
  });

  server.get('/api/v1/model-gateways/:profileId', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    const { profileId } = request.params as { profileId: string };
    return ok(await options.service.getGateway(profileId), auth.request_id);
  });

  server.put('/api/v1/model-gateways/:profileId', {
    schema: { body: jsonSchema(modelGatewayProfileUpdateDraftRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const { profileId } = request.params as { profileId: string };
    return ok(await options.service.updateGateway(profileId, request.body, actor(request)), auth.request_id);
  });

  server.post('/api/v1/model-gateways/:profileId/publish', {
    schema: { body: jsonSchema(modelGatewayProfilePublishRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const body = modelGatewayProfilePublishRequestSchema.parse(request.body ?? {});
    const { profileId } = request.params as { profileId: string };
    return ok(await options.service.publishGateway(profileId, body.expected_revision, actor(request)), auth.request_id);
  });

  server.post('/api/v1/model-gateways/:profileId/disable', async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const { profileId } = request.params as { profileId: string };
    return ok(await options.service.disableGateway(profileId, actor(request)), auth.request_id);
  });

  server.post('/api/v1/model-gateways/:profileId/rotate-credential', {
    schema: { body: jsonSchema(modelGatewayCredentialRotateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const body = modelGatewayCredentialRotateRequestSchema.parse(request.body);
    const { profileId } = request.params as { profileId: string };
    return ok(await options.service.rotateGatewayCredential(profileId, body.api_key, body.expected_credential_revision, actor(request)), auth.request_id);
  });

  server.post('/api/v1/model-gateways/:profileId/test-connection', {
    schema: { body: jsonSchema(modelGatewayConnectionTestRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const body = modelGatewayConnectionTestRequestSchema.parse(request.body);
    const { profileId } = request.params as { profileId: string };
    return ok(await options.service.testGateway(profileId, body.probe_model_id, actor(request)), auth.request_id);
  });

  server.get('/api/v1/models', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok({ items: await options.service.listModels(modelDefinitionQuerySchema.parse(request.query)) }, auth.request_id);
  });

  server.post('/api/v1/models', {
    schema: { body: jsonSchema(modelDefinitionCreateDraftRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    return ok(await options.service.createModel(request.body, actor(request)), auth.request_id);
  });

  server.get('/api/v1/models/:modelId/versions', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    const { modelId } = request.params as { modelId: string };
    return ok({ items: await options.service.listModelVersions(modelId) }, auth.request_id);
  });

  server.get('/api/v1/models/:modelId/versions/:version', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    const { modelId, version } = request.params as { modelId: string; version: string };
    return ok(await options.service.getModel(modelId, parseVersionParam(version)), auth.request_id);
  });

  server.put('/api/v1/models/:modelId/versions/:version', {
    schema: { body: jsonSchema(modelDefinitionUpdateDraftRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const { modelId, version } = request.params as { modelId: string; version: string };
    return ok(await options.service.updateModel(modelId, parseVersionParam(version), request.body, actor(request)), auth.request_id);
  });

  server.post('/api/v1/models/:modelId/versions/:version/clone', {
    schema: { body: jsonSchema(cloneRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const body = cloneRequestSchema.parse(request.body ?? {});
    const { modelId, version } = request.params as { modelId: string; version: string };
    return ok(await options.service.cloneModel(modelId, parseVersionParam(version), body.version, actor(request)), auth.request_id);
  });

  server.post('/api/v1/models/:modelId/versions/:version/validate', async (request) => {
    const auth = requirePermission(request, 'registry:validate');
    const { modelId, version } = request.params as { modelId: string; version: string };
    return ok({ validation: await options.service.validateModel(modelId, parseVersionParam(version)) }, auth.request_id);
  });

  server.post('/api/v1/models/:modelId/versions/:version/publish', {
    schema: { body: jsonSchema(modelDefinitionPublishRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const body = modelDefinitionPublishRequestSchema.parse(request.body ?? {});
    const { modelId, version } = request.params as { modelId: string; version: string };
    return ok(await options.service.publishModel(modelId, parseVersionParam(version), body.expected_revision, actor(request)), auth.request_id);
  });

  server.post('/api/v1/models/:modelId/versions/:version/disable', async (request) => {
    const auth = requirePermission(request, 'registry:disable');
    const { modelId, version } = request.params as { modelId: string; version: string };
    return ok(await options.service.disableModel(modelId, parseVersionParam(version), actor(request)), auth.request_id);
  });
}

function actor(request: Parameters<typeof authOf>[0]): { tenantId: string; operatorId: string; requestId?: string } {
  const auth = authOf(request);
  const requestId = requestIdOf(request) ?? auth.request_id;
  return {
    tenantId: auth.tenant_id,
    operatorId: auth.user_id,
    ...(requestId ? { requestId } : {}),
  };
}
