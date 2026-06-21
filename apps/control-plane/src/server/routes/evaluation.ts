import type { FastifyInstance } from 'fastify';
import {
  evaluationCaseSchema,
  evaluationComparisonRequestSchema,
  evaluationDatasetQuerySchema,
  evaluationDatasetSchema,
  evaluationGatePolicyCreateRequestSchema,
  evaluationOverrideRequestSchema,
} from '@dar/contracts';
import type { EvaluationApi } from '../services/evaluation-api-service.js';
import { authOf, requirePermission } from '../plugins/auth.js';
import { ControlPlaneHttpError, jsonSchema, ok, requestIdOf } from '../utils/http.js';

export async function evaluationRoutes(server: FastifyInstance, options: { service: EvaluationApi }): Promise<void> {
  server.get('/api/v1/evaluation-datasets', {
    schema: { querystring: jsonSchema(evaluationDatasetQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.listDatasets(request.query), auth.request_id);
  });

  server.post('/api/v1/evaluation-datasets', {
    schema: { body: jsonSchema(evaluationDatasetSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.createDataset(request.body, actor(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/evaluation-datasets/:datasetId/versions', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.listDatasetVersions(datasetIdOf(request.params)), auth.request_id);
  });

  server.get('/api/v1/evaluation-datasets/:datasetId/versions/:version', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.getDataset(datasetIdOf(request.params), versionOf(request.params)), auth.request_id);
  });

  server.put('/api/v1/evaluation-datasets/:datasetId/versions/:version', async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.updateDataset(
      datasetIdOf(request.params),
      versionOf(request.params),
      request.body,
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.post('/api/v1/evaluation-datasets/:datasetId/versions/:version/clone', async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.cloneDataset(
      datasetIdOf(request.params),
      versionOf(request.params),
      request.body ?? {},
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.post('/api/v1/evaluation-datasets/:datasetId/versions/:version/validate', async (request) => {
    const auth = requirePermission(request, 'registry:validate');
    return ok(await options.service.validateDataset(
      datasetIdOf(request.params),
      versionOf(request.params),
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.post('/api/v1/evaluation-datasets/:datasetId/versions/:version/publish', async (request) => {
    const auth = requirePermission(request, 'registry:publish');
    return ok(await options.service.publishDataset(
      datasetIdOf(request.params),
      versionOf(request.params),
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.post('/api/v1/evaluation-datasets/:datasetId/rollback', async (request) => {
    const auth = requirePermission(request, 'registry:rollback');
    return ok(await options.service.rollbackDataset(
      datasetIdOf(request.params),
      request.body,
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.get('/api/v1/evaluation-datasets/:datasetId/versions/:version/cases', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.listCases(datasetIdOf(request.params), versionOf(request.params)), auth.request_id);
  });

  server.post('/api/v1/evaluation-datasets/:datasetId/versions/:version/cases', {
    schema: { body: jsonSchema(evaluationCaseSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.createCase(
      datasetIdOf(request.params),
      versionOf(request.params),
      { case: request.body },
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.get('/api/v1/evaluation-cases/:caseId', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.getCase(caseIdOf(request.params)), auth.request_id);
  });

  server.put('/api/v1/evaluation-cases/:caseId', async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.updateCase(
      caseIdOf(request.params),
      { case: request.body },
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.delete('/api/v1/evaluation-cases/:caseId', async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.deleteCase(caseIdOf(request.params), actor(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/evaluation-gate-policies', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.listGatePolicies(request.query), auth.request_id);
  });

  server.post('/api/v1/evaluation-gate-policies', {
    schema: { body: jsonSchema(evaluationGatePolicyCreateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.createGatePolicy(request.body, actor(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/evaluation-gate-policies/:gatePolicyId/versions', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.listGatePolicyVersions(gatePolicyIdOf(request.params)), auth.request_id);
  });

  server.get('/api/v1/evaluation-gate-policies/:gatePolicyId/versions/:version', async (request) => {
    const auth = requirePermission(request, 'registry:read');
    return ok(await options.service.getGatePolicy(gatePolicyIdOf(request.params), versionOf(request.params)), auth.request_id);
  });

  server.put('/api/v1/evaluation-gate-policies/:gatePolicyId/versions/:version', async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.updateGatePolicy(
      gatePolicyIdOf(request.params),
      versionOf(request.params),
      request.body,
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.post('/api/v1/evaluation-gate-policies/:gatePolicyId/versions/:version/clone', async (request) => {
    const auth = requirePermission(request, 'registry:write');
    return ok(await options.service.cloneGatePolicy(
      gatePolicyIdOf(request.params),
      versionOf(request.params),
      request.body ?? {},
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.post('/api/v1/evaluation-gate-policies/:gatePolicyId/versions/:version/validate', async (request) => {
    const auth = requirePermission(request, 'registry:validate');
    return ok(await options.service.validateGatePolicy(
      gatePolicyIdOf(request.params),
      versionOf(request.params),
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.post('/api/v1/evaluation-gate-policies/:gatePolicyId/versions/:version/publish', async (request) => {
    const auth = requirePermission(request, 'registry:publish');
    return ok(await options.service.publishGatePolicy(
      gatePolicyIdOf(request.params),
      versionOf(request.params),
      actor(auth, requestIdOf(request)),
    ), auth.request_id);
  });

  server.get('/api/v1/evaluation-gate-decisions', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    return ok(await options.service.listGateDecisions(request.query), auth.request_id);
  });

  server.get('/api/v1/evaluation-gate-decisions/:decisionId', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    return ok(await options.service.getGateDecision(decisionIdOf(request.params)), auth.request_id);
  });

  server.post('/api/v1/evaluation-gate-decisions/:decisionId/override', {
    schema: { body: jsonSchema(evaluationOverrideRequestSchema.omit({ gate_decision_id: true })) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:publish');
    if (!auth.roles.includes('platform_admin')) {
      throw new ControlPlaneHttpError(403, 'FORBIDDEN', 'Permission denied', {
        permission: 'evaluation_gate:override',
        roles: auth.roles,
      });
    }
    return ok(await options.service.createOverride(
      decisionIdOf(request.params),
      request.body,
      { ...actor(auth, requestIdOf(request)), roles: auth.roles },
    ), auth.request_id);
  });

  server.post('/api/v1/evaluation-comparisons', {
    schema: { body: jsonSchema(evaluationComparisonRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'registry:publish');
    return ok(await options.service.createComparison(request.body, actor(auth, requestIdOf(request))), auth.request_id);
  });

  server.get('/api/v1/evaluation-comparisons/:comparisonId', async (request) => {
    const auth = requirePermission(request, 'operations:read');
    return ok(await options.service.getComparison(comparisonIdOf(request.params)), auth.request_id);
  });
}

function actor(auth: ReturnType<typeof authOf>, requestId?: string) {
  const traceId = requestId ?? auth.request_id;
  return {
    tenantId: auth.tenant_id,
    operatorId: auth.user_id,
    ...(traceId ? { requestId: traceId } : {}),
  };
}

function datasetIdOf(params: unknown): string {
  return stringParam(params, 'datasetId');
}

function caseIdOf(params: unknown): string {
  return stringParam(params, 'caseId');
}

function gatePolicyIdOf(params: unknown): string {
  return stringParam(params, 'gatePolicyId');
}

function decisionIdOf(params: unknown): string {
  return stringParam(params, 'decisionId');
}

function comparisonIdOf(params: unknown): string {
  return stringParam(params, 'comparisonId');
}

function versionOf(params: unknown): number {
  const value = stringParam(params, 'version');
  const version = Number(value);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error('Invalid version route param');
  }
  return version;
}

function stringParam(params: unknown, key: string): string {
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing route param: ${key}`);
  }
  return value;
}
