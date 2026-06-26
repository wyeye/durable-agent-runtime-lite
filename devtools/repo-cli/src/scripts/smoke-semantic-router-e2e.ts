import assert from 'node:assert/strict';
import type {
  CapabilityRelease,
  FlowSpec,
  RouteSpec,
  RouterPreviewResponse,
  RunTaskResponse,
  StandardResponse,
} from '@dar/contracts';
import { loadConfig } from '@dar/config';
import {
  closeDb,
  createDb,
  FlowDefinitionRepository,
  RouteConfigRepository,
  RouteEmbeddingRepository,
  TaskRunRepository,
} from '@dar/db';
import { buildServer as buildControlPlaneServer } from '../../../../apps/control-plane/src/index.js';
import { buildServer as buildRuntimeApiServer } from '../../../../apps/runtime-api/src/index.js';
import { RuntimeApiReadinessService } from '../../../../apps/runtime-api/src/modules/readiness/runtime-api-readiness-service.js';
import { createRuntimeApiTaskService } from '../../../../apps/runtime-api/src/modules/task/task-service.js';
import { buildServer as buildMockGatewayServer } from '../../../../devtools/mock-server/src/index.js';
import { ensureModelCatalogEntry } from './model-catalog-seed.js';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const tenantId = process.env.SMOKE_TENANT_ID ?? `semantic_router_${Date.now()}`;
const userId = process.env.SMOKE_USER_ID ?? 'semantic_router_smoke_user';
const runId = Date.now();
const requestPrefix = `semantic_router_smoke_${runId}`;
const embeddingProfileId = `${requestPrefix}_embedding_profile`;
const embeddingModelId = `${requestPrefix}_embedding_model`;
const masterKey = process.env.MODEL_CREDENTIAL_MASTER_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const operatorHeaders = authHeaders('capability_operator', `${requestPrefix}_operator`);
const adminHeaders = authHeaders('platform_admin', `${requestPrefix}_admin`);

interface RegistryRecord<TSpec> {
  resource_id: string;
  version: number;
  status: string;
  revision: number;
  sha256: string;
  spec: TSpec;
}

type ControlPlaneServer = Awaited<ReturnType<typeof buildControlPlaneServer>>;
type RuntimeApiServer = ReturnType<typeof buildRuntimeApiServer>;
type InjectServer = ControlPlaneServer | RuntimeApiServer;
type InjectResponse = { statusCode: number; json(): unknown };
type InjectFn = (input: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}) => Promise<InjectResponse>;

