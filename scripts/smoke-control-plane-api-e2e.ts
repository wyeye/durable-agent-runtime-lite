import assert from 'node:assert/strict';
import type {
  AgentSpec,
  CapabilityRelease,
  FlowSpec,
  ModelDefinitionRef,
  ModelPolicy,
  PromptDefinition,
  RouteSpec,
  RouterPreviewResponse,
  StandardResponse,
  ToolManifest,
  ToolInvokeResponse,
} from '@dar/contracts';
import { closeDb, createDb, hashModelPolicy } from '@dar/db';
import { ensureModelCatalogEntry } from './model-catalog-seed.js';

const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const toolGatewayUrl = trimTrailingSlash(process.env.TOOL_GATEWAY_URL ?? 'http://localhost:3200');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const runtimeWorkerToolGatewayToken = process.env.RUNTIME_WORKER_TOOL_GATEWAY_TOKEN ?? 'dev-only-runtime-worker-token';
const tenantId = process.env.SMOKE_TENANT_ID ?? 'default';
const userId = process.env.SMOKE_USER_ID ?? 'cp_smoke_operator';
const requestPrefix = `cp_smoke_${Date.now()}`;

const adminHeaders = authHeaders('platform_admin', `${requestPrefix}_admin`);
const operatorHeaders = authHeaders('capability_operator', `${requestPrefix}_operator`);
const auditorHeaders = authHeaders('auditor', `${requestPrefix}_auditor`);

interface RegistryRecord<TSpec> {
  resource_id: string;
  version: number;
  status: string;
  revision: number;
  spec: TSpec;
}

interface Paginated<T> {
  items: T[];
  page: number;
  page_size: number;
  total?: number;
}

