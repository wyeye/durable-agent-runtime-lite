import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type {
  AgentSpec,
  CapabilityRelease,
  FlowSpec,
  HumanTaskListResponse,
  PromptDefinition,
  RouteSpec,
  RouterPreviewResponse,
  StandardResponse,
  TaskRun,
  ToolManifest,
} from '@dar/contracts';

const require = createRequire(import.meta.url);
const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const playwrightPath = require.resolve('playwright', {
  paths: [resolve(workspaceRoot, 'apps/control-plane')],
});
const { chromium } = require(playwrightPath) as {
  chromium: {
    launch(options?: { headless?: boolean }): Promise<BrowserLike>;
  };
};

interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface PageLike {
  goto(url: string): Promise<unknown>;
  waitForLoadState(state?: string): Promise<unknown>;
  evaluate<TArg, TResult>(pageFunction: (arg: TArg) => TResult | Promise<TResult>, arg: TArg): Promise<TResult>;
  getByTestId(testId: string): LocatorLike;
  getByText(text: string | RegExp, options?: { exact?: boolean }): LocatorLike;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): LocatorLike;
  request: RequestLike;
}

interface LocatorLike {
  click(): Promise<unknown>;
  fill(value: string): Promise<unknown>;
  first(): LocatorLike;
  waitFor(options?: { timeout?: number }): Promise<unknown>;
}

interface RequestLike {
  get(url: string, options?: RequestOptions): Promise<ApiResponseLike>;
  post(url: string, options?: RequestOptions): Promise<ApiResponseLike>;
  put(url: string, options?: RequestOptions): Promise<ApiResponseLike>;
}

interface RequestOptions {
  headers?: Record<string, string>;
  data?: unknown;
}

interface ApiResponseLike {
  ok(): boolean;
  status(): number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface RegistryRecord<TSpec> {
  resource_id: string;
  version: number;
  status: string;
  revision: number;
  spec: TSpec;
}

const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const tenantId = process.env.SMOKE_TENANT_ID ?? 'default';
const userId = process.env.SMOKE_USER_ID ?? 'cp_ui_smoke_operator';
const requestPrefix = `cp_ui_smoke_${Date.now()}`;
const operatorHeaders = authHeaders('capability_operator', `${requestPrefix}_operator`);
const adminHeaders = authHeaders('platform_admin', `${requestPrefix}_admin`);

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  const page = await browser.newPage();
  try {
    const ids = {
      prompt: `${requestPrefix}_prompt`,
      tool: `${requestPrefix}.tool`,
      agent: `${requestPrefix}_agent`,
      flow: `${requestPrefix}_flow`,
      route: `${requestPrefix}_route`,
      keywordV1: `${requestPrefix}-keyword-v1`,
      keywordV2: `${requestPrefix}-keyword-v2`,
    };

    await page.goto(controlPlaneUrl);
    await page.waitForLoadState('networkidle');
    await page.evaluate((identity) => {
      localStorage.setItem('dar.control-plane.identity', JSON.stringify(identity));
    }, { user_id: userId, tenant_id: tenantId, roles: ['capability_operator'] });
    await page.goto(`${controlPlaneUrl}/dashboard`);
    await page.waitForLoadState('networkidle');
    await page.getByText('Dashboard').first().waitFor({ timeout: 15_000 });

    const prompt = await createDraft<PromptDefinition>(page, 'prompts', promptSpec(ids, 1));
    const tool = await createDraft<ToolManifest>(page, 'tools', toolSpec(ids, '1.0.0'));
    await validateResource(page, 'prompts', ids.prompt, 1);
    await validateResource(page, 'tools', ids.tool, 1);
    await publishResource(page, 'prompts', ids.prompt, 1, 'ui smoke publish prompt');
    await publishResource(page, 'tools', ids.tool, 1, 'ui smoke publish tool');

    const agent = await createDraft<AgentSpec>(page, 'agents', agentSpec(ids, 1));
    await validateResource(page, 'agents', ids.agent, 1);
    await publishResource(page, 'agents', ids.agent, 1, 'ui smoke publish agent');

    const flow = await createDraft<FlowSpec>(page, 'flows', flowSpec(ids, 1));
    const route = await createDraft<RouteSpec>(page, 'routes', routeSpec(ids, 1, ids.keywordV1));
    await validateResource(page, 'flows', ids.flow, 1);
    await postJson<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }>(page, `${controlPlaneUrl}/api/v1/releases/flow-route`, {
      flow_id: ids.flow,
      flow_version: 1,
      route_id: ids.route,
      route_version: 1,
      release_note: 'ui smoke publish flow route v1',
    }, adminHeaders);

    await page.goto(`${controlPlaneUrl}/registry/flows`);
    await page.getByTestId('registry-keyword').fill(ids.flow);
    await page.getByTestId('registry-search').click();
    await page.getByText(ids.flow).first().waitFor({ timeout: 15_000 });