async function main(): Promise<void> {
  const db = createDb({ databaseUrl });
  const mockGateway = buildMockGatewayServer();
  let runtimeApi: ReturnType<typeof createRuntimeApiTaskService> | undefined;
  let runtimeServer: ReturnType<typeof buildRuntimeApiServer> | undefined;
  let controlPlane: Awaited<ReturnType<typeof buildControlPlaneServer>> | undefined;

  try {
    await mockGateway.listen({ host: '127.0.0.1', port: 0 });
    const mockGatewayBaseUrl = `http://127.0.0.1:${(mockGateway.server.address() as { port: number }).port}/gateway-a`;

    process.env.MODEL_CREDENTIAL_MASTER_KEY = masterKey;
    const embeddingCatalog = await ensureModelCatalogEntry(db, {
      profileId: embeddingProfileId,
      displayName: `Semantic smoke embeddings ${requestPrefix}`,
      baseUrl: mockGatewayBaseUrl,
      authType: 'bearer',
      apiKey: 'gateway-a-secret',
      modelId: embeddingModelId,
      upstreamModelId: `${requestPrefix}_embedding_upstream`,
      provider: 'local-mock',
      capabilities: ['embeddings'],
      contextWindow: 8192,
      maxOutputTokens: 1,
      embeddingDimensions: 1536,
      tags: ['semantic-smoke'],
      operatorId: 'semantic-smoke',
      masterKey,
    });

    const semanticConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'development',
      APP_ENV: 'local',
      DATABASE_URL: databaseUrl,
      MODEL_CREDENTIAL_MASTER_KEY: masterKey,
      MODEL_GATEWAY_ALLOW_INSECURE_HTTP: 'true',
      RUNTIME_API_WORKFLOW_STARTER: 'mock',
      RUNTIME_API_AUTH_MODE: 'disabled',
      TENANT_RUNTIME_POLICY_MODE: 'optional',
      CONTROL_PLANE_AUTH_MODE: 'header',
      EVALUATION_GATE_MODE: 'disabled',
      ROUTER_EMBEDDING_MODEL_ID: embeddingModelId,
      ROUTER_EMBEDDING_MODEL_VERSION: '1',
      ROUTER_VECTOR_TOP_K: '5',
      ROUTER_SEMANTIC_MATCH_THRESHOLD: '0.80',
      ROUTER_SEMANTIC_CLARIFY_THRESHOLD: '0.65',
      ROUTER_SEMANTIC_MIN_MARGIN: '0.05',
      ROUTER_EMBEDDING_TIMEOUT_MS: '10000',
    });

    runtimeApi = createRuntimeApiTaskService(semanticConfig);
    assert.ok(runtimeApi.db, 'semantic smoke requires DB-backed runtime-api');
    assert.ok(runtimeApi.routeSource, 'semantic smoke requires DB route source');
    runtimeServer = buildRuntimeApiServer(
      runtimeApi.taskService,
      new RuntimeApiReadinessService({
        config: semanticConfig,
        db: runtimeApi.db,
        routeSource: runtimeApi.routeSource,
        temporalProbe: async () => undefined,
      }),
      runtimeApi.humanTaskService,
      runtimeApi.agentRunService,
      runtimeApi.evaluationRunService,
      semanticConfig,
    );
    controlPlane = await buildControlPlaneServer({
      config: semanticConfig,
      db,
      readyCheck: async () => undefined,
    });

    const flowId = `${requestPrefix}_flow`;
    const routeA = `${requestPrefix}_expense`;
    const routeB = `${requestPrefix}_ticket`;
    const routeRestricted = `${requestPrefix}_restricted`;
    const routeNegative = `${requestPrefix}_negative`;

    await createFlow(controlPlane, flow(flowId, 1));
    await createRoute(controlPlane, expenseRoute(routeA, flowId, 1));
    await createRoute(controlPlane, ticketRoute(routeB, flowId, 1));
    await createRoute(controlPlane, restrictedRoute(routeRestricted, flowId, 1));
    await createRoute(controlPlane, negativeRoute(routeNegative, flowId, 1));

    await publishRoute(controlPlane, routeA, 1);
    await publishRoute(controlPlane, routeB, 1);
    await publishRoute(controlPlane, routeRestricted, 1);
    await publishRoute(controlPlane, routeNegative, 1);

    const coverage = await new RouteEmbeddingRepository(db).listCoverage({
      tenantId,
      routeIds: [routeA, routeB, routeRestricted, routeNegative],
      embeddingModelId,
      embeddingModelVersion: 1,
    });
    assert.equal(coverage.length, 4, `expected coverage for four semantic routes, got ${JSON.stringify(coverage)}`);
    assert.ok(coverage.every((item) => item.embedding_model_hash.match(/^[a-f0-9]{64}$/u)));

    const semanticMatch = await preview(runtimeServer, '公司费用怎么申请', { channel: 'web', roles: ['employee'] });
    assert.equal(semanticMatch.decision_stage, 'semantic');
    assert.equal(semanticMatch.route_decision.decision, 'matched');
    assert.equal(semanticMatch.route_decision.flow_id, flowId);
    assert.equal(semanticMatch.route_decision.flow_version, 1);
    assert.ok(semanticMatch.route_decision.confidence >= 0.8);
    assert.equal(semanticMatch.candidates[0]?.route_id, routeA);
    assert.equal(semanticMatch.semantic?.model_ref?.model_id, embeddingModelId);
    assert.equal(semanticMatch.semantic?.model_ref?.version, 1);
    assert.equal(semanticMatch.semantic?.model_ref?.model_hash, embeddingCatalog.model_ref.model_hash);

    const rulePrecedence = await preview(runtimeServer, '我要创建工单', { channel: 'web', roles: ['employee'] });
    assert.equal(rulePrecedence.decision_stage, 'rule');
    assert.ok(rulePrecedence.route_decision.decision === 'matched');
    assert.equal(rulePrecedence.route_decision.flow_id, flowId);

    const filtered = await preview(runtimeServer, '差旅费用怎么处理', { channel: 'web', roles: ['employee'] });
    assert.notEqual(filtered.candidates[0]?.route_id, routeRestricted);
    assert.ok(filtered.candidates.every((candidate) => candidate.route_id !== routeRestricted));

    const negative = await preview(runtimeServer, '不要报销，我只是咨询发票', { channel: 'web', roles: ['employee'] });
    assert.ok(negative.candidates.every((candidate) => candidate.route_id !== routeNegative));

    const clarify = await preview(runtimeServer, '费用维修请求如何处理', { channel: 'web', roles: ['employee'] });
    assert.equal(clarify.route_decision.decision, 'need_clarify');
    const clarifyTask = await createTask(runtimeServer, '费用维修请求如何处理');
    assert.equal(clarifyTask.status, 'failed');
    assert.equal(clarifyTask.route_decision.decision, 'need_clarify');
    assert.equal(await new TaskRunRepository(db).get(clarifyTask.task_run_id), undefined);

    const reject = await preview(runtimeServer, '今天天气不错', { channel: 'web', roles: ['employee'] });
    assert.equal(reject.route_decision.decision, 'reject');
    const rejectTask = await createTask(runtimeServer, '今天天气不错');
    assert.equal(rejectTask.status, 'failed');
    assert.equal(rejectTask.route_decision.decision, 'reject');
    assert.equal(await new TaskRunRepository(db).get(rejectTask.task_run_id), undefined);

    await new FlowDefinitionRepository(db).cloneVersion(flowId, 1, { tenantId, operatorId: 'semantic-smoke' });
    await new FlowDefinitionRepository(db).markValidated(flowId, 2, { tenantId, operatorId: 'semantic-smoke' });
    await new FlowDefinitionRepository(db).publish(flowId, 2, { tenantId, operatorId: 'semantic-smoke' });
    const clonedRoute = await new RouteConfigRepository(db).cloneVersion(routeA, 1, {
      tenantId,
      operatorId: 'semantic-smoke',
    });
    await new RouteConfigRepository(db).updateDraft(routeA, 2, {
      tenantId,
      operatorId: 'semantic-smoke',
      expectedRevision: clonedRoute.revision,
      spec: expenseRoute(routeA, flowId, 2, ['发票费用政策']),
    });
    await publishRoute(controlPlane, routeA, 2);
    const afterUpdate = await preview(runtimeServer, '发票费用怎么处理', { channel: 'web', roles: ['employee'] });
    assert.equal(afterUpdate.decision_stage, 'semantic');
    assert.ok(afterUpdate.route_decision.decision === 'matched');
    assert.equal(afterUpdate.route_decision.flow_version, 2);

    await postJson<CapabilityRelease>(
      controlPlane,
      `/api/v1/routes/${encodeURIComponent(routeA)}/rollback`,
      { target_version: 1, release_note: 'semantic smoke rollback route' },
      adminHeaders,
    );
    const afterRollback = await preview(runtimeServer, '公司费用怎么申请', { channel: 'web', roles: ['employee'] });
    assert.ok(afterRollback.route_decision.decision === 'matched');
    assert.equal(afterRollback.route_decision.flow_version, 1);

    console.log(JSON.stringify({
      ok: true,
      semantic_match: true,
      rule_precedence: true,
      clarify: true,
      reject: true,
      tenant_id: tenantId,
      embedding_model: `${embeddingModelId}@1`,
      embedding_rows: coverage.reduce((sum, item) => sum + item.source_count, 0),
    }, null, 2));
  } finally {
    await runtimeServer?.close();
    await runtimeApi?.close();
    await controlPlane?.close();
    await mockGateway.close();
    await closeDb(db);
  }
}