async function main(): Promise<void> {
  const ids = {
    prompt: `${requestPrefix}_prompt`,
    tool: `${requestPrefix}.tool`,
    modelPolicy: `${requestPrefix}_model_policy`,
    agent: `${requestPrefix}_agent`,
    flow: `${requestPrefix}_flow`,
    route: `${requestPrefix}_route`,
    keywordV1: `${requestPrefix}-keyword-v1`,
    keywordV2: `${requestPrefix}-keyword-v2`,
  };

  const db = createDb({ databaseUrl });
  const catalog = await ensureModelCatalogEntry(db, {
    profileId: `${requestPrefix}_profile`,
    displayName: `Control-plane smoke model ${requestPrefix}`,
    baseUrl: 'http://mock-server:4100',
    authType: 'none',
    modelId: `${requestPrefix}_model`,
    upstreamModelId: `${requestPrefix}_model`,
    provider: 'local-mock',
    capabilities: ['text', 'tools', 'usage'],
    operatorId: 'cp-smoke',
  }).finally(async () => closeDb(db));

  await checkHealth(`${controlPlaneUrl}/healthz`, 'control-plane');
  await checkHealth(`${controlPlaneUrl}/readyz`, 'control-plane readyz');
  await checkI18nContract();

  await expectStatus(
    'POST',
    `${controlPlaneUrl}/api/v1/prompts`,
    undefined,
    { spec: promptSpec(ids, 1) },
    401,
    {
      errorCode: 'UNAUTHORIZED',
      messageKey: 'errors.unauthorized',
      locale: 'zh-CN',
      contentLanguage: 'zh-CN',
    },
  );
  await expectStatus(
    'POST',
    `${controlPlaneUrl}/api/v1/prompts`,
    auditorHeaders,
    { spec: promptSpec(ids, 1) },
    403,
    {
      errorCode: 'FORBIDDEN',
      messageKey: 'errors.forbidden',
      locale: 'zh-CN',
      contentLanguage: 'zh-CN',
    },
  );

  const prompt = await createDraft<PromptDefinition>('prompts', promptSpec(ids, 1));
  const tool = await createDraft<ToolManifest>('tools', toolSpec(ids, '1.0.0'));
  const modelPolicySpecV1 = modelPolicySpec(ids, 1, catalog.model_ref);
  const modelPolicy = await createDraft<ModelPolicy>('model-policies', modelPolicySpecV1);
  await validateResource('prompts', ids.prompt, 1);
  await validateResource('tools', ids.tool, 1);
  await validateResource('model-policies', ids.modelPolicy, 1);
  await publishResource('prompts', ids.prompt, 1, 'publish smoke prompt v1');
  await publishResource('tools', ids.tool, 1, 'publish smoke tool v1');
  await publishResource('model-policies', ids.modelPolicy, 1, 'publish smoke model policy v1');
  await cloneResource<PromptDefinition>('prompts', ids.prompt, 1);
  await updateDraft<PromptDefinition>(
    'prompts',
    ids.prompt,
    2,
    {
      ...promptSpec(ids, 2),
      content: 'Return a concise structured result for {{input}} in v2.',
    },
    1,
  );
  await publishResource('prompts', ids.prompt, 2, 'publish smoke prompt v2 fallback');
  const grayPrompt = await postJson<CapabilityRelease>(
    `${controlPlaneUrl}/api/v1/prompts/${encodeURIComponent(ids.prompt)}/versions/1/gray`,
    { release_note: 'gray smoke prompt v1', tenant_allowlist: [tenantId] },
    adminHeaders,
  );
  assert.equal(grayPrompt.action, 'gray');

  const agent = await createDraft<AgentSpec>('agents', agentSpec(ids, 1, modelPolicySpecV1));
  await validateResource('agents', ids.agent, 1);
  await publishResource('agents', ids.agent, 1, 'publish smoke agent v1');

  const flowV1 = await createDraft<FlowSpec>('flows', flowSpec(ids, 1));
  await createDraft<RouteSpec>('routes', routeSpec(ids, 1, ids.keywordV1));
  await validateResource('flows', ids.flow, 1);

  await postJson<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }>(
    `${controlPlaneUrl}/api/v1/releases/flow-route`,
    {
      flow_id: ids.flow,
      flow_version: 1,
      route_id: ids.route,
      route_version: 1,
      release_note: 'publish smoke flow and route v1',
    },
    adminHeaders,
  );
  await validateResource('routes', ids.route, 1);

  const releaseHistory = await getJson<CapabilityRelease[]>(
    `${controlPlaneUrl}/api/v1/flows/${encodeURIComponent(ids.flow)}/releases`,
    auditorHeaders,
  );
  assert.ok(
    releaseHistory.some((release) => release.action === 'publish'),
    'flow release history should include publish',
  );

  const previewV1 = await previewRoute(ids.keywordV1);
  assert.equal(previewV1.route_decision.decision, 'matched');
  assert.equal(previewV1.route_decision.flow_id, ids.flow);
  assert.equal(previewV1.route_decision.flow_version, 1);

  const clonedFlow = await cloneResource<FlowSpec>('flows', ids.flow, 1);
  assert.equal(clonedFlow.version, 2);
  const flowRevision = clonedFlow.revision;
  await expectStatus(
    'PUT',
    `${controlPlaneUrl}/api/v1/flows/${encodeURIComponent(ids.flow)}/versions/2`,
    operatorHeaders,
    { spec: flowSpec(ids, 2), expected_revision: flowRevision + 99 },
    409,
  );
  await updateDraft<FlowSpec>('flows', ids.flow, 2, flowSpec(ids, 2), flowRevision);
  await expectStatus(
    'PUT',
    `${controlPlaneUrl}/api/v1/flows/${encodeURIComponent(ids.flow)}/versions/1`,
    operatorHeaders,
    { spec: flowV1.spec, expected_revision: flowV1.revision },
    409,
  );

  const clonedRoute = await cloneResource<RouteSpec>('routes', ids.route, 1);
  await updateDraft<RouteSpec>(
    'routes',
    ids.route,
    2,
    routeSpec(ids, 2, ids.keywordV2),
    clonedRoute.revision,
  );

  await postJson<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }>(
    `${controlPlaneUrl}/api/v1/releases/flow-route`,
    {
      flow_id: ids.flow,
      flow_version: 2,
      route_id: ids.route,
      route_version: 2,
      release_note: 'publish smoke flow and route v2',
    },
    adminHeaders,
  );

  const previewV2 = await previewRoute(ids.keywordV2);
  assert.equal(previewV2.route_decision.decision, 'matched');
  assert.equal(previewV2.route_decision.flow_id, ids.flow);
  assert.equal(previewV2.route_decision.flow_version, 2);

  await postJson<CapabilityRelease>(
    `${controlPlaneUrl}/api/v1/routes/${encodeURIComponent(ids.route)}/rollback`,
    { target_version: 1, release_note: 'rollback smoke route to v1' },
    adminHeaders,
  );
  await postJson<CapabilityRelease>(
    `${controlPlaneUrl}/api/v1/flows/${encodeURIComponent(ids.flow)}/rollback`,
    { target_version: 1, release_note: 'rollback smoke flow to v1' },
    adminHeaders,
  );

  const afterRollback = await previewRoute(ids.keywordV1);
  assert.equal(afterRollback.route_decision.decision, 'matched');
  assert.equal(afterRollback.route_decision.flow_id, ids.flow);
  assert.equal(afterRollback.route_decision.flow_version, 1);

  const releases = await getJson<Paginated<CapabilityRelease>>(
    `${controlPlaneUrl}/api/v1/releases?resource_type=route&resource_id=${encodeURIComponent(ids.route)}&page=1&page_size=10`,
    auditorHeaders,
  );
  assert.ok(
    releases.items.some((release) => release.action === 'rollback'),
    'release list should include rollback',
  );

  await getJson(
    `${controlPlaneUrl}/api/v1/operations/human-tasks?page=1&page_size=5`,
    auditorHeaders,
  );
  const missingToolName = `${requestPrefix}.missing_tool`;
  await seedToolGatewayAuditEvent(missingToolName);
  const auditEvents = await getJson<Array<{ action: string; target_id?: string; message_key?: string; display_message?: string; locale?: string }>>(
    `${controlPlaneUrl}/api/v1/operations/audit-events?event_type=tool.invoke&page=1&page_size=20`,
    auditorHeaders,
  );
  const localizedAudit = auditEvents.find((event) => event.action === 'tool.invoke' && event.target_id === missingToolName);
  assert.ok(localizedAudit, `control-plane BFF should return the Tool Gateway audit event, got ${JSON.stringify(auditEvents)}`);
  assert.equal(localizedAudit.locale, 'zh-CN');
  assert.equal(localizedAudit.message_key, 'audit.toolInvoke');
  assert.equal(localizedAudit.display_message, '工具调用已执行。');
  assert.notEqual(localizedAudit.display_message, localizedAudit.action, 'audit display_message should be localized display text, not event action');
  await getJson(
    `${controlPlaneUrl}/api/v1/operations/tool-calls?page=1&page_size=5`,
    auditorHeaders,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        prompt: `${prompt.resource_id}@${prompt.version}`,
        tool: `${tool.resource_id}@${tool.version}`,
        model_policy: `${modelPolicy.resource_id}@${modelPolicy.version}`,
        agent: `${agent.resource_id}@${agent.version}`,
        flow: `${ids.flow}@1`,
        route: `${ids.route}@1`,
        release_count: releases.items.length,
      },
      null,
      2,
    ),
  );
}

