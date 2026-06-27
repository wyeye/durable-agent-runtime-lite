import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type {
  AgentSpec,
  CapabilityRelease,
  EvaluationCase,
  EvaluationExecutionPlan,
  EvaluationGateDecision,
  EvaluationGatePolicy,
  EvaluationRun,
  EvaluationSubjectSnapshot,
  FlowSpec,
  ModelPolicy,
  HumanTaskListResponse,
  ModelDefinitionRef,
  PromptDefinition,
  RouteSpec,
  RouterPreviewResponse,
  StandardResponse,
  TenantPolicyModelRule,
  TenantPolicyToolRule,
  TenantRuntimePolicy,
  TaskRun,
  ToolManifest,
} from '@dar/contracts';
import { closeDb, createDb, hashModelPolicy, EvaluationExecutionPlanBuilder, EvaluationExecutionPlanRepository, EvaluationGateDecisionRepository, EvaluationSubjectSnapshotBuilder, EvaluationSubjectSnapshotRepository, ModelPolicyRepository, upsertAgentSpec } from '@dar/db';
import { ensureModelCatalogEntry } from './model-catalog-seed.js';

const require = createRequire(import.meta.url);
const workspaceRoot = fileURLToPath(new URL('../../../..', import.meta.url));
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
  waitForResponse(
    predicate: (response: NetworkResponseLike) => boolean | Promise<boolean>,
    options?: { timeout?: number },
  ): Promise<ApiResponseLike>;
  keyboard: {
    press(key: string): Promise<unknown>;
  };
  evaluate<TArg, TResult>(
    pageFunction: (arg: TArg) => TResult | Promise<TResult>,
    arg: TArg,
  ): Promise<TResult>;
  getByTestId(testId: string): LocatorLike;
  getByText(text: string | RegExp, options?: { exact?: boolean }): LocatorLike;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): LocatorLike;
  locator(selector: string): LocatorLike;
  request: RequestLike;
}

