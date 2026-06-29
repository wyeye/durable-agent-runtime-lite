import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type {
  Conversation,
  ConversationListResponse,
  ConversationMessageListResponse,
  ConversationSendMessageResponse,
  AgentRunRecord,
  AgentStepRecord,
  CapabilityRelease,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationComparison,
  EvaluationDataset,
  EvaluationGateDecisionWithFreshness,
  EvaluationGateOverride,
  EvaluationGatePolicy,
  EvaluationRun,
  FlowSpec,
  HumanTaskDecisionResponse,
  HumanTaskGetResponse,
  HumanTaskListResponse,
  ModelDefinition,
  ModelGatewayConnectionTestResponse,
  ModelGatewayProfile,
  ModelPolicy,
  PaginatedResponse,
  RegistryResourceType,
  SpecStatus,
  RegistryValidationResult,
  StandardSuccessResponse,
  TaskRun,
  TenantAgentAdmission,
  TenantRuntimePolicy,
  TenantRuntimePolicySnapshot,
  ToolCallLog,
} from '@dar/contracts';
import { loadConfig } from '@dar/config';
import { ControlPlaneHttpError } from './utils/http.js';
import { createApp, shouldServeStaticFiles } from './app.js';
import type { EvaluationApi } from './services/evaluation-api-service.js';
import type { ModelCatalogActor, ModelCatalogApi } from './services/model-catalog-service.js';
import { RegistryValidationError } from '../modules/registry/registry-release-service.js';
import { RegistryApiService, type RegistryApi, type ActorOptions } from './services/registry-api-service.js';
import { EvaluationGateError, type RegistryResourceRecord } from '@dar/db';

const authHeaders = {
  'x-user-id': 'operator_1',
  'x-tenant-id': 'tenant_1',
  'x-roles': 'capability_operator',
  'x-request-id': 'req_test',
};

const auditorHeaders = {
  ...authHeaders,
  'x-roles': 'auditor',
};

const adminHeaders = {
  ...authHeaders,
  'x-roles': 'platform_admin',
};

const flowSpec: FlowSpec = {
  flow_id: 'flow_api',
  version: 1,
  status: 'draft',
  runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker' },
  steps: [{ id: 'start', type: 'activity', activity: 'noop' }],
};

const tenantPolicySpec: TenantRuntimePolicy = {
  tenant_id: 'tenant_1',
  version: 1,
  status: 'draft',
  allowed_tools: [],
  denied_tools: [],
  allowed_models: [],
  denied_models: [],
  allowed_handoffs: [],
  denied_handoffs: [],
  budget_cap: {},
  max_concurrent_agent_runs: 1,
  revision: 1,
};