async function createFlow(controlPlane: ControlPlaneServer, spec: FlowSpec): Promise<void> {
  await postJson<RegistryRecord<FlowSpec>>(controlPlane, '/api/v1/flows', { spec }, operatorHeaders);
  await postJson(controlPlane, `/api/v1/flows/${encodeURIComponent(spec.flow_id)}/versions/${spec.version}/publish`, {
    release_note: `publish ${spec.flow_id}@${spec.version}`,
  }, adminHeaders);
}

async function createRoute(controlPlane: ControlPlaneServer, spec: RouteSpec): Promise<void> {
  await postJson<RegistryRecord<RouteSpec>>(controlPlane, '/api/v1/routes', { spec }, operatorHeaders);
}

async function publishRoute(
  controlPlane: ControlPlaneServer,
  routeId: string,
  version: number,
): Promise<void> {
  await postJson<CapabilityRelease>(
    controlPlane,
    `/api/v1/routes/${encodeURIComponent(routeId)}/versions/${version}/publish`,
    { release_note: `publish ${routeId}@${version}` },
    adminHeaders,
  );
}

async function preview(
  runtimeServer: RuntimeApiServer,
  text: string,
  options: { channel: string; roles: string[] },
): Promise<RouterPreviewResponse> {
  return postJson<RouterPreviewResponse>(
    runtimeServer,
    '/v1/router/preview',
    {
      tenant_id: tenantId,
      user_id: userId,
      channel: options.channel,
      roles: options.roles,
      request_id: `${requestPrefix}_preview_${Math.abs(hashText(text))}`,
      input: { text },
    },
  );
}