interface LocatorLike {
  click(): Promise<unknown>;
  fill(value: string): Promise<unknown>;
  locator(selector: string): LocatorLike;
  first(): LocatorLike;
  last(): LocatorLike;
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

interface NetworkResponseLike extends ApiResponseLike {
  url(): string;
  request(): {
    method(): string;
  };
}

interface RegistryRecord<TSpec> {
  tenant_id?: string;
  resource_type?: string;
  resource_id: string;
  version: number;
  status: string;
  sha256?: string;
  revision: number;
  spec: TSpec;
}

type Db = ReturnType<typeof createDb>;

type GatedResourceType = 'prompt' | 'agent' | 'model_policy';

interface RequiredHashDataset {
  dataset_id: string;
  version: number;
  dataset_hash: string;
}

interface PublishGateMetadata {
  evaluation_candidate_bundle_hash: string;
  evaluation_gate_decision_id: string;
}

interface PublishGateCandidate {
  subjectSnapshot: EvaluationSubjectSnapshot;
  executionPlan: EvaluationExecutionPlan;
}

const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const tenantId = process.env.SMOKE_TENANT_ID ?? `cp_ui_smoke_${Date.now()}`;
const userId = process.env.SMOKE_USER_ID ?? 'cp_ui_smoke_operator';
const requestPrefix = `cp_ui_smoke_${Date.now()}`;
const deterministicModelPolicy = 'deterministic:final_only';
const operatorHeaders = authHeaders('capability_operator', `${requestPrefix}_operator`);
const adminHeaders = authHeaders('platform_admin', `${requestPrefix}_admin`);

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  const page = await browser.newPage();
  const db = createDb({ databaseUrl });
  try {
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
    const catalog = await ensureModelCatalogEntry(db, {
      profileId: `${requestPrefix}_profile`,
      displayName: `Control-plane UI smoke model ${requestPrefix}`,
      baseUrl: 'http://mock-server:4100',
      authType: 'none',
      modelId: `${requestPrefix}_model`,
      upstreamModelId: `${requestPrefix}_model`,
      provider: 'local-mock',
      capabilities: ['text', 'tools', 'usage'],
      operatorId: 'cp-ui-smoke',
    });

    await page.goto(controlPlaneUrl);
    await page.waitForLoadState('networkidle');
    await page.evaluate(
      (identity) => {
        localStorage.setItem('dar.control-plane.identity', JSON.stringify(identity));
      },
      { user_id: userId, tenant_id: tenantId, roles: ['capability_operator'] },
    );
    await page.goto(`${controlPlaneUrl}/dashboard`);
    await page.waitForLoadState('networkidle');
    await expectChineseShell(page);
    await page.getByText('运营总览').first().waitFor({ timeout: 15_000 });

    const dataset = await prepareEvaluationDataset(page);
    await preparePublishGatePolicy(page, dataset);

    const prompt = await createPromptThroughUi(page, ids);
    const tool = await createToolThroughUi(page, ids);
    const modelPolicySpecV1 = modelPolicySpec(ids, 1, catalog.model_ref);
    const modelPolicy = await createModelPolicyThroughUi(page, ids, catalog.model_ref);
    await validateResource(page, 'prompts', ids.prompt, 1);
    await validateResource(page, 'tools', ids.tool, 1);
    await validateResource(page, 'model-policies', ids.modelPolicy, 1);
    await publishResource(page, 'tools', ids.tool, 1, 'ui smoke publish tool');

    await publishTenantPolicyForUiSmoke(page, ids, catalog.model_ref, modelPolicySpecV1);

    const modelPolicyGate = await preparePublishGateForResource(page, db, {
      resourceType: 'model_policy',
      resourceId: ids.modelPolicy,
      version: 1,
      prompt,
      modelPolicy,
      dataset,
      requestSuffix: 'model_policy_gate',
    });
    await publishResource(page, 'model-policies', ids.modelPolicy, 1, 'ui smoke publish model policy', modelPolicyGate);

    const publishedModelPolicy = await getRegistryVersion<ModelPolicy>(page, 'model-policies', ids.modelPolicy, 1);
    const promptGate = await preparePublishGateForResource(page, db, {
      resourceType: 'prompt',
      resourceId: ids.prompt,
      version: 1,
      prompt,
      modelPolicy: publishedModelPolicy,
      dataset,
      requestSuffix: 'prompt_gate',
    });
    await publishResource(page, 'prompts', ids.prompt, 1, 'ui smoke publish prompt', promptGate);

    const agent = await createAgentThroughUi(page, ids, modelPolicySpecV1);
    await validateResource(page, 'agents', ids.agent, 1);
    const agentGate = await preparePublishGateForResource(page, db, {
      resourceType: 'agent',
      resourceId: ids.agent,
      version: 1,
      prompt: await getRegistryVersion<PromptDefinition>(page, 'prompts', ids.prompt, 1),
      agent: await getRegistryVersion<AgentSpec>(page, 'agents', ids.agent, 1),
      modelPolicy: publishedModelPolicy,
      dataset,
      requestSuffix: 'agent_gate',
    });
    await publishResource(page, 'agents', ids.agent, 1, 'ui smoke publish agent', agentGate);

    const flow = await createFlowThroughUi(page, ids);
    const route = await createRouteThroughUi(page, ids, ids.keywordV1);
    await validateResource(page, 'flows', ids.flow, 1);
    await postJson<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }>(
      page,
      `${controlPlaneUrl}/api/v1/releases/flow-route`,
      {
        flow_id: ids.flow,
        flow_version: 1,
        route_id: ids.route,
        route_version: 1,
        release_note: 'ui smoke publish flow route v1',
      },
      adminHeaders,
    );
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
    await updateDraft<RouteSpec>(
      page,
      'routes',
      ids.route,
      2,
      routeSpec(ids, 2, ids.keywordV2),
      routeV2.revision,
    );
    await postJson<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }>(
      page,
      `${controlPlaneUrl}/api/v1/releases/flow-route`,
      {
        flow_id: ids.flow,
        flow_version: 2,
        route_id: ids.route,
        route_version: 2,
        release_note: 'ui smoke publish flow route v2',
      },
      adminHeaders,
    );

    const previewV2 = await previewRoute(page, ids.keywordV2);
    assert.equal(previewV2.route_decision.decision, 'matched');
    assert.equal(previewV2.route_decision.flow_version, 2);

    await postJson<CapabilityRelease>(
      page,
      `${controlPlaneUrl}/api/v1/routes/${encodeURIComponent(ids.route)}/rollback`,
      {
        target_version: 1,
        release_note: 'ui smoke rollback route to v1',
      },
      adminHeaders,
    );
    await postJson<CapabilityRelease>(
      page,
      `${controlPlaneUrl}/api/v1/flows/${encodeURIComponent(ids.flow)}/rollback`,
      {
        target_version: 1,
        release_note: 'ui smoke rollback flow to v1',
      },
      adminHeaders,
    );
    const previewAfterRollback = await previewRoute(page, ids.keywordV1);
    assert.equal(previewAfterRollback.route_decision.decision, 'matched');
    assert.equal(previewAfterRollback.route_decision.flow_version, 1);

    await page.goto(`${controlPlaneUrl}/releases`);
    await page.getByText('发布中心').first().waitFor({ timeout: 15_000 });
    await page.getByText(ids.route).first().waitFor({ timeout: 15_000 });

    const l3Task = await startSeededL3Task(page, ids.keywordV1);
    const pendingHumanTask = await waitForPendingHumanTask(page, l3Task.task_run_id);
    await page.goto(
      `${controlPlaneUrl}/human-tasks?task_run_id=${encodeURIComponent(l3Task.task_run_id)}`,
    );
    await page.getByText(pendingHumanTask.human_task_id).first().waitFor({ timeout: 15_000 });
    await page.getByTestId('human-approve').first().click();
    await page.getByTestId('release-note').fill('ui smoke approve L3 task');
    await page.getByTestId('confirm-primary').click();
    await waitForTaskCompleted(page, l3Task.task_run_id);

    await page.goto(`${controlPlaneUrl}/task-runs`);
    await page.getByText('任务运行').first().waitFor({ timeout: 15_000 });
    await page.goto(`${controlPlaneUrl}/audit-events`);
    await page.getByText('审计日志').first().waitFor({ timeout: 15_000 });
    await page.goto(`${controlPlaneUrl}/tool-calls`);
    await page.getByText('工具调用').first().waitFor({ timeout: 15_000 });

    console.log(
      JSON.stringify(
        {
          ok: true,
          prompt: `${prompt.resource_id}@${prompt.version}`,
          tool: `${tool.resource_id}@${tool.version}`,
          model_policy: `${modelPolicy.resource_id}@${modelPolicy.version}`,
          agent: `${agent.resource_id}@${agent.version}`,
          flow: `${flow.resource_id}@${flow.version}`,
          route: `${route.resource_id}@${route.version}`,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDb(db);
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
    risk_level: 'L3',
    side_effect: true,
    adapter: { type: 'mock', endpoint_ref: 'mock/control-plane-ui-smoke' },
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    output_schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
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
    model_policy: deterministicModelPolicy,
    model_policy_ref: {
      model_policy_id: modelPolicy.model_policy_id,
      model_policy_version: modelPolicy.version,
      model_policy_hash: hashModelPolicy(modelPolicy),
    },
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
      {
        id: 'call_tool',
        type: 'tool',
        tool: ids.tool,
        tool_version: '1.0.0',
        mode: 'preview_commit',
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

async function publishTenantPolicyForUiSmoke(
  page: PageLike,
  ids: { tool: string; modelPolicy: string },
  modelRef: ModelDefinitionRef,
  modelPolicy: ModelPolicy,
): Promise<TenantRuntimePolicy> {
  const versions = await getJson<Array<RegistryRecord<TenantRuntimePolicy>>>(
    page,
    `${controlPlaneUrl}/api/v1/tenant-runtime-policies/${encodeURIComponent(tenantId)}/versions`,
    operatorHeaders,
  );
  const latestPublished = versions
    .map((record) => record.spec)
    .filter((policy) => policy.status === 'published')
    .sort((left, right) => right.version - left.version)[0];
  const nextVersion = Math.max(0, ...versions.map((entry) => entry.version)) + 1;
  const requiredToolRule: TenantPolicyToolRule = {
    tool_name: ids.tool,
    versions: ['1.0.0'],
    allowed_operations: ['invoke', 'preview', 'commit'],
    max_risk_level: 'L3',
  };
  const requiredModelRules: TenantPolicyModelRule[] = [
    { model_id: ids.modelPolicy },
    { model_id: `${ids.modelPolicy}@${modelPolicy.version}` },
    {
      model_id: `${ids.modelPolicy}@${modelPolicy.version}#${hashModelPolicy(modelPolicy)}`,
    },
    { model_id: modelPolicy.targets[0]?.target_id ?? `${ids.modelPolicy}_primary` },
    { model_id: modelRef.model_id },
    { model_id: deterministicModelPolicy },
  ];
  const base = latestPublished ?? minimalTenantPolicy(nextVersion);
  const draftPolicy: TenantRuntimePolicy = {
    ...base,
    version: nextVersion,
    status: 'draft',
    allowed_tools: mergeToolRules(base.allowed_tools, requiredToolRule),
    denied_tools: base.denied_tools.filter((rule) => rule.tool_name !== ids.tool),
    allowed_models: mergeModelRules(base.allowed_models, requiredModelRules),
    created_by: undefined,
    updated_by: undefined,
    published_by: undefined,
    created_at: undefined,
    updated_at: undefined,
    published_at: undefined,
  };
  const draft = await postJson<RegistryRecord<TenantRuntimePolicy>>(
    page,
    `${controlPlaneUrl}/api/v1/tenant-runtime-policies`,
    { spec: draftPolicy },
    operatorHeaders,
  );
  await validateResource(page, 'tenant-runtime-policies', tenantId, draft.version);
  await publishResource(
    page,
    'tenant-runtime-policies',
    tenantId,
    draft.version,
    `Control-plane UI smoke tenant policy ${requestPrefix}`,
  );
  return getJson<RegistryRecord<TenantRuntimePolicy>>(
    page,
    `${controlPlaneUrl}/api/v1/tenant-runtime-policies/${encodeURIComponent(tenantId)}/versions/${draft.version}`,
    operatorHeaders,
  ).then((record) => record.spec);
}

function minimalTenantPolicy(version: number): TenantRuntimePolicy {
  return {
    tenant_id: tenantId,
    version,
    status: 'draft',
    allowed_tools: [],
    denied_tools: [],
    allowed_models: [],
    denied_models: [],
    allowed_handoffs: [],
    denied_handoffs: [],
    budget_cap: {
      max_segments: 6,
      max_model_turns: 12,
      max_tool_calls: 6,
      max_input_tokens: 8000,
      max_output_tokens: 8000,
      max_total_tokens: 12000,
      max_duration_ms: 600000,
      max_handoffs: 2,
      max_context_bytes: 524288,
    },
    max_concurrent_agent_runs: 2,
    revision: 1,
  };
}

function mergeToolRules(
  existing: TenantPolicyToolRule[],
  required: TenantPolicyToolRule,
): TenantPolicyToolRule[] {
  return [
    ...existing.filter((rule) => rule.tool_name !== required.tool_name),
    required,
  ];
}

function mergeModelRules(
  existing: TenantPolicyModelRule[],
  required: TenantPolicyModelRule[],
): TenantPolicyModelRule[] {
  const byId = new Map<string, TenantPolicyModelRule>();
  for (const rule of existing) {
    byId.set(rule.model_id, rule);
  }
  for (const rule of required) {
    byId.set(rule.model_id, rule);
  }
  return [...byId.values()];
}

async function createPromptThroughUi(page: PageLike, ids: { prompt: string }): Promise<RegistryRecord<PromptDefinition>> {
  const spec = promptSpec(ids, 1);
  await openCreateDraft(page, 'prompts');
  await page.getByTestId('vc-prompt-id').fill(spec.prompt_id);
  await page.getByTestId('vc-prompt-content').fill(spec.content);
  await page.getByTestId('vc-prompt-variables-input').fill('input');
  await page.keyboard.press('Enter');
  await submitDraftAndWait<PromptDefinition>(page, 'prompts');
  const record = await getRegistryVersion<PromptDefinition>(page, 'prompts', spec.prompt_id, 1);
  assert.equal(record.spec.prompt_id, spec.prompt_id);
  assert.ok(record.spec.variables.includes('input'));
  assert.match(record.spec.content, /\{\{\s*input\s*\}\}/u);
  return record;
}

async function createToolThroughUi(page: PageLike, ids: { tool: string }): Promise<RegistryRecord<ToolManifest>> {
  const spec = toolSpec(ids, '1.0.0');
  await openCreateDraft(page, 'tools');
  await page.getByTestId('vc-tool-name').fill(spec.tool_name);
  await selectByTestId(page, 'vc-tool-risk-level', spec.risk_level);
  await page.getByTestId('vc-tool-side-effect').click();
  assert.equal(spec.adapter.type, 'mock');
  await page.getByTestId('vc-tool-endpoint-ref').fill(spec.adapter.endpoint_ref ?? '');
  await submitDraftAndWait<ToolManifest>(page, 'tools');
  const record = await getRegistryVersion<ToolManifest>(page, 'tools', spec.tool_name, 1);
  assert.equal(record.spec.tool_name, spec.tool_name);
  assert.equal(record.spec.risk_level, spec.risk_level);
  assert.equal(record.spec.side_effect, true);
  return record;
}

async function createModelPolicyThroughUi(
  page: PageLike,
  ids: { modelPolicy: string },
  modelRef: ModelDefinitionRef,
): Promise<RegistryRecord<ModelPolicy>> {
  const spec = modelPolicySpec(ids, 1, modelRef);
  await openCreateDraft(page, 'model-policies');
  await page.getByTestId('vc-model-policy-id').fill(spec.model_policy_id);
  await page.getByTestId('vc-model-target-id').fill(spec.targets[0]?.target_id ?? 'primary');
  await selectExactByTestId(
    page,
    'vc-model-target-model-ref',
    `${modelRef.model_id}@${modelRef.version}`,
    modelRef.model_id,
  );
  await page.getByTestId('vc-model-target-add').click();
  await submitDraftAndWait<ModelPolicy>(page, 'model-policies');
  const record = await getRegistryVersion<ModelPolicy>(page, 'model-policies', spec.model_policy_id, 1);
  assert.equal(record.spec.model_policy_id, spec.model_policy_id);
  assert.ok(record.spec.targets.some((target) =>
    target.target_id === spec.targets[0]?.target_id
    && target.model_ref.model_id === modelRef.model_id
    && target.model_ref.version === modelRef.version
    && target.model_ref.model_hash === modelRef.model_hash,
  ));
  return record;
}

async function createAgentThroughUi(
  page: PageLike,
  ids: { agent: string; prompt: string; tool: string },
  modelPolicy: ModelPolicy,
): Promise<RegistryRecord<AgentSpec>> {
  const spec = agentSpec(ids, 1, modelPolicy);
  await openCreateDraft(page, 'agents');
  await page.getByTestId('vc-agent-id').fill(spec.agent_id);
  await selectByTestId(page, 'vc-agent-prompt-ref', `${ids.prompt}@1`);
  await selectByTestId(page, 'vc-agent-model-policy-ref', `${modelPolicy.model_policy_id}@${modelPolicy.version}`);
  await page.getByTestId('vc-agent-allowed-tools-input').fill(`${ids.tool}@1.0.0`);
  await page.keyboard.press('Enter');
  await submitDraftAndWait<AgentSpec>(page, 'agents');
  const record = await getRegistryVersion<AgentSpec>(page, 'agents', spec.agent_id, 1);
  assert.equal(record.spec.prompt_ref, `${ids.prompt}@1`);
  assert.equal(record.spec.model_policy_ref?.model_policy_id, modelPolicy.model_policy_id);
  assert.ok(record.spec.allowed_tools.includes(`${ids.tool}@1.0.0`));
  if (record.spec.model_policy === deterministicModelPolicy) {
    return record;
  }
  const updated = await updateDraft<AgentSpec>(
    page,
    'agents',
    spec.agent_id,
    1,
    { ...record.spec, model_policy: deterministicModelPolicy },
    record.revision,
  );
  assert.equal(updated.spec.model_policy, deterministicModelPolicy);
  assert.equal(updated.spec.model_policy_ref?.model_policy_id, modelPolicy.model_policy_id);
  return updated;
}

async function createFlowThroughUi(
  page: PageLike,
  ids: { flow: string; tool: string; agent: string },
): Promise<RegistryRecord<FlowSpec>> {
  const spec = flowSpec(ids, 1);
  await openCreateDraft(page, 'flows');
  await page.getByTestId('vc-flow-id').fill(spec.flow_id);
  await page.getByRole('tab', { name: '步骤编排', exact: true }).click();
  await page.getByTestId('vc-flow-add-step-tool').click();
  await page.getByTestId('vc-flow-step-edit-1').click();
  await selectByTestId(page, 'vc-flow-step-tool-ref', `${ids.tool}@1.0.0`);
  await page.getByTestId('vc-flow-step-tool-mode').fill('preview_commit');
  await page.getByTestId('vc-flow-step-done').click();
  await page.getByTestId('vc-flow-add-step-agent').click();
  await page.getByTestId('vc-flow-step-edit-2').click();
  await selectByTestId(page, 'vc-flow-step-agent-ref', `${ids.agent}@1`);
  await page.getByTestId('vc-flow-step-done').click();
  await page.getByTestId('flow-sequence-canvas').waitFor({ timeout: 15_000 });
  await submitDraftAndWait<FlowSpec>(page, 'flows');
  const record = await waitForRegistryVersion<FlowSpec>(page, 'flows', spec.flow_id, 1);
  assert.ok(record.spec.steps.some((step) => step.type === 'tool' && step.tool === ids.tool && step.mode === 'preview_commit'));
  assert.ok(record.spec.steps.some((step) => step.type === 'agent' && step.agent_id === ids.agent));
  return record;
}

async function createRouteThroughUi(
  page: PageLike,
  ids: { route: string; flow: string },
  keyword: string,
): Promise<RegistryRecord<RouteSpec>> {
  const spec = routeSpec(ids, 1, keyword);
  await openCreateDraft(page, 'routes');
  await page.getByTestId('vc-route-id').fill(spec.route_id ?? ids.route);
  await selectByTestId(page, 'vc-route-flow-ref', `${ids.flow}@1`);
  await page.getByTestId('vc-route-keywords-input').fill(keyword);
  await page.keyboard.press('Enter');
  await page.getByTestId('vc-route-examples-input').fill(`run ${keyword}`);
  await page.keyboard.press('Enter');
  await selectByTestId(page, 'vc-route-channels-input', 'api');
  await submitDraftAndWait<RouteSpec>(page, 'routes');
  const record = await waitForRegistryVersion<RouteSpec>(page, 'routes', ids.route, 1);
  assert.equal(record.spec.flow_id, ids.flow);
  assert.ok(record.spec.route.keywords.includes(keyword));
  assert.ok(record.spec.route.supported_channels.includes('api'));
  return record;
}

async function openCreateDraft(page: PageLike, plural: string): Promise<void> {
  await page.goto(`${controlPlaneUrl}/registry/${plural}`);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('registry-create').click();
}

async function submitDraftAndWait<TSpec>(
  page: PageLike,
  plural: string,
): Promise<RegistryRecord<TSpec>> {
  const endpoint = `${controlPlaneUrl}/api/v1/${plural}`;
  const responsePromise = page.waitForResponse(
    (response) => isApiResponse(response, 'POST', endpoint),
    { timeout: 15_000 },
  );
  await page.getByTestId('draft-submit').click();
  const response = await responsePromise;
  return parseStandardResponse<RegistryRecord<TSpec>>(response, 'POST', endpoint);
}

function isApiResponse(response: NetworkResponseLike, method: string, endpoint: string): boolean {
  if (response.request().method() !== method) {
    return false;
  }
  try {
    const actual = new URL(response.url());
    const expected = new URL(endpoint);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return response.url().split('?')[0] === endpoint;
  }
}

async function selectByTestId(page: PageLike, testId: string, value: string): Promise<void> {
  const select = page.getByTestId(testId);
  await select.click();
  const fallback = value.includes('@') ? value.split('@')[0] : value;
  await select.locator('input').fill(value).catch(() => undefined);
  await page.getByText(fallback ?? value, { exact: false }).last().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await page.locator(`.ant-select-item-option[title="${cssString(value)}"]`).last().click().catch(async () => {
    await page.locator(`.ant-select-item-option:has-text("${cssString(fallback ?? value)}")`).last().click().catch(async () => {
      await page.getByText(value, { exact: false }).last().click().catch(async () => {
        await page.getByText(fallback ?? value, { exact: false }).last().click();
      });
    });
  });
}

async function selectExactByTestId(page: PageLike, testId: string, value: string, text: string): Promise<void> {
  const select = page.getByTestId(testId);
  await select.click();
  await select.locator('input').fill(value).catch(() => undefined);
  await page.getByText(text, { exact: false }).last().waitFor({ timeout: 15_000 });
  await page.getByText(text, { exact: false }).last().click();
}

function cssString(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

async function getRegistryVersion<TSpec>(
  page: PageLike,
  plural: string,
  resourceId: string,
  version: number,
): Promise<RegistryRecord<TSpec>> {
  return getJson<RegistryRecord<TSpec>>(
    page,
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}`,
    operatorHeaders,
  );
}

async function waitForRegistryVersion<TSpec>(
  page: PageLike,
  plural: string,
  resourceId: string,
  version: number,
): Promise<RegistryRecord<TSpec>> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await getRegistryVersion<TSpec>(page, plural, resourceId, version);
    } catch (error) {
      lastError = error;
      await delay(300);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for ${plural}:${resourceId}@${version}`);
}

async function cloneResource<TSpec>(
  page: PageLike,
  plural: string,
  resourceId: string,
  version: number,
): Promise<RegistryRecord<TSpec>> {
  return postJson<RegistryRecord<TSpec>>(
    page,
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/clone`,
    {},
    operatorHeaders,
  );
}

async function updateDraft<TSpec>(
  page: PageLike,
  plural: string,
  resourceId: string,
  version: number,
  spec: TSpec,
  expectedRevision: number,
): Promise<RegistryRecord<TSpec>> {
  return putJson<RegistryRecord<TSpec>>(
    page,
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}`,
    {
      spec,
      expected_revision: expectedRevision,
    },
    operatorHeaders,
  );
}

async function validateResource(
  page: PageLike,
  plural: string,
  resourceId: string,
  version: number,
): Promise<void> {
  const result = await postJson<{ validation: { can_publish: boolean; errors: unknown[] } }>(
    page,
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/validate`,
    {},
    operatorHeaders,
  );
  assert.equal(
    result.validation.can_publish,
    true,
    `${plural}:${resourceId}@${version} should validate: ${JSON.stringify(result.validation.errors)}`,
  );
}

async function publishResource(
  page: PageLike,
  plural: string,
  resourceId: string,
  version: number,
  releaseNote: string,
  gate?: PublishGateMetadata,
): Promise<CapabilityRelease> {
  return postJson<CapabilityRelease>(
    page,
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/publish`,
    {
      release_note: releaseNote,
      ...(gate ?? {}),
    },
    adminHeaders,
  );
}

async function prepareEvaluationDataset(page: PageLike): Promise<RequiredHashDataset> {
  const datasetId = `${requestPrefix}_publish_gate_dataset`;
  await postJson<RequiredHashDataset>(
    page,
    `${controlPlaneUrl}/api/v1/evaluation-datasets`,
    {
      dataset_id: datasetId,
      version: 1,
      name: `Control-plane UI publish gate ${requestPrefix}`,
      status: 'draft',
      tags: ['control-plane-ui', 'publish-gate'],
      default_weight: 1,
      revision: 1,
    },
    operatorHeaders,
  );
  const baseCase: EvaluationCase = {
    case_id: `${datasetId}_final`,
    dataset_id: datasetId,
    dataset_version: 1,
    name: 'control-plane ui publish gate final',
    input: { text: `final_only control-plane ui publish gate ${requestPrefix}` },
    expected_status: 'completed',
    expected_tool_calls: [],
    forbidden_tools: [],
    final_assertions: [{ type: 'contains', value: 'Mock final answer' }],
    policy_assertions: [],
    context_refs: [],
    weight: 1,
    tags: ['control-plane-ui', 'final_only'],
    enabled: true,
  };
  await postJson<EvaluationCase>(
    page,
    `${controlPlaneUrl}/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/1/cases`,
    baseCase,
    operatorHeaders,
  );
  await postJson<RequiredHashDataset>(
    page,
    `${controlPlaneUrl}/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/1/validate`,
    {},
    operatorHeaders,
  );
  return postJson<RequiredHashDataset>(
    page,
    `${controlPlaneUrl}/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/1/publish`,
    {},
    adminHeaders,
  );
}

async function preparePublishGatePolicy(page: PageLike, dataset: RequiredHashDataset): Promise<EvaluationGatePolicy> {
  const gatePolicyId = `zzz_control_plane_ui_gate_${requestPrefix}`;
  await postJson<EvaluationGatePolicy>(
    page,
    `${controlPlaneUrl}/api/v1/evaluation-gate-policies`,
    {
      policy: {
        gate_policy_id: gatePolicyId,
        version: 1,
        status: 'draft',
        resource_types: ['prompt', 'agent', 'model_policy'],
        required_dataset_refs: [{
          dataset_id: dataset.dataset_id,
          version: dataset.version,
          dataset_hash: dataset.dataset_hash,
        }],
        thresholds: {
          minimum_pass_rate: 1,
          minimum_weighted_score: 1,
          maximum_system_error_rate: 0,
        },
        regression_rules: {
          maximum_score_regression: 0,
          maximum_pass_rate_regression: 0,
          block_newly_failed_cases: true,
          block_safety_regression: true,
          block_tool_regression: true,
          require_same_dataset: true,
        },
        required_case_tags: [],
        allow_override: true,
      },
    },
    operatorHeaders,
  );
  await postJson<EvaluationGatePolicy>(
    page,
    `${controlPlaneUrl}/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/1/validate`,
    {},
    operatorHeaders,
  );
  return postJson<EvaluationGatePolicy>(
    page,
    `${controlPlaneUrl}/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/1/publish`,
    {},
    adminHeaders,
  );
}

async function preparePublishGateForResource(
  page: PageLike,
  db: Db,
  input: {
    resourceType: GatedResourceType;
    resourceId: string;
    version: number;
    prompt: RegistryRecord<PromptDefinition>;
    dataset: RequiredHashDataset;
    requestSuffix: string;
    agent?: RegistryRecord<AgentSpec>;
    modelPolicy?: RegistryRecord<ModelPolicy>;
  },
): Promise<PublishGateMetadata> {
  const candidate = await buildPublishGateCandidate(db, input);
  const created = await postJson<{ evaluation_run: EvaluationRun; workflow_start: Record<string, unknown> }>(
    page,
    `${controlPlaneUrl}/api/v1/evaluation-runs`,
    {
      dataset_id: input.dataset.dataset_id,
      dataset_version: input.dataset.version,
      dataset_hash: input.dataset.dataset_hash,
      subject_snapshot_ref: candidate.subjectSnapshot.subject_snapshot_ref,
      subject_snapshot_hash: candidate.executionPlan.subject_snapshot_hash,
      evaluation_execution_plan_ref: candidate.executionPlan.evaluation_execution_plan_ref,
      evaluation_execution_plan_hash: candidate.executionPlan.plan_hash,
      trigger_type: 'publish_gate',
    },
    adminHeaders,
  );
  const run = await waitForEvaluationRun(page, created.evaluation_run.evaluation_run_id);
  assert.equal(run.status, 'completed');
  const decision = await waitForGateDecision(
    db,
    input.resourceType,
    input.resourceId,
    input.version,
    candidate.subjectSnapshot.candidate_bundle_hash,
  );
  assert.equal(decision.decision, 'passed');
  return {
    evaluation_candidate_bundle_hash: decision.candidate_bundle_hash,
    evaluation_gate_decision_id: decision.gate_decision_id,
  };
}

async function buildPublishGateCandidate(
  db: Db,
  input: {
    resourceType: GatedResourceType;
    resourceId: string;
    version: number;
    prompt: RegistryRecord<PromptDefinition>;
    dataset: RequiredHashDataset;
    requestSuffix: string;
    agent?: RegistryRecord<AgentSpec>;
    modelPolicy?: RegistryRecord<ModelPolicy>;
  },
): Promise<PublishGateCandidate> {
  const promptRecord = input.prompt;
  const modelPolicyRecord = input.modelPolicy
    ?? await seedEvaluationModelPolicy(db, `${requestPrefix}_${input.requestSuffix}_policy`);
  const agentRecord = input.agent
    ? await mustGetRegistryRecord(db, 'agent', input.agent.resource_id, input.agent.version)
    : await seedEvaluationAgent(db, {
      agentId: `${requestPrefix}_${input.requestSuffix}_agent`,
      promptId: promptRecord.resource_id,
      promptVersion: promptRecord.version,
      promptHash: mustHash(promptRecord.sha256, `prompt ${promptRecord.resource_id}@${promptRecord.version}`),
      modelPolicy: modelPolicyRecord,
    });

  const primarySubjectHash = input.resourceType === 'prompt'
    ? mustHash(promptRecord.sha256, `prompt ${promptRecord.resource_id}@${promptRecord.version}`)
    : input.resourceType === 'agent'
      ? mustHash(agentRecord.sha256, `agent ${agentRecord.resource_id}@${agentRecord.version}`)
      : hashModelPolicy(modelPolicyRecord.spec);

  const subjectSnapshot = await new EvaluationSubjectSnapshotRepository(db).create(
    await new EvaluationSubjectSnapshotBuilder(db).build({
      tenantId,
      userId,
      requestId: `${requestPrefix}_${input.requestSuffix}_subject`,
      primarySubjectType: input.resourceType,
      primarySubjectId: input.resourceId,
      primarySubjectVersion: input.version,
      primarySubjectHash,
      agentId: agentRecord.resource_id,
      agentVersion: agentRecord.version,
      agentHash: mustHash(agentRecord.sha256, `agent ${agentRecord.resource_id}@${agentRecord.version}`),
      promptId: promptRecord.resource_id,
      promptVersion: promptRecord.version,
      promptHash: mustHash(promptRecord.sha256, `prompt ${promptRecord.resource_id}@${promptRecord.version}`),
      modelPolicyId: modelPolicyRecord.spec.model_policy_id,
      modelPolicyVersion: modelPolicyRecord.spec.version,
      modelPolicyHash: hashModelPolicy(modelPolicyRecord.spec),
    }),
  );
  const executionPlan = await new EvaluationExecutionPlanRepository(db).create(
    await new EvaluationExecutionPlanBuilder(db).build({
      tenantId,
      datasetId: input.dataset.dataset_id,
      datasetVersion: input.dataset.version,
      subjectSnapshot,
      evaluationMode: 'model_gateway',
    }),
  );
  return { subjectSnapshot, executionPlan };
}

async function waitForEvaluationRun(page: PageLike, runId: string): Promise<EvaluationRun> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const run = await getJson<EvaluationRun>(
      page,
      `${controlPlaneUrl}/api/v1/evaluation-runs/${encodeURIComponent(runId)}`,
      auditorHeaders(),
    );
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return run;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for EvaluationRun ${runId}`);
}

async function waitForGateDecision(
  db: Db,
  resourceType: GatedResourceType,
  resourceId: string,
  version: number,
  candidateBundleHash: string,
): Promise<EvaluationGateDecision> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const decisions = await new EvaluationGateDecisionRepository(db).listForResource({
      resourceType,
      resourceId,
      resourceVersion: version,
      limit: 20,
    });
    const decision = decisions.find((entry) => entry.candidate_bundle_hash === candidateBundleHash);
    if (decision) {
      return decision;
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for gate decision ${resourceType}:${resourceId}@${version}`);
}

async function mustGetRegistryRecord(
  db: Db,
  resourceType: 'prompt' | 'agent',
  resourceId: string,
  version: number,
): Promise<RegistryRecord<PromptDefinition> | RegistryRecord<AgentSpec>> {
  if (resourceType === 'prompt') {
    const prompt = await db
      .selectFrom('prompt_definition')
      .select(['tenant_id', 'spec_id as resource_id', 'version', 'status', 'sha256', 'revision', 'spec_json as spec'])
      .where('tenant_id', '=', tenantId)
      .where('spec_id', '=', resourceId)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!prompt) {
      throw new Error(`PromptDefinition not found: ${resourceId}@${version}`);
    }
    return prompt as RegistryRecord<PromptDefinition>;
  }
  const agent = await db
    .selectFrom('agent_spec')
    .select(['tenant_id', 'spec_id as resource_id', 'version', 'status', 'sha256', 'revision', 'spec_json as spec'])
    .where('tenant_id', '=', tenantId)
    .where('spec_id', '=', resourceId)
    .where('version', '=', version)
    .executeTakeFirst();
  if (!agent) {
    throw new Error(`AgentSpec not found: ${resourceId}@${version}`);
  }
  return agent as RegistryRecord<AgentSpec>;
}

async function seedEvaluationModelPolicy(
  db: Db,
  modelPolicyId: string,
): Promise<{ spec: ModelPolicy }> {
  const repository = new ModelPolicyRepository(db);
  const catalog = await ensureModelCatalogEntry(db, {
    profileId: `${modelPolicyId}_profile`,
    displayName: `Control-plane UI gate seed ${modelPolicyId}`,
    baseUrl: 'http://mock-server:4100',
    authType: 'none',
    modelId: `${modelPolicyId}_model`,
    upstreamModelId: 'dar-local-model',
    provider: 'local-mock',
    capabilities: ['text', 'tools', 'usage'],
    operatorId: 'cp-ui-smoke',
  });
  await repository.createDraft({
    model_policy_id: modelPolicyId,
    version: 1,
    status: 'draft',
    protocol: 'openai_chat_completions',
    targets: [{
      target_id: `${modelPolicyId}_primary`,
      model_ref: catalog.model_ref,
      priority: 0,
      enabled: true,
    }],
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
      after_tool_result_tool_choice_mode: 'none',
      response_format: 'text',
      allow_parallel_tool_calls: false,
    },
    revision: 1,
  }, { tenantId, operatorId: userId });
  const policy = await repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId: userId,
    releaseNote: `Control-plane UI gate seed ${modelPolicyId}`,
  });
  return { spec: policy };
}