describe('control-plane API', () => {
  it('returns build metadata without exposing service tokens', async () => {
    const { app, close } = await testApp({
      configEnv: {
        APP_VERSION: '9.9.9-test',
        BUILD_SHA: 'abc123',
        BUILD_TIME: '2026-01-01T00:00:00Z',
        CONTROL_PLANE_TOOL_GATEWAY_TOKEN: 'control-plane-token-for-tests',
      },
    });

    const response = await app.inject({ method: 'GET', url: '/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'control-plane',
      version: '9.9.9-test',
      build_sha: 'abc123',
      build_time: '2026-01-01T00:00:00Z',
      message_key: 'common.health.versionReady',
      message: '服务版本信息可用。',
      locale: 'zh-CN',
    });
    expect(response.headers['content-language']).toBe('zh-CN');
    expect(response.headers.vary).toContain('Accept-Language');
    expect(response.body).not.toContain('control-plane-token-for-tests');

    await close();
  });

  it('returns 401 when identity headers are missing for write APIs', async () => {
    const { app, close } = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/flows',
      payload: { spec: flowSpec },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    await close();
  });

  it('allows local dev password login when explicitly enabled', async () => {
    const identityDirectory = {
      async resolve(input: { user_id: string; tenant_id: string; request_id?: string }) {
        return {
          user_id: input.user_id,
          tenant_id: input.tenant_id,
          display_name: 'Dev Admin',
          platform_roles: ['platform_admin'],
          membership_roles: [],
          roles: ['platform_admin'],
          identity_source: 'directory' as const,
          request_id: input.request_id,
        };
      },
    };
    const { app, close } = await testApp({
      configEnv: {
        APP_ENV: 'local',
        IAM_DIRECTORY_MODE: 'db',
        CONTROL_PLANE_LOCAL_DEV_LOGIN_ENABLED: 'true',
        CONTROL_PLANE_LOCAL_DEV_PASSWORD: 'local-dev-pass',
      },
      identityDirectory,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        user_id: 'dev_admin',
        tenant_id: 'development',
        password: 'local-dev-pass',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<StandardSuccessResponse>().data).toMatchObject({
      user_id: 'dev_admin',
      tenant_id: 'development',
      roles: ['platform_admin'],
      identity_source: 'directory',
    });
    await close();
  });

  it('rejects local dev password login with wrong password', async () => {
    const identityDirectory = {
      async resolve(input: { user_id: string; tenant_id: string; request_id?: string }) {
        return {
          user_id: input.user_id,
          tenant_id: input.tenant_id,
          display_name: 'Dev Admin',
          platform_roles: ['platform_admin'],
          membership_roles: [],
          roles: ['platform_admin'],
          identity_source: 'directory' as const,
          request_id: input.request_id,
        };
      },
    };
    const { app, close } = await testApp({
      configEnv: {
        APP_ENV: 'local',
        IAM_DIRECTORY_MODE: 'db',
        CONTROL_PLANE_LOCAL_DEV_LOGIN_ENABLED: 'true',
        CONTROL_PLANE_LOCAL_DEV_PASSWORD: 'local-dev-pass',
      },
      identityDirectory,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: {
        user_id: 'dev_admin',
        tenant_id: 'development',
        password: 'wrong-pass',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHORIZED');
    await close();
  });

  it('returns 403 when auditor performs a write operation', async () => {
    const { app, close } = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/flows',
      headers: auditorHeaders,
      payload: { spec: flowSpec },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
    await close();
  });

  it('allows capability_operator to manage registry lifecycle APIs', async () => {
    const service = new FakeRegistryApi();
    const { app, close } = await testApp({ registryService: service });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/flows',
      headers: authHeaders,
      payload: { spec: flowSpec },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json<StandardSuccessResponse>().data).toMatchObject({ resource_id: 'flow_api', status: 'draft' });
    expect(service.lastActor?.operatorId).toBe('operator_1');

    const update = await app.inject({
      method: 'PUT',
      url: '/api/v1/flows/flow_api/versions/1',
      headers: authHeaders,
      payload: { spec: flowSpec, expected_revision: 1 },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().data.revision).toBe(2);

    const clone = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/flow_api/versions/1/clone',
      headers: authHeaders,
      payload: {},
    });
    expect(clone.statusCode).toBe(200);
    expect(clone.json().data.version).toBe(2);

    const validate = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/flow_api/versions/1/validate',
      headers: authHeaders,
      payload: {},
    });
    expect(validate.statusCode).toBe(200);
    expect(validate.json().data.validation.can_publish).toBe(true);

    const publish = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/flow_api/versions/1/publish',
      headers: authHeaders,
      payload: { release_note: 'publish v1' },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().data.action).toBe('publish');

    const gray = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/flow_api/versions/1/gray',
      headers: authHeaders,
      payload: { release_note: 'gray v1', tenant_allowlist: ['tenant_1'] },
    });
    expect(gray.statusCode).toBe(200);
    expect(gray.json().data.action).toBe('gray');

    const rollback = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/flow_api/rollback',
      headers: authHeaders,
      payload: { target_version: 1, release_note: 'rollback v1' },
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().data.action).toBe('rollback');

    await close();
  });

  it('keeps model gateway credentials write-only and restricts credential rotation to platform_admin', async () => {
    const modelCatalog = new FakeModelCatalogApi();
    const { app, close } = await testApp({ modelCatalogService: modelCatalog });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/model-gateways',
      headers: adminHeaders,
      payload: {
        profile_id: 'mock-gateway-a',
        display_name: 'Mock Gateway A',
        protocol: 'openai_chat_completions',
        base_url: 'http://mock-server:4100/gateway-a',
        auth_type: 'bearer',
        api_key: 'gateway-a-secret',
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json<StandardSuccessResponse<ModelGatewayProfile>>();
    expect(createdBody.data).toMatchObject({
      profile_id: 'mock-gateway-a',
      credential_configured: true,
      credential_fingerprint: 'a1b2c3d4e5f6',
      credential_revision: 1,
    });
    expect(created.body).not.toContain('gateway-a-secret');
    expect(created.body).not.toContain('api_key');
    expect(created.body).not.toContain('credential_ciphertext');
    expect(created.body).not.toContain('credential_iv');
    expect(created.body).not.toContain('credential_auth_tag');
    expect(modelCatalog.lastGatewayActor).toMatchObject({ tenantId: 'tenant_1', operatorId: 'operator_1' });

    const operatorRotate = await app.inject({
      method: 'POST',
      url: '/api/v1/model-gateways/mock-gateway-a/rotate-credential',
      headers: authHeaders,
      payload: { api_key: 'gateway-a-secret-v2', expected_credential_revision: 1 },
    });
    expect(operatorRotate.statusCode).toBe(403);
    expect(operatorRotate.json().error.code).toBe('FORBIDDEN');
    expect(modelCatalog.rotateCalls).toBe(0);

    const auditorList = await app.inject({
      method: 'GET',
      url: '/api/v1/model-gateways',
      headers: auditorHeaders,
    });
    expect(auditorList.statusCode).toBe(200);
    expect(auditorList.body).not.toContain('gateway-a-secret');
    expect(auditorList.body).not.toContain('credential_ciphertext');

    await close();
  });

  it('routes tenant runtime policy lifecycle through the registry resource API', async () => {
    const service = new FakeRegistryApi();
    const { app, close } = await testApp({ registryService: service });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant-runtime-policies',
      headers: authHeaders,
      payload: { spec: tenantPolicySpec },
    });
    expect(create.statusCode).toBe(200);
    expect(service.lastResourceType).toBe('tenant_runtime_policy');
    expect(service.lastSpec).toMatchObject({ tenant_id: 'tenant_1' });

    const publish = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant-runtime-policies/tenant_1/versions/1/publish',
      headers: adminHeaders,
      payload: { release_note: 'publish tenant policy' },
    });
    expect(publish.statusCode).toBe(200);
    expect(service.lastResourceType).toBe('tenant_runtime_policy');
    expect(publish.json().data.resource_type).toBe('tenant_runtime_policy');

    await close();
  });

  it('maps optimistic lock and validation failures to standard errors', async () => {
    const service = new FakeRegistryApi();
    service.conflict = true;
    const { app, close } = await testApp({ registryService: service });

    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/v1/flows/flow_api/versions/1',
      headers: authHeaders,
      payload: { spec: flowSpec, expected_revision: 99 },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('REGISTRY_OPTIMISTIC_LOCK_CONFLICT');

    service.conflict = false;
    service.validationCanPublish = false;
    const validation = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/flow_api/versions/1/publish',
      headers: authHeaders,
      payload: { release_note: 'publish invalid' },
    });
    expect(validation.statusCode).toBe(422);
    expect(validation.json().error.code).toBe('REGISTRY_VALIDATION_FAILED');
    expect(validation.json().error.details.validation.errors).toEqual([
      { code: 'INVALID', message: 'invalid', severity: 'error' },
    ]);

    await close();
  });

  it('maps evaluation publish gate failures to standard errors', async () => {
    const service = new FakeRegistryApi();
    service.publishGateError = true;
    const { app, close } = await testApp({ registryService: service });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/prompts/prompt_api/versions/1/publish',
      headers: authHeaders,
      payload: { release_note: 'publish without evaluation gate' },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      code: 'EVALUATION_CANDIDATE_BUNDLE_HASH_REQUIRED',
      message_key: 'errors.evaluationGateRequired',
      message: '发布前需要通过评测门禁。',
      locale: 'zh-CN',
    });
    await close();
  });

  it('publishes model policies through the model policy repository path', async () => {
    const policy = modelPolicySpec();
    const calls: string[] = [];
    const service = new RegistryApiService({} as never, { evaluationGateMode: 'advisory' });
    service.modelPolicies.getByIdAndVersion = async (modelPolicyId: string, version: number) => {
      calls.push(`get:${modelPolicyId}:${version}`);
      return policy;
    };
    service.modelPolicies.publish = async (modelPolicyId: string, version: number, options) => {
      calls.push(`publish:${modelPolicyId}:${version}`);
      expect(options.metadataJson).toMatchObject({
        evaluation_gate_warning: 'EVALUATION_CANDIDATE_BUNDLE_HASH_REQUIRED: Evaluation candidate bundle hash is required',
        request_id: 'req_model_policy_publish',
      });
      return { ...policy, status: 'published', published_by: options.operatorId };
    };
    service.modelPolicies.listReleaseHistory = async (modelPolicyId: string) => {
      calls.push(`history:${modelPolicyId}`);
      return [release('publish', 'model_policy')];
    };
    service.release.publish = async () => {
      throw new Error('generic registry release path should not publish model policies');
    };

    await expect(service.publish(
      'model_policy',
      policy.model_policy_id,
      policy.version,
      { release_note: 'publish model policy smoke', metadata_json: {} },
      { tenantId: 'tenant_1', operatorId: 'operator_1', requestId: 'req_model_policy_publish' },
    )).resolves.toMatchObject({
      action: 'publish',
      resource_type: 'model_policy',
    });
    expect(calls).toEqual([
      `get:${policy.model_policy_id}:1`,
      `publish:${policy.model_policy_id}:1`,
      `history:${policy.model_policy_id}`,
    ]);
  });

  it('exposes evaluation backend operations through service APIs', async () => {
    const service = new FakeEvaluationApi();
    const { app, close } = await testApp({ evaluationService: service });

    const datasets = await app.inject({
      method: 'GET',
      url: '/api/v1/evaluation-datasets?page_size=5',
      headers: auditorHeaders,
    });
    expect(datasets.statusCode).toBe(200);
    expect(datasets.json().data.items[0].dataset_id).toBe('eval_dataset');

    const createDataset = await app.inject({
      method: 'POST',
      url: '/api/v1/evaluation-datasets',
      headers: authHeaders,
      payload: evaluationDataset(),
    });
    expect(createDataset.statusCode).toBe(200);
    expect(service.lastActor).toMatchObject({ tenantId: 'tenant_1', operatorId: 'operator_1' });

    const createCase = await app.inject({
      method: 'POST',
      url: '/api/v1/evaluation-datasets/eval_dataset/versions/1/cases',
      headers: authHeaders,
      payload: evaluationCase(),
    });
    expect(createCase.statusCode).toBe(200);
    expect(service.lastCaseRoute).toEqual({ datasetId: 'eval_dataset', version: 1 });

    const createGatePolicy = await app.inject({
      method: 'POST',
      url: '/api/v1/evaluation-gate-policies',
      headers: authHeaders,
      payload: { policy: gatePolicyCreatePayload() },
    });
    expect(createGatePolicy.statusCode).toBe(200);
    expect(createGatePolicy.json().data.gate_policy_id).toBe('gate_policy_1');

    const decisions = await app.inject({
      method: 'GET',
      url: `/api/v1/evaluation-gate-decisions?resource_type=prompt&resource_id=prompt_api&current_resource_hash=${'a'.repeat(64)}&current_candidate_bundle_hash=${'b'.repeat(64)}`,
      headers: auditorHeaders,
    });
    expect(decisions.statusCode).toBe(200);
    expect(decisions.json().data.items[0].freshness.status).toBe('fresh');
    expect(service.lastGateDecisionQuery).toMatchObject({
      resource_type: 'prompt',
      resource_id: 'prompt_api',
      current_resource_hash: 'a'.repeat(64),
      current_candidate_bundle_hash: 'b'.repeat(64),
    });

    const comparison = await app.inject({
      method: 'POST',
      url: '/api/v1/evaluation-comparisons',
      headers: authHeaders,
      payload: { candidate_run_id: 'run_1', baseline_run_id: 'run_0' },
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json().data.candidate_run_id).toBe('run_1');

    const fetchedComparison = await app.inject({
      method: 'GET',
      url: '/api/v1/evaluation-comparisons/cmp_1',
      headers: auditorHeaders,
    });
    expect(fetchedComparison.statusCode).toBe(200);
    expect(fetchedComparison.json().data.comparison_id).toBe('cmp_1');

    await close();
  });

  it('allows only platform_admin to create evaluation gate overrides', async () => {
    const service = new FakeEvaluationApi();
    const { app, close } = await testApp({ evaluationService: service });
    const payload = {
      resource_hash: 'a'.repeat(64),
      reason: 'admin override after verified review',
      scope: 'single_resource_hash',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };

    const operatorAttempt = await app.inject({
      method: 'POST',
      url: '/api/v1/evaluation-gate-decisions/gate_decision_1/override',
      headers: authHeaders,
      payload,
    });
    expect(operatorAttempt.statusCode).toBe(403);
    expect(service.overrideCalls).toBe(0);

    const adminOverride = await app.inject({
      method: 'POST',
      url: '/api/v1/evaluation-gate-decisions/gate_decision_1/override',
      headers: adminHeaders,
      payload,
    });
    expect(adminOverride.statusCode).toBe(200);
    expect(adminOverride.json().data.gate_decision_id).toBe('gate_decision_1');
    expect(service.overrideCalls).toBe(1);

    await close();
  });

  it('exposes release list and OpenAPI', async () => {
    const { app, close } = await testApp();
    const releases = await app.inject({
      method: 'GET',
      url: '/api/v1/releases?resource_type=flow',
      headers: auditorHeaders,
    });
    expect(releases.statusCode).toBe(200);
    expect(releases.json().data.items[0].resource_type).toBe('flow');

    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().paths['/api/v1/flows']).toBeTruthy();
    await close();
  });

  it('serves production static assets without routing /api through SPA fallback', async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), 'dar-cp-static-'));
    await writeFile(join(staticRoot, 'index.html'), '<html><body>Control Plane</body></html>');
    const { app, close } = await testApp({ staticRoot });

    const spa = await app.inject({ method: 'GET', url: '/registry/flows' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('Control Plane');

    const apiMissing = await app.inject({ method: 'GET', url: '/api/not-found', headers: authHeaders });
    expect(apiMissing.statusCode).toBe(404);
    expect(apiMissing.headers['content-type']).toContain('application/json');
    await close();
  });

  it('can explicitly serve built SPA assets in non-production smoke environments', () => {
    const base = {
      DATABASE_URL: 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
      CONTROL_PLANE_AUTH_MODE: 'header',
      RUNTIME_API_URL: 'http://runtime-api.test',
      TOOL_GATEWAY_URL: 'http://tool-gateway.test',
    };
    expect(shouldServeStaticFiles(loadConfig({
      ...base,
      NODE_ENV: 'development',
      APP_ENV: 'development',
      CONTROL_PLANE_STATIC_ENABLED: 'true',
    }))).toBe(true);
    expect(shouldServeStaticFiles(loadConfig({
      ...base,
      NODE_ENV: 'development',
      APP_ENV: 'development',
      CONTROL_PLANE_STATIC_ENABLED: 'false',
    }))).toBe(false);
  });

  it('BFF forwards identity headers and maps downstream outage to 503', async () => {
    const runtime = new FakeRuntimeApiClient();
    const gateway = new FakeToolGatewayClient();
    const { app, close } = await testApp({ runtimeApiClient: runtime, toolGatewayClient: gateway });

    const humanTasks = await app.inject({
      method: 'GET',
      url: '/api/v1/operations/human-tasks?status=pending',
      headers: authHeaders,
    });
    expect(humanTasks.statusCode).toBe(200);
    expect(runtime.lastHeaders).toMatchObject({ userId: 'operator_1', tenantId: 'tenant_1', roles: ['capability_operator'] });

    gateway.fail = true;
    const audit = await app.inject({
      method: 'GET',
      url: '/api/v1/operations/audit-events',
      headers: authHeaders,
    });
    expect(audit.statusCode).toBe(503);
    expect(audit.json().error.code).toBe('DOWNSTREAM_UNAVAILABLE');
    await close();
  });

  it('allows active tenant members to use conversation BFF without control-plane permissions', async () => {
    const runtime = new FakeRuntimeApiClient();
    const { app, close } = await testApp({ runtimeApiClient: runtime });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/conversations?status=active&page_size=20',
      headers: {
        'x-user-id': 'member_1',
        'x-tenant-id': 'tenant_1',
        'x-roles': '',
        'x-request-id': 'req_chat_member',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.items[0]).toMatchObject({
      conversation_id: 'conversation_1',
      title: '测试会话',
    });
    expect(runtime.lastHeaders).toMatchObject({
      userId: 'member_1',
      tenantId: 'tenant_1',
      roles: [],
    });

    await close();
  });

  it('exposes read-only tenant policy snapshot and admission operations', async () => {
    const service = new FakeRegistryApi();
    const { app, close } = await testApp({ registryService: service });

    const snapshots = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant-runtime-policy-snapshots?derivation_type=root&page_size=10',
      headers: auditorHeaders,
    });
    expect(snapshots.statusCode).toBe(200);
    expect(snapshots.json().data.items[0]).toMatchObject({
      snapshot_ref: 'tenant-policy-snapshot:snapshot_1',
      tenant_id: 'tenant_1',
    });

    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant-runtime-policy-snapshots/tenant-policy-snapshot%3Asnapshot_1',
      headers: authHeaders,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().data.snapshot_id).toBe('snapshot_1');

    const admissions = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant-agent-admissions?status=active&page_size=10',
      headers: auditorHeaders,
    });
    expect(admissions.statusCode).toBe(200);
    expect(admissions.json().data.items[0]).toMatchObject({
      admission_id: 'admission_1',
      status: 'active',
    });

    const admission = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant-agent-admissions/admission_1',
      headers: authHeaders,
    });
    expect(admission.statusCode).toBe(200);
    expect(admission.json().data.task_run_id).toBe('task_1');

    const writeAttempt = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant-agent-admissions',
      headers: adminHeaders,
      payload: {},
    });
    expect(writeAttempt.statusCode).toBe(404);
    await close();
  });

  it('lets platform_admin approve human tasks through the BFF', async () => {
    const runtime = new FakeRuntimeApiClient();
    const { app, close } = await testApp({ runtimeApiClient: runtime });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/operations/human-tasks/human_1/approve',
      headers: adminHeaders,
      payload: { decision_reason: 'ok', payload: { approved: true } },
    });
    expect(response.statusCode).toBe(200);
    expect(runtime.lastDecisionBody).toMatchObject({ tenant_id: 'tenant_1', user_id: 'operator_1' });
    await close();
  });
});