async function createTask(runtimeServer: RuntimeApiServer, text: string): Promise<RunTaskResponse> {
  return postJson<RunTaskResponse>(
    runtimeServer,
    '/v1/tasks',
    {
      tenant_id: tenantId,
      user_id: userId,
      request_id: `${requestPrefix}_task_${Math.abs(hashText(text))}`,
      input: { text },
    },
  );
}

async function postJson<T>(
  server: InjectServer,
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  const inject = server.inject.bind(server) as unknown as InjectFn;
  const response = await inject({
    method,
    url,
    headers: {
      'accept-language': 'zh-CN',
      'content-type': 'application/json',
      ...headers,
    },
    payload,
  });
  const body = response.json() as StandardResponse<T>;
  if (response.statusCode < 200 || response.statusCode >= 300 || body.success !== true) {
    throw new Error(`${method} ${url} failed: ${response.statusCode} ${JSON.stringify(body)}`);
  }
  return body.data;
}

function flow(flowId: string, version: number): FlowSpec {
  return {
    flow_id: flowId,
    version,
    status: 'draft',
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    steps: [{ id: 'activity', type: 'activity', activity: 'noop' }],
  };
}

function expenseRoute(routeId: string, flowId: string, version: number, examples = ['查询报销政策', '查看差旅费用规则']): RouteSpec {
  return route(routeId, flowId, version, {
    priority: 80,
    keywords: ['报销'],
    examples,
    negative_examples: [],
  });
}

function ticketRoute(routeId: string, flowId: string, version: number): RouteSpec {
  return route(routeId, flowId, version, {
    priority: 70,
    keywords: ['工单'],
    examples: ['提交故障单', '我要报修'],
    negative_examples: [],
  });
}

function restrictedRoute(routeId: string, flowId: string, version: number): RouteSpec {
  return route(routeId, flowId, version, {
    priority: 100,
    keywords: [],
    examples: ['差旅费用规则'],
    negative_examples: [],
    supported_channels: ['admin-console'],
    role_constraints: ['finance_admin'],
  });
}

function negativeRoute(routeId: string, flowId: string, version: number): RouteSpec {
  return route(routeId, flowId, version, {
    priority: 20,
    keywords: [],
    examples: ['账号访问说明', '登录访问说明'],
    negative_examples: ['不要报销'],
  });
}

function route(
  routeId: string,
  flowId: string,
  version: number,
  input: {
    priority: number;
    keywords: string[];
    examples: string[];
    negative_examples: string[];
    supported_channels?: string[];
    role_constraints?: string[];
  },
): RouteSpec {
  return {
    route_id: routeId,
    flow_id: flowId,
    version,
    status: 'draft',
    route: {
      priority: input.priority,
      keywords: input.keywords,
      examples: input.examples,
      negative_examples: input.negative_examples,
      supported_channels: input.supported_channels ?? ['web'],
      role_constraints: input.role_constraints ?? [],
      confidence_threshold: 0.7,
      ambiguous_threshold: 0.5,
    },
  };
}

function authHeaders(role: string, requestId: string): Record<string, string> {
  return {
    'x-user-id': userId,
    'x-tenant-id': tenantId,
    'x-roles': role,
    'x-request-id': requestId,
    'accept-language': 'zh-CN',
  };
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

main().catch((error: unknown) => {
  console.error('smoke:semantic-router-e2e failed');
  console.error(error);
  process.exit(1);
});