    const previewV1 = await previewRoute(page, ids.keywordV1);
    assert.equal(previewV1.route_decision.decision, 'matched');
    assert.equal(previewV1.route_decision.flow_id, ids.flow);
    assert.equal(previewV1.route_decision.flow_version, 1);

    const flowV2 = await cloneResource<FlowSpec>(page, 'flows', ids.flow, 1);
    await updateDraft<FlowSpec>(page, 'flows', ids.flow, 2, flowSpec(ids, 2), flowV2.revision);
    const routeV2 = await cloneResource<RouteSpec>(page, 'routes', ids.route, 1);
    await updateDraft<RouteSpec>(page, 'routes', ids.route, 2, routeSpec(ids, 2, ids.keywordV2), routeV2.revision);
    await postJson<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }>(page, `${controlPlaneUrl}/api/v1/releases/flow-route`, {
      flow_id: ids.flow,
      flow_version: 2,
      route_id: ids.route,
      route_version: 2,
      release_note: 'ui smoke publish flow route v2',
    }, adminHeaders);

    const previewV2 = await previewRoute(page, ids.keywordV2);
    assert.equal(previewV2.route_decision.decision, 'matched');
    assert.equal(previewV2.route_decision.flow_version, 2);

    await postJson<CapabilityRelease>(page, `${controlPlaneUrl}/api/v1/routes/${encodeURIComponent(ids.route)}/rollback`, {
      target_version: 1,
      release_note: 'ui smoke rollback route to v1',
    }, adminHeaders);
    await postJson<CapabilityRelease>(page, `${controlPlaneUrl}/api/v1/flows/${encodeURIComponent(ids.flow)}/rollback`, {
      target_version: 1,
      release_note: 'ui smoke rollback flow to v1',
    }, adminHeaders);
    const previewAfterRollback = await previewRoute(page, ids.keywordV1);
    assert.equal(previewAfterRollback.route_decision.decision, 'matched');
    assert.equal(previewAfterRollback.route_decision.flow_version, 1);

    await page.goto(`${controlPlaneUrl}/releases`);
    await page.getByText(ids.route).first().waitFor({ timeout: 15_000 });

    const l3Task = await startSeededL3Task(page);
    const pendingHumanTask = await waitForPendingHumanTask(page, l3Task.task_run_id);
    await page.goto(`${controlPlaneUrl}/human-tasks?task_run_id=${encodeURIComponent(l3Task.task_run_id)}`);
    await page.getByText(pendingHumanTask.human_task_id).first().waitFor({ timeout: 15_000 });
    await page.getByTestId('human-approve').first().click();
    await page.getByTestId('release-note').fill('ui smoke approve L3 task');
    await page.getByTestId('confirm-primary').click();
    await waitForTaskCompleted(page, l3Task.task_run_id);

    await page.goto(`${controlPlaneUrl}/task-runs`);
    await page.getByText('TaskRuns').first().waitFor({ timeout: 15_000 });
    await page.goto(`${controlPlaneUrl}/audit-events`);
    await page.getByText('Audit Events').first().waitFor({ timeout: 15_000 });
    await page.goto(`${controlPlaneUrl}/tool-calls`);
    await page.getByText('Tool Calls').first().waitFor({ timeout: 15_000 });

    console.log(JSON.stringify({
      ok: true,
      prompt: `${prompt.resource_id}@${prompt.version}`,
      tool: `${tool.resource_id}@${tool.version}`,
      agent: `${agent.resource_id}@${agent.version}`,
      flow: `${flow.resource_id}@${flow.version}`,
      route: `${route.resource_id}@${route.version}`,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

function promptSpec(ids: { prompt: string }, version: number): PromptDefinition {
  return {
    prompt_id: ids.prompt,
    version,
    name: `UI smoke prompt ${version}`,
    content: 'Return a concise result for {{input}}.',
    variables: ['input'],
    status: 'draft',
  };
}

function toolSpec(ids: { tool: string }, version: string): ToolManifest {
  return {
    tool_name: ids.tool,
    version,
    description: 'Control-plane UI smoke mock tool.',
    risk_level: 'L1',
    side_effect: false,
    adapter: { type: 'mock', endpoint_ref: 'mock/control-plane-ui-smoke' },
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    output_schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
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
    output_schema: 'ui_smoke_agent_result_v1',
    status: 'draft',
  };
}

function flowSpec(ids: { flow: string; tool: string; agent: string }, version: number): FlowSpec {
  return {
    flow_id: ids.flow,
    version,
    name: `Control-plane UI smoke flow ${version}`,
    status: 'draft',
    runtime: {
      workflow_type: 'ConfigDrivenWorkflow',
      task_queue: 'runtime-worker-main',
    },
    steps: [
      { id: 'start', type: 'activity', activity: 'input.normalize' },
      { id: 'call_tool', type: 'tool', tool: ids.tool, tool_version: '1.0.0', input: { query: '${text}' } },
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

async function createDraft<TSpec>(page: PageLike, plural: string, spec: TSpec): Promise<RegistryRecord<TSpec>> {
  return postJson<RegistryRecord<TSpec>>(page, `${controlPlaneUrl}/api/v1/${plural}`, { spec }, operatorHeaders);
}

async function cloneResource<TSpec>(page: PageLike, plural: string, resourceId: string, version: number): Promise<RegistryRecord<TSpec>> {
  return postJson<RegistryRecord<TSpec>>(page, `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/clone`, {}, operatorHeaders);
}

async function updateDraft<TSpec>(page: PageLike, plural: string, resourceId: string, version: number, spec: TSpec, expectedRevision: number): Promise<RegistryRecord<TSpec>> {
  return putJson<RegistryRecord<TSpec>>(page, `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}`, {
    spec,
    expected_revision: expectedRevision,
  }, operatorHeaders);
}

async function validateResource(page: PageLike, plural: string, resourceId: string, version: number): Promise<void> {
  const result = await postJson<{ validation: { can_publish: boolean; errors: unknown[] } }>(page, `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/validate`, {}, operatorHeaders);
  assert.equal(result.validation.can_publish, true, `${plural}:${resourceId}@${version} should validate`);
}

async function publishResource(page: PageLike, plural: string, resourceId: string, version: number, releaseNote: string): Promise<CapabilityRelease> {
  return postJson<CapabilityRelease>(page, `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/publish`, {
    release_note: releaseNote,
  }, adminHeaders);
}

async function previewRoute(page: PageLike, keyword: string): Promise<RouterPreviewResponse> {
  return runtimePostJson<RouterPreviewResponse>(page, `${runtimeApiUrl}/v1/router/preview`, {
    tenant_id: tenantId,
    user_id: userId,
    request_id: `${requestPrefix}_preview_${keyword}`,
    channel: 'api',
    input: { text: `please run ${keyword}` },
  });
}

async function startSeededL3Task(page: PageLike): Promise<{ task_run_id: string; workflow_id: string }> {
  return runtimePostJson<{ task_run_id: string; workflow_id: string }>(page, `${runtimeApiUrl}/v1/tasks`, {
    tenant_id: tenantId,
    user_id: userId,
    request_id: `${requestPrefix}_l3_task`,
    input: { text: 'db-smoke UI human approval' },
  });
}

async function waitForPendingHumanTask(page: PageLike, taskRunId: string): Promise<HumanTaskListResponse['human_tasks'][number]> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const list = await getJson<HumanTaskListResponse>(
      page,
      `${controlPlaneUrl}/api/v1/operations/human-tasks?task_run_id=${encodeURIComponent(taskRunId)}&status=pending&page_size=10`,
      operatorHeaders,
    );
    const task = list.human_tasks[0];
    if (task) {
      return task;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for pending human task for ${taskRunId}`);
}

async function waitForTaskCompleted(page: PageLike, taskRunId: string): Promise<TaskRun> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const task = await runtimeGetJson<TaskRun>(page, `${runtimeApiUrl}/v1/tasks/${encodeURIComponent(taskRunId)}`);
    if (task.status === 'completed') {
      return task;
    }
    if (task.status === 'failed') {
      throw new Error(`TaskRun failed after UI approval: ${task.error_code ?? ''} ${task.error_message ?? ''}`);
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for task completion: ${taskRunId}`);
}

async function postJson<T>(page: PageLike, url: string, payload: unknown, headers: Record<string, string>): Promise<T> {
  const response = await page.request.post(url, { headers: { ...headers, 'content-type': 'application/json' }, data: payload });
  return parseStandardResponse<T>(response, 'POST', url);
}

async function putJson<T>(page: PageLike, url: string, payload: unknown, headers: Record<string, string>): Promise<T> {
  const response = await page.request.put(url, { headers: { ...headers, 'content-type': 'application/json' }, data: payload });
  return parseStandardResponse<T>(response, 'PUT', url);
}

async function runtimePostJson<T>(page: PageLike, url: string, payload: unknown): Promise<T> {
  const response = await page.request.post(url, { data: payload });
  return parseStandardResponse<T>(response, 'POST', url);
}

async function runtimeGetJson<T>(page: PageLike, url: string): Promise<T> {
  const response = await page.request.get(url);
  return parseStandardResponse<T>(response, 'GET', url);
}

async function getJson<T>(page: PageLike, url: string, headers: Record<string, string>): Promise<T> {
  const response = await page.request.get(url, { headers });
  return parseStandardResponse<T>(response, 'GET', url);
}

async function parseStandardResponse<T>(response: ApiResponseLike, method: string, url: string): Promise<T> {
  const body = await response.json() as StandardResponse<T>;
  if (!response.ok() || body.success !== true) {
    throw new Error(`${method} ${url} failed: ${response.status()} ${JSON.stringify(body)}`);
  }
  return body.data;
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
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
