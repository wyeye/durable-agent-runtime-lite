import assert from 'node:assert/strict';
import type {
  AgentSpec,
  CapabilityRelease,
  FlowSpec,
  PromptDefinition,
  RouteSpec,
  RouterPreviewResponse,
  StandardResponse,
  ToolManifest,
} from '@dar/contracts';

const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
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
    agent: `${requestPrefix}_agent`,
    flow: `${requestPrefix}_flow`,
    route: `${requestPrefix}_route`,
    keywordV1: `${requestPrefix}-keyword-v1`,
    keywordV2: `${requestPrefix}-keyword-v2`,
  };

  await checkHealth(`${controlPlaneUrl}/healthz`, 'control-plane');
  await checkHealth(`${controlPlaneUrl}/readyz`, 'control-plane readyz');

  await expectStatus('POST', `${controlPlaneUrl}/api/v1/prompts`, undefined, { spec: promptSpec(ids, 1) }, 401);
  await expectStatus('POST', `${controlPlaneUrl}/api/v1/prompts`, auditorHeaders, { spec: promptSpec(ids, 1) }, 403);

  const prompt = await createDraft<PromptDefinition>('prompts', promptSpec(ids, 1));
  const tool = await createDraft<ToolManifest>('tools', toolSpec(ids, '1.0.0'));
  await validateResource('prompts', ids.prompt, 1);
  await validateResource('tools', ids.tool, 1);
  await publishResource('prompts', ids.prompt, 1, 'publish smoke prompt v1');
  await publishResource('tools', ids.tool, 1, 'publish smoke tool v1');
  await cloneResource<PromptDefinition>('prompts', ids.prompt, 1);
  await updateDraft<PromptDefinition>('prompts', ids.prompt, 2, {
    ...promptSpec(ids, 2),
    content: 'Return a concise structured result for {{input}} in v2.',
  }, 1);
  await publishResource('prompts', ids.prompt, 2, 'publish smoke prompt v2 fallback');
  const grayPrompt = await postJson<CapabilityRelease>(
    `${controlPlaneUrl}/api/v1/prompts/${encodeURIComponent(ids.prompt)}/versions/1/gray`,
    { release_note: 'gray smoke prompt v1', tenant_allowlist: [tenantId] },
    adminHeaders,
  );
  assert.equal(grayPrompt.action, 'gray');

  const agent = await createDraft<AgentSpec>('agents', agentSpec(ids, 1));
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
  assert.ok(releaseHistory.some((release) => release.action === 'publish'), 'flow release history should include publish');

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
  await updateDraft<RouteSpec>('routes', ids.route, 2, routeSpec(ids, 2, ids.keywordV2), clonedRoute.revision);

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
  assert.ok(releases.items.some((release) => release.action === 'rollback'), 'release list should include rollback');

  await getJson(`${controlPlaneUrl}/api/v1/operations/human-tasks?page=1&page_size=5`, auditorHeaders);
  await getJson(`${controlPlaneUrl}/api/v1/operations/audit-events?page=1&page_size=5`, auditorHeaders);
  await getJson(`${controlPlaneUrl}/api/v1/operations/tool-calls?page=1&page_size=5`, auditorHeaders);

  console.log(JSON.stringify({
    ok: true,
    prompt: `${prompt.resource_id}@${prompt.version}`,
    tool: `${tool.resource_id}@${tool.version}`,
    agent: `${agent.resource_id}@${agent.version}`,
    flow: `${ids.flow}@1`,
    route: `${ids.route}@1`,
    release_count: releases.items.length,
  }, null, 2));
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

function agentSpec(ids: { agent: string; prompt: string; tool: string }, version: number): AgentSpec {
  return {
    agent_id: ids.agent,
    version,
    prompt_ref: `${ids.prompt}@1`,
    model_policy: 'mock',
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

function routeSpec(ids: { route: string; flow: string }, version: number, keyword: string): RouteSpec {
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
  return postJson<RegistryRecord<TSpec>>(`${controlPlaneUrl}/api/v1/${plural}`, { spec }, operatorHeaders);
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

async function cloneResource<TSpec>(plural: string, resourceId: string, version: number): Promise<RegistryRecord<TSpec>> {
  return postJson<RegistryRecord<TSpec>>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/clone`,
    {},
    operatorHeaders,
  );
}

async function validateResource(plural: string, resourceId: string, version: number): Promise<void> {
  const result = await postJson<{ validation: { can_publish: boolean; errors: unknown[] } }>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/validate`,
    {},
    operatorHeaders,
  );
  assert.equal(result.validation.can_publish, true, `${plural}:${resourceId}@${version} should validate`);
}

async function publishResource(plural: string, resourceId: string, version: number, releaseNote: string): Promise<CapabilityRelease> {
  return postJson<CapabilityRelease>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/publish`,
    { release_note: releaseNote },
    adminHeaders,
  );
}

async function previewRoute(keyword: string): Promise<RouterPreviewResponse> {
  return postJson<RouterPreviewResponse>(`${runtimeApiUrl}/v1/router/preview`, {
    tenant_id: tenantId,
    user_id: userId,
    request_id: `${requestPrefix}_preview_${keyword}`,
    channel: 'api',
    input: { text: `please run ${keyword}` },
  });
}

async function checkHealth(url: string, label: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${label} failed: ${response.status} ${await response.text()}`);
}

async function getJson<T = unknown>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  const body = (await response.json()) as StandardResponse<T>;
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
  if (!response.ok || body.success !== true) {
    throw new Error(`${method} ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function expectStatus(
  method: string,
  url: string,
  headers: Record<string, string> | undefined,
  payload: unknown,
  statusCode: number,
): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: { ...(headers ?? {}), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, statusCode, `${method} ${url} should return ${statusCode}: ${await response.text()}`);
}

function authHeaders(role: string, requestId: string): Record<string, string> {
  return {
    'x-user-id': userId,
    'x-tenant-id': tenantId,
    'x-roles': role,
    'x-request-id': requestId,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