function promptSpec(ids: { prompt: string }, version: number): PromptDefinition {
  return {
    prompt_id: ids.prompt,
    version,
    name: `Smoke prompt ${version}`,
    content: 'Return a concise structured result for {{input}}.',
    variables: ['input'],
    status: 'draft',
  };
}

function toolSpec(ids: { tool: string }, version: string): ToolManifest {
  return {
    tool_name: ids.tool,
    version,
    description: 'Control-plane smoke mock tool.',
    risk_level: 'L1',
    side_effect: false,
    adapter: { type: 'mock', endpoint_ref: 'mock/control-plane-smoke' },
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
    output_schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    },
    required_permissions: [],
    status: 'draft',
  };
}

function modelPolicySpec(
  ids: { modelPolicy: string },
  version: number,
  modelRef: ModelDefinitionRef,
): ModelPolicy {
  return {
    model_policy_id: ids.modelPolicy,
    version,
    status: 'draft',
    protocol: 'openai_chat_completions',
    targets: [
      {
        target_id: `${ids.modelPolicy}_primary`,
        model_ref: modelRef,
        priority: 0,
        enabled: true,
      },
    ],
    retry_policy: {
      max_attempts_per_target: 1,
      retryable_status_codes: [429, 500, 502, 503, 504],
      retry_on_timeout: true,
      retry_on_network_error: true,
      backoff_ms: 10,
      max_backoff_ms: 50,
    },
    fallback_policy: {
      enabled: false,
      ordered_target_ids: [],
      eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'],
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
  };
}

function agentSpec(
  ids: { agent: string; prompt: string; tool: string },
  version: number,
  modelPolicy: ModelPolicy,
): AgentSpec {
  return {
    agent_id: ids.agent,
    version,
    prompt_ref: `${ids.prompt}@1`,
    model_policy: 'mock',
    model_policy_ref: {
      model_policy_id: modelPolicy.model_policy_id,
      model_policy_version: modelPolicy.version,
      model_policy_hash: hashModelPolicy(modelPolicy),
    },
    allowed_tools: [`${ids.tool}@1.0.0`],
    allowed_handoffs: [],
    max_steps: 3,
    max_tokens: 1000,
    output_schema: 'smoke_agent_result_v1',
    status: 'draft',
  };
}

function flowSpec(ids: { flow: string; tool: string; agent: string }, version: number): FlowSpec {
  return {
    flow_id: ids.flow,
    version,
    name: `Control-plane smoke flow ${version}`,
    status: 'draft',
    runtime: {
      workflow_type: 'ConfigDrivenWorkflow',
      task_queue: 'runtime-worker-main',
    },
    steps: [
      { id: 'start', type: 'activity', activity: 'input.normalize' },
      {
        id: 'call_tool',
        type: 'tool',
        tool: ids.tool,
        tool_version: '1.0.0',
        input: { query: '${text}' },
      },
      { id: 'agent_step', type: 'agent', agent_id: ids.agent, input: { agent_version: 1 } },
    ],
  };
}

function routeSpec(
  ids: { route: string; flow: string },
  version: number,
  keyword: string,
): RouteSpec {
  return {
    route_id: ids.route,
    flow_id: ids.flow,
    version,
    status: 'draft',
    route: {
      priority: 95,
      keywords: [keyword],
      examples: [`run ${keyword}`],
      negative_examples: [],
      supported_channels: ['api'],
      role_constraints: [],
      confidence_threshold: 0.7,
      ambiguous_threshold: 0.5,
    },
  };
}

async function createDraft<TSpec>(plural: string, spec: TSpec): Promise<RegistryRecord<TSpec>> {
  return postJson<RegistryRecord<TSpec>>(
    `${controlPlaneUrl}/api/v1/${plural}`,
    { spec },
    operatorHeaders,
  );
}

async function updateDraft<TSpec>(
  plural: string,
  resourceId: string,
  version: number,
  spec: TSpec,
  expectedRevision: number,
): Promise<RegistryRecord<TSpec>> {
  return postJson<RegistryRecord<TSpec>>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}`,
    { spec, expected_revision: expectedRevision },
    operatorHeaders,
    'PUT',
  );
}

async function cloneResource<TSpec>(
  plural: string,
  resourceId: string,
  version: number,
): Promise<RegistryRecord<TSpec>> {
  return postJson<RegistryRecord<TSpec>>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/clone`,
    {},
    operatorHeaders,
  );
}