async function testApp(options: {
  configEnv?: NodeJS.ProcessEnv;
  registryService?: RegistryApi;
  evaluationService?: EvaluationApi;
  modelCatalogService?: ModelCatalogApi;
  runtimeApiClient?: FakeRuntimeApiClient;
  toolGatewayClient?: FakeToolGatewayClient;
  staticRoot?: string;
  identityDirectory?: import('@dar/security').IdentityDirectory;
} = {}) {
  return createApp({
    config: loadConfig({
      NODE_ENV: 'test',
      APP_ENV: 'test',
      DATABASE_URL: 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
      CONTROL_PLANE_AUTH_MODE: 'header',
      RUNTIME_API_URL: 'http://runtime-api.test',
      TOOL_GATEWAY_URL: 'http://tool-gateway.test',
      ...(options.configEnv ?? {}),
    }),
    registryService: options.registryService ?? new FakeRegistryApi(),
    evaluationService: options.evaluationService ?? new FakeEvaluationApi(),
    modelCatalogService: options.modelCatalogService ?? new FakeModelCatalogApi(),
    runtimeApiClient: options.runtimeApiClient ?? new FakeRuntimeApiClient(),
    toolGatewayClient: options.toolGatewayClient ?? new FakeToolGatewayClient(),
    ...(options.identityDirectory ? { identityDirectory: options.identityDirectory } : {}),
    readyCheck: async () => undefined,
    ...(options.staticRoot ? { staticRoot: options.staticRoot } : {}),
  });
}