async function seedEvaluationAgent(
  db: Db,
  input: {
    agentId: string;
    promptId: string;
    promptVersion: number;
    promptHash: string;
    modelPolicy: { spec: ModelPolicy };
  },
): Promise<RegistryRecord<AgentSpec>> {
  await upsertAgentSpec(db, {
    agent_id: input.agentId,
    version: 1,
    prompt_ref: `${input.promptId}@${input.promptVersion}`,
    model_policy: 'model_gateway:final_only',
    model_policy_ref: {
      model_policy_id: input.modelPolicy.spec.model_policy_id,
      model_policy_version: input.modelPolicy.spec.version,
      model_policy_hash: hashModelPolicy(input.modelPolicy.spec),
    },
    allowed_tools: [],
    allowed_handoffs: [],
    max_steps: 3,
    max_tokens: 1000,
    output_schema: 'control_plane_ui_gate_agent_v1',
    status: 'published',
  }, { tenantId, status: 'published', createdBy: userId });
  return mustGetRegistryRecord(db, 'agent', input.agentId, 1) as Promise<RegistryRecord<AgentSpec>>;
}

function mustHash(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Missing sha256 for ${label}`);
  }
  return value;
}

function auditorHeaders(): Record<string, string> {
  return authHeaders('auditor', `${requestPrefix}_auditor`);
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

async function startSeededL3Task(
  page: PageLike,
  keyword: string,
): Promise<{ task_run_id: string; workflow_id: string }> {
  return runtimePostJson<{ task_run_id: string; workflow_id: string }>(
    page,
    `${runtimeApiUrl}/v1/tasks`,
    {
      tenant_id: tenantId,
      user_id: userId,
      request_id: `${requestPrefix}_l3_task`,
      channel: 'api',
      input: { text: `please run ${keyword} with approval` },
    },
  );
}

async function waitForPendingHumanTask(
  page: PageLike,
  taskRunId: string,
): Promise<HumanTaskListResponse['human_tasks'][number]> {
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
    const task = await runtimeGetJson<TaskRun>(
      page,
      `${runtimeApiUrl}/v1/tasks/${encodeURIComponent(taskRunId)}`,
    );
    if (task.status === 'completed') {
      return task;
    }
    if (task.status === 'failed') {
      throw new Error(
        `TaskRun failed after UI approval: ${task.error_code ?? ''} ${task.error_message ?? ''}`,
      );
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for task completion: ${taskRunId}`);
}