async function validateResource(
  plural: string,
  resourceId: string,
  version: number,
): Promise<void> {
  const result = await postJson<{ validation: { can_publish: boolean; errors: unknown[] } }>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/validate`,
    {},
    operatorHeaders,
  );
  assert.equal(
    result.validation.can_publish,
    true,
    `${plural}:${resourceId}@${version} should validate`,
  );
}

async function publishResource(
  plural: string,
  resourceId: string,
  version: number,
  releaseNote: string,
): Promise<CapabilityRelease> {
  return postJson<CapabilityRelease>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/publish`,
    { release_note: releaseNote },
    adminHeaders,
  );
}

async function previewRoute(keyword: string): Promise<RouterPreviewResponse> {
  return postJson<RouterPreviewResponse>(
    `${runtimeApiUrl}/v1/router/preview`,
    {
      tenant_id: tenantId,
      user_id: userId,
      request_id: `${requestPrefix}_preview_${keyword}`,
      channel: 'api',
      input: { text: `please run ${keyword}` },
    },
    operatorHeaders,
  );
}

async function checkHealth(url: string, label: string): Promise<void> {
  const response = await fetch(url, { headers: { 'accept-language': 'en-US,en;q=0.9' } });
  assertI18nHeaders(response);
  const text = await response.text();
  assert.equal(response.ok, true, `${label} failed: ${response.status} ${text}`);
  const body = JSON.parse(text) as { message_key?: string; message?: string; locale?: string };
  assert.equal(body.locale, 'zh-CN');
  assert.equal(typeof body.message_key, 'string');
  assert.equal(typeof body.message, 'string');
}