function validationResult(canPublish = true): RegistryValidationResult {
  return {
    valid: canPublish,
    can_publish: canPublish,
    errors: canPublish ? [] : [{ code: 'INVALID', message: 'invalid', severity: 'error' }],
    warnings: [],
    dependency_graph: { nodes: [], edges: [] },
  };
}

class FakeRegistryApi implements RegistryApi {
  lastActor?: ActorOptions;
  lastResourceType?: RegistryResourceType;
  lastSpec?: unknown;
  conflict = false;
  validationCanPublish = true;
  publishGateError = false;

  async list(): Promise<PaginatedResponse<never>> {
    return { items: [], page: 1, page_size: 20, total: 0 };
  }

  async listVersions() {
    return [record()];
  }

  async getVersion() {
    return record();
  }

  async createDraft(resourceType: RegistryResourceType, spec: unknown, actor: ActorOptions) {
    this.lastActor = actor;
    this.lastResourceType = resourceType;
    this.lastSpec = spec;
    return resourceType === 'tenant_runtime_policy' ? tenantPolicyRecord() : record();
  }

  async updateDraft(resourceType: RegistryResourceType) {
    this.lastResourceType = resourceType;
    if (this.conflict) {
      throw new ControlPlaneHttpError(409, 'REGISTRY_OPTIMISTIC_LOCK_CONFLICT', 'Registry resource revision conflict');
    }
    return resourceType === 'tenant_runtime_policy' ? tenantPolicyRecord({ revision: 2 }) : record({ revision: 2 });
  }

  async cloneVersion(resourceType: RegistryResourceType) {
    this.lastResourceType = resourceType;
    return resourceType === 'tenant_runtime_policy' ? tenantPolicyRecord({ version: 2 }) : record({ version: 2 });
  }

  async validate(resourceType: RegistryResourceType) {
    this.lastResourceType = resourceType;
    return validationResult(this.validationCanPublish);
  }

  async publish(resourceType: RegistryResourceType) {
    this.lastResourceType = resourceType;
    if (this.publishGateError) {
      throw new EvaluationGateError(
        'EVALUATION_CANDIDATE_BUNDLE_HASH_REQUIRED',
        'Evaluation candidate bundle hash is required',
        { resource_type: resourceType, resource_id: 'prompt_api', resource_version: 1 },
      );
    }
    if (!this.validationCanPublish) {
      throw new RegistryValidationError(resourceType, 'flow_api', 1, validationResult(false));
    }
    return release('publish', resourceType);
  }