async function postJson<T>(
  page: PageLike,
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await page.request.post(url, {
    headers: { ...headers, 'content-type': 'application/json' },
    data: payload,
  });
  return parseStandardResponse<T>(response, 'POST', url);
}

async function putJson<T>(
  page: PageLike,
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await page.request.put(url, {
    headers: { ...headers, 'content-type': 'application/json' },
    data: payload,
  });
  return parseStandardResponse<T>(response, 'PUT', url);
}

async function runtimePostJson<T>(page: PageLike, url: string, payload: unknown): Promise<T> {
  const response = await page.request.post(url, {
    headers: operatorHeaders,
    data: payload,
  });
  return parseStandardResponse<T>(response, 'POST', url);
}

async function runtimeGetJson<T>(page: PageLike, url: string): Promise<T> {
  const response = await page.request.get(url, { headers: operatorHeaders });
  return parseStandardResponse<T>(response, 'GET', url);
}

async function getJson<T>(
  page: PageLike,
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const response = await page.request.get(url, { headers });
  return parseStandardResponse<T>(response, 'GET', url);
}

async function parseStandardResponse<T>(
  response: ApiResponseLike,
  method: string,
  url: string,
): Promise<T> {
  const body = (await response.json()) as StandardResponse<T>;
  if (!response.ok() || body.success !== true) {
    throw new Error(`${method} ${url} failed: ${response.status()} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function expectChineseShell(page: PageLike): Promise<void> {
  await page.getByText('智能体运行平台').first().waitFor({ timeout: 15_000 });
  await page.getByText('运营总览').first().waitFor({ timeout: 15_000 });
  await page.getByText('能力注册').first().waitFor({ timeout: 15_000 });
  await page.getByText('评测').first().waitFor({ timeout: 15_000 });
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