async function getJson<T = unknown>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  const body = (await response.json()) as StandardResponse<T>;
  assertI18nHeaders(response);
  if (!response.ok || body.success !== true) {
    throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as StandardResponse<T>;
  assertI18nHeaders(response);
  if (!response.ok || body.success !== true) {
    throw new Error(`${method} ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function seedToolGatewayAuditEvent(toolName: string): Promise<void> {
  const response = await fetch(`${toolGatewayUrl}/v1/tools/${encodeURIComponent(toolName)}/invoke`, {
    method: 'POST',
    headers: {
      ...serviceHeaders(`${requestPrefix}_tool_audit`),
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tool_version: '1.0.0',
      tenant_id: tenantId,
      user_context: { user_id: userId },
      task_context: { task_run_id: `${requestPrefix}_audit_task` },
      arguments: { query: 'i18n audit smoke' },
      idempotency_key: `${requestPrefix}:missing-tool`,
      request_id: `${requestPrefix}_tool_audit`,
    }),
  });
  assertI18nHeaders(response);
  const body = await response.json() as StandardResponse<ToolInvokeResponse>;
  assert.equal(response.status, 404, `Tool Gateway should produce a denied audit for missing tool: ${JSON.stringify(body)}`);
  assert.equal(body.success, false);
  assert.equal(body.error?.code, 'TOOL_NOT_FOUND');
  assert.equal(body.error?.message_key, 'errors.toolNotFound');
  assert.equal(body.error?.locale, 'zh-CN');
}

async function checkI18nContract(): Promise<void> {
  const fallback = await fetch(`${controlPlaneUrl}/version`, {
    headers: { 'accept-language': 'en-US,en;q=0.9' },
  });
  assert.equal(fallback.status, 200);
  assertI18nHeaders(fallback);
  const version = await fallback.json() as { message_key?: string; message?: string; locale?: string };
  assert.equal(version.locale, 'zh-CN');
  assert.equal(version.message_key, 'common.health.versionReady');
  assert.equal(version.message, '服务版本信息可用。');

  const explicitZh = await fetch(`${controlPlaneUrl}/version`, {
    headers: { 'accept-language': 'zh-CN' },
  });
  assert.equal(explicitZh.status, 200);
  assertI18nHeaders(explicitZh);
  assert.equal((await explicitZh.json() as { locale?: string }).locale, 'zh-CN');
}

async function expectStatus(
  method: string,
  url: string,
  headers: Record<string, string> | undefined,
  payload: unknown,
  statusCode: number,
  expected?: {
    errorCode?: string;
    messageKey?: string;
    locale?: string;
    contentLanguage?: string;
  },
): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: { ...(headers ?? {}), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    statusCode,
    `${method} ${url} should return ${statusCode}: ${text}`,
  );
  assertI18nHeaders(response, expected?.contentLanguage);
  if (expected) {
    const body = JSON.parse(text) as StandardResponse<unknown>;
    assert.equal(body.success, false);
    assert.equal(body.error?.code, expected.errorCode);
    assert.equal(body.error?.message_key, expected.messageKey);
    assert.equal(body.error?.locale, expected.locale);
    assert.equal(typeof body.error?.message, 'string');
  }
}

function assertI18nHeaders(response: Response, expected = 'zh-CN'): void {
  assert.equal(response.headers.get('content-language'), expected);
  assert.ok(
    response.headers.get('vary')?.toLowerCase().split(',').map((item) => item.trim()).includes('accept-language'),
    `response should include Vary: Accept-Language, got ${response.headers.get('vary')}`,
  );
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

function serviceHeaders(requestId: string): Record<string, string> {
  return {
    'x-service-id': 'runtime-worker',
    authorization: `Bearer ${runtimeWorkerToolGatewayToken}`,
    'x-request-id': requestId,
    'x-tenant-id': tenantId,
    'x-user-id': userId,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