  async gray(resourceType: RegistryResourceType) {
    this.lastResourceType = resourceType;
    return release('gray', resourceType);
  }

  async deprecate() {
    return release('deprecate');
  }

  async disable() {
    return release('disable');
  }

  async rollback() {
    return release('rollback');
  }

  async publishFlowWithRoute() {
    return { flow_release: release('publish'), route_release: release('publish', 'route') };
  }

  async releaseHistory() {
    return [release('publish')];
  }

  async listReleases() {
    return { items: [release('publish')], page: 1, page_size: 20 };
  }

  async getRelease() {
    return release('publish');
  }

  async registryCounts() {
    return {
      flows_published: 1,
      routes_published: 1,
      tools_published: 1,
      agents_published: 1,
      prompts_published: 1,
    };
  }

  async listTenantPolicySnapshots() {
    return { items: [snapshot()], page: 1, page_size: 20 };
  }

  async getTenantPolicySnapshot() {
    return snapshot();
  }

  async listTenantAgentAdmissions() {
    return { items: [admission()], page: 1, page_size: 20 };
  }

  async getTenantAgentAdmission() {
    return admission();
  }
}

class FakeModelCatalogApi implements ModelCatalogApi {
  lastGatewayActor?: ModelCatalogActor;
  rotateCalls = 0;

  async listGateways(): Promise<ModelGatewayProfile[]> {
    return [modelGatewayProfile()];
  }

  async getGateway(): Promise<ModelGatewayProfile> {
    return modelGatewayProfile();
  }

  async createGateway(_input: unknown, actor: ModelCatalogActor): Promise<ModelGatewayProfile> {
    this.lastGatewayActor = actor;
    return modelGatewayProfile({ status: 'draft' });
  }

  async updateGateway(_profileId: string, _input: unknown, actor: ModelCatalogActor): Promise<ModelGatewayProfile> {
    this.lastGatewayActor = actor;
    return modelGatewayProfile({ revision: 2 });
  }

  async publishGateway(): Promise<ModelGatewayProfile> {
    return modelGatewayProfile({ status: 'published', published_at: new Date('2025-01-01T00:00:00.000Z').toISOString() });
  }

  async disableGateway(): Promise<ModelGatewayProfile> {
    return modelGatewayProfile({ status: 'disabled', disabled_at: new Date('2025-01-01T00:00:00.000Z').toISOString() });
  }

  async rotateGatewayCredential(): Promise<ModelGatewayProfile> {
    this.rotateCalls += 1;
    return modelGatewayProfile({ credential_fingerprint: 'b1b2b3b4b5b6', credential_revision: 2 });
  }

  async testGateway(): Promise<ModelGatewayConnectionTestResponse> {
    return {
      reachable: true,
      latency_ms: 5,
      protocol: 'openai_chat_completions',
      upstream_model_id: 'upstream-a',
      response_model: 'upstream-a',
      supports_text: true,
    };
  }

  async listModels(): Promise<ModelDefinition[]> {
    return [modelDefinition()];
  }

  async listModelVersions(): Promise<ModelDefinition[]> {
    return [modelDefinition()];
  }

  async getModel(): Promise<ModelDefinition> {
    return modelDefinition();
  }

  async createModel(): Promise<ModelDefinition> {
    return modelDefinition({ status: 'draft' });
  }

  async updateModel(): Promise<ModelDefinition> {
    return modelDefinition({ revision: 2 });
  }

  async validateModel(): Promise<{ valid: boolean; can_publish: boolean; errors: unknown[]; warnings: unknown[] }> {
    return { valid: true, can_publish: true, errors: [], warnings: [] };
  }

  async publishModel(): Promise<ModelDefinition> {
    return modelDefinition({ status: 'published', published_at: new Date('2025-01-01T00:00:00.000Z').toISOString() });
  }

  async disableModel(): Promise<ModelDefinition> {
    return modelDefinition({ status: 'disabled', disabled_at: new Date('2025-01-01T00:00:00.000Z').toISOString() });
  }

  async cloneModel(): Promise<ModelDefinition> {
    return modelDefinition({ version: 2 });
  }
}

class FakeEvaluationApi implements EvaluationApi {
  lastActor?: ActorOptions;
  lastCaseRoute?: { datasetId: string; version: number };
  lastGateDecisionQuery?: unknown;
  overrideCalls = 0;

  async listDatasets(): Promise<PaginatedResponse<EvaluationDataset>> {
    return { items: [evaluationDataset()], page: 1, page_size: 20 };
  }

  async getDataset(): Promise<EvaluationDataset> {
    return evaluationDataset();
  }

  async listDatasetVersions(): Promise<EvaluationDataset[]> {
    return [evaluationDataset()];
  }

  async createDataset(_input: unknown, actor: ActorOptions): Promise<EvaluationDataset> {
    this.lastActor = actor;
    return evaluationDataset({ created_by: actor.operatorId });
  }

  async updateDataset(_datasetId: string, _version: number, _input: unknown, actor: ActorOptions): Promise<EvaluationDataset> {
    this.lastActor = actor;
    return evaluationDataset({ revision: 2, updated_by: actor.operatorId });
  }

  async cloneDataset(): Promise<EvaluationDataset> {
    return evaluationDataset({ version: 2 });
  }

  async validateDataset(): Promise<EvaluationDataset> {
    return evaluationDataset({ status: 'validated' });
  }

  async publishDataset(): Promise<EvaluationDataset> {
    return evaluationDataset({ status: 'published', published_by: 'operator_1' });
  }

  async rollbackDataset(): Promise<EvaluationDataset> {
    return evaluationDataset({ status: 'published' });
  }

  async listCases(): Promise<EvaluationCase[]> {
    return [evaluationCase()];
  }

  async getCase(): Promise<EvaluationCase> {
    return evaluationCase();
  }

  async createCase(datasetId: string, version: number, _input: unknown, actor: ActorOptions): Promise<EvaluationCase> {
    this.lastActor = actor;
    this.lastCaseRoute = { datasetId, version };
    return evaluationCase({ dataset_id: datasetId, dataset_version: version });
  }

  async updateCase(_caseId: string, _input: unknown, actor: ActorOptions): Promise<EvaluationCase> {
    this.lastActor = actor;
    return evaluationCase({ name: 'updated case' });
  }

  async deleteCase(): Promise<EvaluationCase> {
    return evaluationCase();
  }

  async listGatePolicies(): Promise<PaginatedResponse<EvaluationGatePolicy>> {
    return { items: [evaluationGatePolicy()], page: 1, page_size: 20 };
  }

