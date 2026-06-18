import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type {
  CapabilityRelease,
  FlowSpec,
  HumanTaskDecisionResponse,
  HumanTaskGetResponse,
  HumanTaskListResponse,
  PaginatedResponse,
  RegistryResourceType,
  SpecStatus,
  RegistryValidationResult,
  StandardSuccessResponse,
  TaskRun,
  ToolCallLog,
} from '@dar/contracts';
import { loadConfig } from '@dar/config';
import { ControlPlaneHttpError } from './utils/http.js';
import { createApp } from './app.js';
import type { RegistryApi, ActorOptions } from './services/registry-api-service.js';
import type { RegistryResourceRecord } from '@dar/db';

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

describe('control-plane API', () => {
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
  registryService?: RegistryApi;
  runtimeApiClient?: FakeRuntimeApiClient;
  toolGatewayClient?: FakeToolGatewayClient;
  staticRoot?: string;
} = {}) {
  return createApp({
    config: loadConfig({
      NODE_ENV: 'test',
      APP_ENV: 'test',
      DATABASE_URL: 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
      CONTROL_PLANE_AUTH_MODE: 'header',
      RUNTIME_API_URL: 'http://runtime-api.test',
      TOOL_GATEWAY_URL: 'http://tool-gateway.test',
    }),
    registryService: options.registryService ?? new FakeRegistryApi(),
    runtimeApiClient: options.runtimeApiClient ?? new FakeRuntimeApiClient(),
    toolGatewayClient: options.toolGatewayClient ?? new FakeToolGatewayClient(),
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
  conflict = false;
  validationCanPublish = true;

  async list(): Promise<PaginatedResponse<never>> {
    return { items: [], page: 1, page_size: 20, total: 0 };
  }

  async listVersions() {
    return [record()];
  }

  async getVersion() {
    return record();
  }

  async createDraft(_resourceType: RegistryResourceType, _spec: unknown, actor: ActorOptions) {
    this.lastActor = actor;
    return record();
  }

  async updateDraft() {
    if (this.conflict) {
      throw new ControlPlaneHttpError(409, 'REGISTRY_OPTIMISTIC_LOCK_CONFLICT', 'Registry resource revision conflict');
    }
    return record({ revision: 2 });
  }

  async cloneVersion() {
    return record({ version: 2 });
  }

  async validate() {
    return validationResult(this.validationCanPublish);
  }

  async publish() {
    if (!this.validationCanPublish) {
      throw new Error('Registry validation failed');
    }
    return release('publish');
  }

  async gray() {
    return release('gray');
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
}

class FakeRuntimeApiClient {
  lastHeaders?: unknown;
  lastDecisionBody?: unknown;

  async listHumanTasks(_query: URLSearchParams, headers: unknown): Promise<HumanTaskListResponse> {
    this.lastHeaders = headers;
    return { human_tasks: [] };
  }

  async getHumanTask(): Promise<HumanTaskGetResponse> {
    return { human_task: { human_task_id: 'human_1', tenant_id: 'tenant_1', task_run_id: 'task_1', status: 'pending', candidate_groups: [], payload: {} } };
  }

  async approveHumanTask(_id: string, body: unknown): Promise<HumanTaskDecisionResponse> {
    this.lastDecisionBody = body;
    return { human_task: { human_task_id: 'human_1', tenant_id: 'tenant_1', task_run_id: 'task_1', status: 'approved', candidate_groups: [], payload: {} } };
  }

  async rejectHumanTask(_id: string, body: unknown): Promise<HumanTaskDecisionResponse> {
    this.lastDecisionBody = body;
    return { human_task: { human_task_id: 'human_1', tenant_id: 'tenant_1', task_run_id: 'task_1', status: 'rejected', candidate_groups: [], payload: {} } };
  }

  async listTaskRuns(): Promise<TaskRun[]> {
    return [];
  }

  async getTaskRun(): Promise<TaskRun> {
    return { task_run_id: 'task_1', tenant_id: 'tenant_1', user_id: 'user_1', route_type: 'matched', status: 'running' };
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

function release(action: CapabilityRelease['action'], resourceType: CapabilityRelease['resource_type'] = 'flow'): CapabilityRelease {
  return {
    release_id: `release_${action}_${resourceType}`,
    tenant_id: 'tenant_1',
    resource_type: resourceType,
    resource_id: resourceType === 'route' ? 'route_api' : 'flow_api',
    resource_version: 1,
    action,
    target_status: action === 'gray' ? 'gray' : 'published',
    operator_id: 'operator_1',
    metadata_json: {},
    created_at: new Date().toISOString(),
  };
}