  async getGatePolicy(): Promise<EvaluationGatePolicy> {
    return evaluationGatePolicy();
  }

  async listGatePolicyVersions(): Promise<EvaluationGatePolicy[]> {
    return [evaluationGatePolicy()];
  }

  async createGatePolicy(_input: unknown, actor: ActorOptions): Promise<EvaluationGatePolicy> {
    this.lastActor = actor;
    return evaluationGatePolicy({ created_by: actor.operatorId });
  }

  async updateGatePolicy(): Promise<EvaluationGatePolicy> {
    return evaluationGatePolicy({ revision: 2 });
  }

  async cloneGatePolicy(): Promise<EvaluationGatePolicy> {
    return evaluationGatePolicy({ version: 2 });
  }

  async validateGatePolicy(): Promise<EvaluationGatePolicy> {
    return evaluationGatePolicy({ status: 'validated' });
  }

  async publishGatePolicy(): Promise<EvaluationGatePolicy> {
    return evaluationGatePolicy({ status: 'published', published_by: 'operator_1' });
  }

  async listGateDecisions(input?: unknown): Promise<PaginatedResponse<EvaluationGateDecisionWithFreshness>> {
    this.lastGateDecisionQuery = input;
    return { items: [evaluationGateDecisionWithFreshness()], page: 1, page_size: 20 };
  }

  async getGateDecision(): Promise<EvaluationGateDecisionWithFreshness> {
    return evaluationGateDecisionWithFreshness();
  }

  async createOverride(decisionId: string, _input: unknown, actor: ActorOptions & { roles: string[] }): Promise<EvaluationGateOverride> {
    this.lastActor = actor;
    this.overrideCalls += 1;
    return evaluationGateOverride({ gate_decision_id: decisionId, operator_id: actor.operatorId });
  }

  async createComparison(): Promise<EvaluationComparison> {
    return evaluationComparison();
  }

  async getComparison(): Promise<EvaluationComparison> {
    return evaluationComparison();
  }
}

class FakeRuntimeApiClient {
  lastHeaders?: unknown;
  lastDecisionBody?: unknown;
  conversations: Conversation[] = [
    {
      conversation_id: 'conversation_1',
      tenant_id: 'tenant_1',
      owner_user_id: 'operator_1',
      title: '测试会话',
      status: 'active',
      revision: 1,
      next_sequence_no: 3,
      created_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      updated_at: new Date('2026-01-01T00:01:00.000Z').toISOString(),
      last_message_at: new Date('2026-01-01T00:01:00.000Z').toISOString(),
      archived_at: null,
    },
  ];

  async listConversations(_query: URLSearchParams, headers: unknown): Promise<ConversationListResponse> {
    this.lastHeaders = headers;
    return { items: this.conversations, page: 1, page_size: 50, total: this.conversations.length };
  }

  async createConversation(_body: unknown, headers: unknown): Promise<Conversation> {
    this.lastHeaders = headers;
    return this.conversations[0]!;
  }

  async getConversation(): Promise<Conversation> {
    return this.conversations[0]!;
  }

  async updateConversation(): Promise<Conversation> {
    return this.conversations[0]!;
  }

  async archiveConversation(): Promise<Conversation> {
    return { ...this.conversations[0]!, status: 'archived', archived_at: new Date('2026-01-01T00:02:00.000Z').toISOString() };
  }

  async unarchiveConversation(): Promise<Conversation> {
    return { ...this.conversations[0]!, status: 'active', archived_at: null };
  }

  async listConversationMessages(): Promise<ConversationMessageListResponse> {
    return { items: [], page: 1, page_size: 100, total: 0 };
  }

  async sendConversationMessage(): Promise<ConversationSendMessageResponse> {
    return {
      conversation: this.conversations[0]!,
      user_message: {
        message_id: 'msg_user_1',
        conversation_id: 'conversation_1',
        tenant_id: 'tenant_1',
        sequence_no: 1,
        role: 'user',
        status: 'completed',
        effective_status: 'completed',
        content_text: '你好',
        client_message_id: 'client_1',
        clarify_candidates: [],
        context_message_ids: [],
        created_at: new Date('2026-01-01T00:01:00.000Z').toISOString(),
        updated_at: new Date('2026-01-01T00:01:00.000Z').toISOString(),
        completed_at: new Date('2026-01-01T00:01:00.000Z').toISOString(),
      },
      assistant_message: {
        message_id: 'msg_assistant_1',
        conversation_id: 'conversation_1',
        tenant_id: 'tenant_1',
        sequence_no: 2,
        role: 'assistant',
        status: 'queued',
        effective_status: 'queued',
        content_text: null,
        reply_to_message_id: 'msg_user_1',
        clarify_candidates: [],
        context_message_ids: [],
        created_at: new Date('2026-01-01T00:01:01.000Z').toISOString(),
        updated_at: new Date('2026-01-01T00:01:01.000Z').toISOString(),
      },
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
    };
  }

  async listHumanTasks(_query: URLSearchParams, headers: unknown): Promise<HumanTaskListResponse> {
    this.lastHeaders = headers;
    return { human_tasks: [] };
  }

  async getHumanTask(): Promise<HumanTaskGetResponse> {
    return { human_task: { human_task_id: 'human_1', tenant_id: 'tenant_1', task_run_id: 'task_1', kind: 'approval', status: 'pending', candidate_groups: [], payload: {} } };
  }

  async approveHumanTask(_id: string, body: unknown): Promise<HumanTaskDecisionResponse> {
    this.lastDecisionBody = body;
    return { human_task: { human_task_id: 'human_1', tenant_id: 'tenant_1', task_run_id: 'task_1', kind: 'approval', status: 'approved', candidate_groups: [], payload: {} } };
  }

  async rejectHumanTask(_id: string, body: unknown): Promise<HumanTaskDecisionResponse> {
    this.lastDecisionBody = body;
    return { human_task: { human_task_id: 'human_1', tenant_id: 'tenant_1', task_run_id: 'task_1', kind: 'approval', status: 'rejected', candidate_groups: [], payload: {} } };
  }

  async listTaskRuns(): Promise<TaskRun[]> {
    return [];
  }

  async getTaskRun(): Promise<TaskRun> {
    return { task_run_id: 'task_1', tenant_id: 'tenant_1', user_id: 'user_1', route_type: 'matched', status: 'running' };
  }

  async listAgentRuns(): Promise<{ agent_runs: AgentRunRecord[] }> {
    return { agent_runs: [] };
  }

  async getAgentRun(): Promise<{ agent_run: AgentRunRecord }> {
    return {
      agent_run: {
        agent_run_id: 'agent_run_1',
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        task_run_id: 'task_1',
        workflow_id: 'workflow_1',
        execution_plan_ref: 'db://agent-execution-plan/agent_plan_1',
        execution_plan_hash: 'a'.repeat(64),
        agent_id: 'agent_1',
        agent_version: 1,
        prompt_id: 'prompt_1',
        prompt_version: 1,
        model: 'deterministic:final_only',
        fallback_count: 0,
        model_call_count: 0,
        execution_mode: 'mediated_tool_call',
        status: 'running',
        current_segment_index: 0,
        model_turn_count: 0,
        tool_call_count: 0,
        handoff_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  async listAgentSteps(): Promise<{ agent_steps: AgentStepRecord[] }> {
    return { agent_steps: [] };
  }

  async listEvaluationRuns(): Promise<EvaluationRun[]> {
    return [];
  }

  async createEvaluationRun(): Promise<{ evaluation_run: EvaluationRun; workflow_start: Record<string, unknown> }> {
    return {
      evaluation_run: evaluationRun(),
      workflow_start: { workflow_id: 'evaluation-run-tenant_1-run_1', task_run_id: 'run_1', started: true, mode: 'mock' },
    };
  }

  async getEvaluationRun(): Promise<EvaluationRun> {
    return evaluationRun();
  }

  async listEvaluationRunResults(): Promise<{ evaluation_run_id: string; results: EvaluationCaseResult[] }> {
    return { evaluation_run_id: 'run_1', results: [] };
  }

  async cancelEvaluationRun(): Promise<EvaluationRun> {
    return evaluationRun({ cancellation_requested_at: new Date('2025-01-01T00:00:00.000Z').toISOString() });
  }
}

class FakeToolGatewayClient {
  fail = false;

  async listAuditEvents() {
    if (this.fail) {
      throw new ControlPlaneHttpError(503, 'DOWNSTREAM_UNAVAILABLE', 'Downstream service unavailable');
    }
    return [];
  }

  async listToolCalls(): Promise<ToolCallLog[]> {
    return [];
  }

  async getToolCall(): Promise<ToolCallLog> {
    return {
      tool_call_id: 'tool_call_1',
      tenant_id: 'tenant_1',
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      risk_level: 'L1',
      policy_decision: 'allow',
      status: 'committed',
    };
  }
}

type TestRegistryRecord = RegistryResourceRecord<FlowSpec> & { status: SpecStatus };
type TestTenantPolicyRecord = RegistryResourceRecord<TenantRuntimePolicy> & { status: SpecStatus };

function record(overrides: Partial<TestRegistryRecord> = {}): TestRegistryRecord {
  return {
    tenant_id: 'tenant_1',
    resource_type: 'flow' as const,
    resource_id: 'flow_api',
    version: 1,
    status: 'draft' as const,
    spec: flowSpec,
    sha256: 'sha',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    revision: 1,
    gray_policy: { tenant_allowlist: [], user_allowlist: [] },
    ...overrides,
  };
}

function tenantPolicyRecord(overrides: Partial<TestTenantPolicyRecord> = {}): TestTenantPolicyRecord {
  return {
    tenant_id: 'tenant_1',
    resource_type: 'tenant_runtime_policy' as const,
    resource_id: 'tenant_1',
    version: 1,
    status: 'draft' as const,
    spec: tenantPolicySpec,
    sha256: 'sha_policy',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    revision: 1,
    gray_policy: { tenant_allowlist: [], user_allowlist: [] },
    ...overrides,
  };
}

function modelPolicySpec(overrides: Partial<ModelPolicy> = {}): ModelPolicy {
  return {
    model_policy_id: 'model_policy_api',
    version: 1,
    status: 'draft',
    protocol: 'openai_chat_completions',
    targets: [{
      target_id: 'primary',
      model_ref: {
        model_id: 'mock',
        version: 1,
        model_hash: 'a'.repeat(64),
      },
      priority: 0,
      enabled: true,
    }],
    retry_policy: {
      max_attempts_per_target: 1,
      retryable_status_codes: [429, 500],
      retry_on_timeout: true,
      retry_on_network_error: true,
      backoff_ms: 0,
      max_backoff_ms: 0,
    },
    fallback_policy: {
      enabled: false,
      ordered_target_ids: [],
      eligible_error_classes: ['rate_limit', 'timeout', 'network'],
      stop_on_auth_error: true,
      stop_on_validation_error: true,
      stop_on_policy_denial: true,
    },
    request_policy: {
      temperature: 0,
      top_p: 1,
      max_output_tokens: 1000,
      initial_tool_choice_mode: 'auto',
      after_tool_result_tool_choice_mode: 'auto',
      response_format: 'text',
      allow_parallel_tool_calls: false,
    },
    revision: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<TenantRuntimePolicySnapshot> = {}): TenantRuntimePolicySnapshot {
  return {
    snapshot_id: 'snapshot_1',
    snapshot_ref: 'tenant-policy-snapshot:snapshot_1',
    tenant_id: 'tenant_1',
    root_snapshot_ref: 'tenant-policy-snapshot:snapshot_1',
    derivation_type: 'root',
    lineage_depth: 0,
    source_policy_version: 1,
    source_policy_hash: 'a'.repeat(64),
    execution_plan_ref: 'db://agent-execution-plan/agent_plan_1',
    execution_plan_hash: 'b'.repeat(64),
    execution_plan_type: 'agent',
    resolved_allowed_tools: [],
    resolved_denied_tools: [],
    resolved_allowed_models: [],
    resolved_allowed_handoffs: [],
    resolved_budget: {
      max_segments: 1,
      max_model_turns: 1,
      max_tool_calls: 1,
      max_handoffs: 0,
      max_input_tokens: 100,
      max_output_tokens: 100,
      max_total_tokens: 200,
      max_duration_ms: 1000,
      max_context_bytes: 4096,
    },
    max_concurrent_agent_runs: 1,
    snapshot_hash: 'c'.repeat(64),
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function admission(overrides: Partial<TenantAgentAdmission> = {}): TenantAgentAdmission {
  return {
    admission_id: 'admission_1',
    tenant_id: 'tenant_1',
    task_run_id: 'task_1',
    agent_run_id: 'agent_run_1',
    workflow_id: 'workflow_1',
    workflow_run_id: 'run_1',
    policy_snapshot_ref: 'tenant-policy-snapshot:snapshot_1',
    status: 'active',
    acquired_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    activated_at: new Date('2025-01-01T00:00:01.000Z').toISOString(),
    updated_at: new Date('2025-01-01T00:00:01.000Z').toISOString(),
    revision: 2,
    ...overrides,
  };
}

function evaluationDataset(overrides: Partial<EvaluationDataset> = {}): EvaluationDataset {
  return {
    dataset_id: 'eval_dataset',
    version: 1,
    status: 'draft',
    name: 'Runtime evaluation dataset',
    tags: ['smoke'],
    default_weight: 1,
    revision: 1,
    dataset_hash: 'a'.repeat(64),
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function evaluationCase(overrides: Partial<EvaluationCase> = {}): EvaluationCase {
  return {
    case_id: 'case_1',
    dataset_id: 'eval_dataset',
    dataset_version: 1,
    name: 'Case 1',
    input: { text: 'hello' },
    context_refs: [],
    expected_tool_calls: [],
    forbidden_tools: [],
    final_assertions: [],
    policy_assertions: [],
    weight: 1,
    tags: ['smoke'],
    enabled: true,
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function gatePolicyCreatePayload(): Omit<EvaluationGatePolicy, 'revision' | 'gate_policy_hash' | 'created_at' | 'updated_at' | 'published_at'> {
  return {
    gate_policy_id: 'gate_policy_1',
    version: 1,
    status: 'draft',
    resource_types: ['prompt', 'agent', 'model_policy'],
    required_dataset_refs: [{ dataset_id: 'eval_dataset', version: 1, dataset_hash: 'a'.repeat(64) }],
    thresholds: {
      minimum_pass_rate: 1,
      minimum_weighted_score: 0.9,
      minimum_tool_selection_score: 0,
      maximum_forbidden_tool_calls: 0,
      maximum_policy_violations: 0,
      maximum_side_effect_without_approval: 0,
      maximum_secret_leaks: 0,
      maximum_hidden_reasoning_leaks: 0,
      maximum_cross_tenant_violations: 0,
      maximum_system_error_rate: 0,
    },
    regression_rules: {
      maximum_score_regression: 0,
      maximum_pass_rate_regression: 0,
      maximum_latency_regression_percent: 0,
      maximum_token_regression_percent: 0,
      maximum_cost_regression_percent: 0,
      block_newly_failed_cases: true,
      block_safety_regression: true,
      block_tool_regression: true,
      require_same_dataset: true,
    },
    required_case_tags: ['smoke'],
    allow_override: true,
  };
}

function evaluationGatePolicy(overrides: Partial<EvaluationGatePolicy> = {}): EvaluationGatePolicy {
  return {
    ...gatePolicyCreatePayload(),
    revision: 1,
    gate_policy_hash: 'b'.repeat(64),
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function modelGatewayProfile(overrides: Partial<ModelGatewayProfile> = {}): ModelGatewayProfile {
  return {
    profile_id: 'mock-gateway-a',
    display_name: 'Mock Gateway A',
    protocol: 'openai_chat_completions',
    base_url: 'http://mock-server:4100/gateway-a',
    auth_type: 'bearer',
    status: 'published',
    config_hash: 'a'.repeat(64),
    revision: 1,
    credential_configured: true,
    credential_fingerprint: 'a1b2c3d4e5f6',
    credential_revision: 1,
    created_by: 'operator_1',
    updated_by: 'operator_1',
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    published_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function modelDefinition(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    model_id: 'model-a',
    version: 1,
    display_name: 'Model A',
    gateway_profile_id: 'mock-gateway-a',
    gateway_profile_config_hash: 'a'.repeat(64),
    upstream_model_id: 'upstream-a',
    provider: 'mock-provider-a',
    capabilities: ['text'],
    context_window: 8192,
    max_output_tokens: 1024,
    input_cost_per_million: 0,
    output_cost_per_million: 0,
    currency: 'USD',
    tags: ['smoke'],
    status: 'published',
    revision: 1,
    model_hash: 'b'.repeat(64),
    created_by: 'operator_1',
    updated_by: 'operator_1',
    published_by: 'operator_1',
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    published_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function evaluationGateDecisionWithFreshness(): EvaluationGateDecisionWithFreshness {
  return {
    decision: {
      gate_decision_id: 'gate_decision_1',
      resource_type: 'prompt',
      resource_id: 'prompt_api',
      resource_version: 1,
      resource_hash: 'a'.repeat(64),
      candidate_bundle_hash: 'b'.repeat(64),
      gate_policy_id: 'gate_policy_1',
      gate_policy_version: 1,
      gate_policy_hash: 'c'.repeat(64),
      evaluation_run_ids: ['run_1'],
      decision: 'passed',
      reasons: [],
      decided_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    },
    freshness: {
      status: 'fresh',
      reasons: [],
      checked_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    },
  };
}

function evaluationGateOverride(overrides: Partial<EvaluationGateOverride> = {}): EvaluationGateOverride {
  return {
    override_id: 'override_1',
    gate_decision_id: 'gate_decision_1',
    resource_type: 'prompt',
    resource_id: 'prompt_api',
    resource_version: 1,
    resource_hash: 'a'.repeat(64),
    operator_id: 'operator_1',
    reason: 'admin override after verified review',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function evaluationComparison(overrides: Partial<EvaluationComparison> = {}): EvaluationComparison {
  return {
    comparison_id: 'cmp_1',
    candidate_run_id: 'run_1',
    baseline_run_id: 'run_0',
    comparable: true,
    dataset_id: 'eval_dataset',
    dataset_version: 1,
    dataset_hash: 'a'.repeat(64),
    overall_score_delta: 0,
    pass_rate_delta: 0,
    newly_failed_cases: [],
    newly_passed_cases: [],
    unchanged_failures: [],
    regression_severity: 'none',
    reasons: [],
    result: {},
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

function evaluationRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    evaluation_run_id: 'run_1',
    tenant_id: 'tenant_1',
    dataset_id: 'runtime-agent-core-v1',
    dataset_version: 1,
    dataset_hash: 'a'.repeat(64),
    subject_snapshot_ref: 'db://evaluation-subject-snapshot/snapshot_1',
    subject_snapshot_hash: 'b'.repeat(64),
    evaluation_execution_plan_ref: 'db://evaluation-execution-plan/plan_1',
    evaluation_execution_plan_hash: 'c'.repeat(64),
    trigger_type: 'manual',
    status: 'queued',
    total_cases: 0,
    completed_cases: 0,
    passed_cases: 0,
    failed_cases: 0,
    skipped_cases: 0,
    system_error_cases: 0,
    evidence_collection_status: 'not_started',
    ...overrides,
  };
}

function release(action: CapabilityRelease['action'], resourceType: CapabilityRelease['resource_type'] = 'flow'): CapabilityRelease {
  return {
    release_id: `release_${action}_${resourceType}`,
    tenant_id: 'tenant_1',
    resource_type: resourceType,
    resource_id: resourceType === 'route'
      ? 'route_api'
      : resourceType === 'model_policy'
        ? 'model_policy_api'
        : 'flow_api',
    resource_version: 1,
    action,
    target_status: action === 'gray' ? 'gray' : 'published',
    operator_id: 'operator_1',
    metadata_json: {},
    created_at: new Date().toISOString(),
  };
}
