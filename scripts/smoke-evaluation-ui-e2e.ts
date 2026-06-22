import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  AgentSpec,
  EvaluationCase,
  EvaluationExecutionPlan,
  EvaluationGateDecision,
  EvaluationGatePolicy,
  EvaluationRun,
  EvaluationSubjectSnapshot,
  ModelPolicy,
  PromptDefinition,
  StandardResponse,
  TenantRuntimePolicy,
} from '@dar/contracts';
import { tenantRuntimePolicySchema } from '@dar/contracts';
import {
  AgentSpecRepository,
  EvaluationExecutionPlanBuilder,
  EvaluationExecutionPlanRepository,
  EvaluationSubjectSnapshotBuilder,
  EvaluationSubjectSnapshotRepository,
  ModelPolicyRepository,
  PromptDefinitionRepository,
  TenantRuntimePolicyRepository,
  closeDb,
  createDb,
  hashModelPolicy,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import { ensureModelCatalogEntry } from './model-catalog-seed.js';

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
  newContext(options?: { recordVideo?: { dir: string } }): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
  tracing: {
    start(options: { screenshots?: boolean; snapshots?: boolean; sources?: boolean }): Promise<void>;
    stop(options: { path: string }): Promise<void>;
  };
}

interface PageLike {
  goto(url: string): Promise<unknown>;
  waitForLoadState(state?: string): Promise<unknown>;
  evaluate<TArg, TResult>(pageFunction: (arg: TArg) => TResult | Promise<TResult>, arg: TArg): Promise<TResult>;
  keyboard: {
    press(key: string): Promise<unknown>;
  };
  getByTestId(testId: string): LocatorLike;
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): LocatorLike;
  getByText(text: string | RegExp, options?: { exact?: boolean }): LocatorLike;
  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): LocatorLike;
  locator(selector: string): LocatorLike;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>;
  request: RequestLike;
}

interface LocatorLike {
  click(options?: { force?: boolean }): Promise<unknown>;
  fill(value: string): Promise<unknown>;
  first(): LocatorLike;
  last(): LocatorLike;
  nth(index: number): LocatorLike;
  locator(selector: string): LocatorLike;
  waitFor(options?: { timeout?: number }): Promise<unknown>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  innerText(options?: { timeout?: number }): Promise<string>;
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

type Db = ReturnType<typeof createDb>;

interface Candidate {
  prompt: PromptDefinition & { sha256: string };
  agent: AgentSpec & { sha256: string };
  modelPolicy: ModelPolicy & { sha256: string };
  subjectSnapshot: EvaluationSubjectSnapshot;
  executionPlan: EvaluationExecutionPlan;
}

const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const tenantId = process.env.SMOKE_TENANT_ID ?? `evaluation_ui_${Date.now()}_${randomUUID().slice(0, 8)}`;
const userId = process.env.SMOKE_USER_ID ?? 'evaluation_ui_operator';
const runStamp = `${Date.now()}_${randomUUID().slice(0, 8)}`;
const operatorIdentity = { user_id: userId, tenant_id: tenantId, roles: ['capability_operator'] };
const adminIdentity = { user_id: `${userId}_admin`, tenant_id: tenantId, roles: ['platform_admin'] };
const operatorHeaders = authHeaders(operatorIdentity);
const adminHeaders = authHeaders(adminIdentity);
const auditorHeaders = authHeaders({ user_id: `${userId}_auditor`, tenant_id: tenantId, roles: ['auditor'] });
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
const artifactDir = process.env.EVALUATION_UI_SMOKE_ARTIFACT_DIR
  ? resolve(process.env.EVALUATION_UI_SMOKE_ARTIFACT_DIR)
  : join(workspaceRoot, 'artifacts/evaluation-ui-e2e');

async function main(): Promise<void> {
  const db = createDb({ databaseUrl });
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  await mkdir(artifactDir, { recursive: true });
  const context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await context.newPage();
  try {
    await seedTenantPolicy(db);
    await setIdentity(page, operatorIdentity);
    await page.goto(`${controlPlaneUrl}/dashboard`);
    await page.waitForLoadState('networkidle');
    await expectChineseEvaluationShell(page);
    await page.getByText('运营总览').first().waitFor({ timeout: 15_000 });

    const dataset = await createDatasetThroughUi(page);
    const gatePolicy = await createGatePolicyThroughUi(page, dataset);
    const passCandidate = await prepareCandidate(db, dataset, 'pass', 'final_only', 'validated');
    const failedCandidate = await prepareCandidate(db, dataset, 'override', 'regression_b_degraded', 'validated');

    const run = await createRunThroughUi(page, dataset, passCandidate, 'publish_gate');
    const completedRun = await pollRun(run.evaluation_run_id);
    assert.equal(completedRun.status, 'completed');
    await page.goto(`${controlPlaneUrl}/evaluation/runs/${encodeURIComponent(run.evaluation_run_id)}`);
    await page.getByText('Case 结果').first().waitFor({ timeout: 15_000 });
    await page.getByText('汇总', { exact: false }).first().waitFor({ timeout: 15_000 });

    const decision = await waitForGateDecision('prompt', passCandidate.prompt.prompt_id, passCandidate.subjectSnapshot.candidate_bundle_hash);
    await page.goto(`${controlPlaneUrl}/evaluation/gate-decisions/${encodeURIComponent(decision.gate_decision_id)}`);
    await page.getByText(decision.gate_decision_id).first().waitFor({ timeout: 15_000 });

    await page.goto(`${controlPlaneUrl}/registry/prompts`);
    await page.getByTestId('registry-keyword').fill(passCandidate.prompt.prompt_id);
    await page.getByTestId('registry-search').click();
    await page.getByText(passCandidate.prompt.prompt_id).first().click();
    await page.getByTestId('evaluation-gate-card').waitFor({ timeout: 15_000 });

    const stalePrompt = await cloneAndChangePrompt(passCandidate.prompt.prompt_id);
    await expectPublishBlocked(stalePrompt.prompt_id, stalePrompt.version, decision);

    const failedRun = await createRunThroughUi(page, dataset, failedCandidate, 'publish_gate');
    const failedCompletedRun = await pollRun(failedRun.evaluation_run_id);
    assert.equal(failedCompletedRun.status, 'completed');
    const failedDecision = await waitForGateDecision('prompt', failedCandidate.prompt.prompt_id, failedCandidate.subjectSnapshot.candidate_bundle_hash);
    assert.notEqual(failedDecision.decision, 'passed');

    await setIdentity(page, adminIdentity);
    await page.goto(`${controlPlaneUrl}/evaluation/gate-decisions/${encodeURIComponent(failedDecision.gate_decision_id)}`);
    await page.getByText('Override').first().waitFor({ timeout: 15_000 });
    await page.locator('textarea').first().fill('AR-2B UI smoke exact hash override');
    await page.getByTestId('evaluation-override-expires-at').fill(new Date(Date.now() + 60 * 60 * 1000).toISOString());
    await page.getByRole('button', { name: /创建 Override/u }).click();
    await page.getByRole('button', { name: /OK|确\s*定/u }).click();
    await page.getByText(/Override 已创建/u).first().waitFor({ timeout: 15_000 });
    const override = await activeOverride(failedDecision.gate_decision_id);
    await publishPromptThroughUi(page, failedCandidate.prompt, failedDecision, override.override_id);

    await setIdentity(page, operatorIdentity);
    await page.goto(`${controlPlaneUrl}/evaluation/gate-decisions/${encodeURIComponent(failedDecision.gate_decision_id)}`);
    assert.equal(await page.getByRole('button', { name: /创建 Override/u }).isVisible({ timeout: 3000 }).catch(() => false), false);

    assert.equal(gatePolicy.gate_policy_id.includes('eval_ui_gate'), true);
    await context.tracing.stop({ path: join(artifactDir, 'trace.zip') });
    console.log(JSON.stringify({ ok: true }, null, 2));
  } catch (error) {
    await page.screenshot({ path: join(artifactDir, 'failure.png'), fullPage: true }).catch(() => undefined);
    await context.tracing.stop({ path: join(artifactDir, 'trace.zip') }).catch(() => undefined);
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await closeDb(db);
  }
}

async function createDatasetThroughUi(page: PageLike) {
  const datasetId = `eval_ui_dataset_${runStamp}`;
  const dataset = {
    dataset_id: datasetId,
    version: 1,
    name: `Evaluation UI dataset ${runStamp}`,
    status: 'draft',
    domain: 'runtime',
    tags: ['ar-2b-ui'],
    default_weight: 1,
    revision: 1,
  };
  await page.goto(`${controlPlaneUrl}/evaluation/datasets`);
  await page.getByText('评测数据集').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('evaluation-dataset-create').click();
  await page.getByTestId('vc-dataset-id').fill(dataset.dataset_id);
  await page.getByTestId('vc-dataset-name').fill(dataset.name);
  await page.getByTestId('evaluation-dataset-submit').click();
  await page.getByText(datasetId).first().waitFor({ timeout: 15_000 });

  for (const evaluationCase of [caseSpec(datasetId, 'pass', 'Mock final answer'), caseSpec(datasetId, 'second', 'Mock final answer')]) {
    await page.getByRole('tab', { name: 'Case 列表', exact: true }).click();
    await page.getByTestId('evaluation-case-create').click();
    await page.getByTestId('vc-case-id').fill(evaluationCase.case_id);
    await page.getByTestId('vc-case-name').fill(evaluationCase.name);
    await page.getByTestId('vc-case-add-expected-tool').click();
    await page.getByTestId('vc-case-expected-tool-name-0').fill(`${datasetId}.expected_tool`);
    await fillByTestId(page, 'vc-case-expected-tool-min-0', '0');
    await fillByTestId(page, 'vc-case-expected-tool-max-0', '0');
    await selectByTestId(page, 'vc-case-final-assertion-type-0', 'contains');
    await page.getByTestId('vc-case-final-assertion-value-0').fill('Mock final answer');
    await fillByTestId(page, 'vc-case-latency-budget-ms', '30000');
    await page.getByTestId('evaluation-case-submit').click();
    await page.getByText(evaluationCase.case_id).first().waitFor({ timeout: 15_000 });
  }
  await page.getByRole('button', { name: /校\s*验/u }).click();
  await page.getByText('校验已完成').first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /发\s*布/u }).click();
  await page.getByRole('button', { name: /OK|确\s*定/u }).click();
  await page.getByText('Dataset 已发布').first().waitFor({ timeout: 15_000 });
  const published = await getJson<EvaluationDatasetHash>(`${controlPlaneUrl}/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/1`, auditorHeaders);
  assert.ok(published.dataset_hash);
  return published;
}

async function createGatePolicyThroughUi(page: PageLike, dataset: EvaluationDatasetHash) {
  const gatePolicy: EvaluationGatePolicy = {
    gate_policy_id: `eval_ui_gate_${runStamp}`,
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
    required_case_tags: [],
    allow_override: true,
    revision: 1,
  };
  await setIdentity(page, adminIdentity);
  await page.goto(`${controlPlaneUrl}/evaluation/gates`);
  await page.getByText('发布门禁').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('evaluation-gate-create').click();
  await page.getByTestId('vc-gate-policy-id').fill(gatePolicy.gate_policy_id);
  await selectByTestId(page, 'vc-gate-dataset-ref', `${dataset.dataset_id}@${dataset.version}`);
  await fillByTestId(page, 'vc-gate-minimum-pass-rate', '1');
  await fillByTestId(page, 'vc-gate-maximum-latency-regression-percent', '0');
  await page.getByRole('button', { name: /提交\s*draft/u }).click();
  await page.getByText(gatePolicy.gate_policy_id).first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /校\s*验/u }).click();
  await page.getByText('Gate Policy 校验已完成').first().waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: /发\s*布/u }).click();
  await page.getByRole('button', { name: /OK|确\s*定/u }).click();
  await page.getByText('Gate Policy 已发布').first().waitFor({ timeout: 15_000 });
  await setIdentity(page, operatorIdentity);
  const published = await getJson<EvaluationGatePolicy>(`${controlPlaneUrl}/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicy.gate_policy_id)}/versions/1`, auditorHeaders);
  assert.ok(published.gate_policy_hash);
  return published;
}

async function createRunThroughUi(page: PageLike, dataset: EvaluationDatasetHash, candidate: Candidate, triggerType: 'manual' | 'publish_gate') {
  await page.goto(`${controlPlaneUrl}/evaluation/runs`);
  await page.getByText('评测任务').first().waitFor({ timeout: 15_000 });
  await page.getByTestId('evaluation-run-create').click();
  await page.getByTestId('evaluation-run-dataset-id').fill(dataset.dataset_id);
  await page.getByTestId('evaluation-run-dataset-version').fill(String(dataset.version));
  await page.getByTestId('evaluation-run-dataset-hash').fill(dataset.dataset_hash);
  await page.getByTestId('evaluation-run-primary-subject-id').fill(candidate.prompt.prompt_id);
  await page.getByTestId('evaluation-run-primary-subject-version').fill('1');
  await page.getByTestId('evaluation-run-subject-snapshot-ref').fill(candidate.subjectSnapshot.subject_snapshot_ref);
  await page.getByTestId('evaluation-run-subject-snapshot-hash').fill(candidate.executionPlan.subject_snapshot_hash);
  await page.getByTestId('evaluation-run-execution-plan-ref').fill(candidate.executionPlan.evaluation_execution_plan_ref);
  await page.getByTestId('evaluation-run-execution-plan-hash').fill(candidate.executionPlan.plan_hash);
  await page.getByTestId('evaluation-run-trigger-type').click();
  await selectTriggerType(page, triggerType);
  await page.getByTestId('evaluation-run-submit').click();
  const created = await waitLatestRun(candidate.executionPlan.evaluation_execution_plan_ref).catch(async (error: unknown) => {
    const modalText = await page.locator('.ant-modal').last().innerText({ timeout: 3000 }).catch(() => '');
    throw new Error(`${error instanceof Error ? error.message : 'run creation failed'}; modal=${modalText}`);
  });
  await page.getByText(created.evaluation_run_id.slice(0, 18)).first().waitFor({ timeout: 15_000 });
  return created;
}

async function selectTriggerType(page: PageLike, triggerType: 'manual' | 'publish_gate'): Promise<void> {
  const triggers = ['manual', 'publish_gate', 'regression', 'ci'] as const;
  const index = triggers.indexOf(triggerType);
  assert.ok(index >= 0, `Unknown trigger type ${triggerType}`);
  for (let step = 0; step < index; step += 1) {
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
}

async function selectByTestId(page: PageLike, testId: string, value: string): Promise<void> {
  const select = page.getByTestId(testId);
  await select.click();
  await select.locator('input').fill(value).catch(() => undefined);
  await page.locator(`.ant-select-item-option[title="${cssString(value)}"]`).last().click().catch(async () => {
    await page.getByText(value, { exact: false }).last().click();
  });
}

async function fillByTestId(page: PageLike, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.fill(value).catch(async () => {
    await field.locator('input').fill(value);
  });
}

function cssString(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

async function publishPromptThroughUi(page: PageLike, prompt: Candidate['prompt'], decision: EvaluationGateDecision, overrideId?: string) {
  await page.goto(`${controlPlaneUrl}/registry/prompts`);
  await page.getByTestId('registry-keyword').fill(prompt.prompt_id);
  await page.getByTestId('registry-search').click();
  await page.getByText(prompt.prompt_id).first().click();
  await page.getByTestId('evaluation-gate-card').waitFor({ timeout: 15_000 });
  if (overrideId) {
    await page.locator('input[placeholder="platform_admin override id，可选"]').fill(overrideId);
  }
  await page.getByTestId('registry-publish').click();
  await page.getByTestId('release-note').fill('evaluation UI smoke publish with exact gate decision');
  await page.getByTestId('confirm-primary').click();
  await page.getByText('发布操作已完成').first().waitFor({ timeout: 15_000 });
  const releases = await getJson<Array<{ evaluation_gate_decision_id?: string; evaluation_gate_override_id?: string }>>(
    `${controlPlaneUrl}/api/v1/prompts/${encodeURIComponent(prompt.prompt_id)}/releases`,
    auditorHeaders,
  );
  assert.ok(releases.some((release) => release.evaluation_gate_decision_id === decision.gate_decision_id));
}

async function expectPublishBlocked(promptId: string, version: number, decision: EvaluationGateDecision) {
  const response = await fetch(`${controlPlaneUrl}/api/v1/prompts/${encodeURIComponent(promptId)}/versions/${version}/publish`, {
    method: 'POST',
    headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      release_note: 'evaluation UI stale publish blocked',
      evaluation_candidate_bundle_hash: decision.candidate_bundle_hash,
      evaluation_gate_decision_id: decision.gate_decision_id,
    }),
  });
  assert.ok([400, 409, 422].includes(response.status), `stale publish must be blocked: ${response.status} ${await response.text()}`);
}

async function cloneAndChangePrompt(promptId: string): Promise<PromptDefinition & { sha256: string }> {
  const cloned = await postJson<RegistryRecord<PromptDefinition>>(
    `${controlPlaneUrl}/api/v1/prompts/${encodeURIComponent(promptId)}/versions/1/clone`,
    {},
    operatorHeaders,
  );
  const updated = await putJson<RegistryRecord<PromptDefinition>>(
    `${controlPlaneUrl}/api/v1/prompts/${encodeURIComponent(promptId)}/versions/${cloned.version}`,
    {
      spec: {
        ...cloned.spec,
        content: `${cloned.spec.content}\nchanged after evaluation UI smoke`,
      },
      expected_revision: cloned.revision,
    },
    operatorHeaders,
  );
  return { ...updated.spec, sha256: updated.sha256 };
}

async function prepareCandidate(db: Db, dataset: EvaluationDatasetHash, suffix: string, scenario: string, status: 'validated' | 'published'): Promise<Candidate> {
  const promptId = `eval_ui_${suffix}_prompt_${runStamp}`;
  const agentId = `eval_ui_${suffix}_agent_${runStamp}`;
  const modelPolicyId = `eval_ui_${suffix}_model_${runStamp}`;
  const modelPolicy = await seedModelPolicy(db, modelPolicyId, 'published');
  const modelPolicyHash = hashModelPolicy(modelPolicy);
  const prompt = await upsertPromptDefinition(db, {
    prompt_id: promptId,
    version: 1,
    name: `Evaluation UI ${suffix}`,
    content: `Evaluation UI smoke ${scenario}. Return Mock final answer when possible.`,
    variables: [],
    status,
  }, { tenantId, status, createdBy: userId });
  const promptRecord = await new PromptDefinitionRepository(db).getByIdAndVersion(promptId, 1, { tenantId });
  assert.ok(promptRecord);
  const agent = await upsertAgentSpec(db, {
    agent_id: agentId,
    version: 1,
    prompt_ref: `${promptId}@1`,
    model_policy: `model_gateway:${scenario}`,
    model_policy_ref: {
      model_policy_id: modelPolicy.model_policy_id,
      model_policy_version: 1,
      model_policy_hash: modelPolicyHash,
    },
    allowed_tools: [],
    allowed_handoffs: [],
    max_steps: 3,
    max_tokens: 1000,
    output_schema: 'evaluation_ui_smoke_v1',
    status: 'published',
  }, { tenantId, status: 'published', createdBy: userId });
  const agentRecord = await new AgentSpecRepository(db).getByIdAndVersion(agentId, 1, { tenantId });
  assert.ok(agentRecord);
  const subjectSnapshot = await new EvaluationSubjectSnapshotRepository(db).create(
    await new EvaluationSubjectSnapshotBuilder(db).build({
      tenantId,
      userId,
      requestId: `eval_ui_${suffix}`,
      primarySubjectType: 'prompt',
      primarySubjectId: promptId,
      primarySubjectVersion: 1,
      primarySubjectHash: promptRecord.sha256,
      agentId,
      agentVersion: 1,
      agentHash: agentRecord.sha256,
      promptId,
      promptVersion: 1,
      promptHash: promptRecord.sha256,
      modelPolicyId,
      modelPolicyVersion: 1,
      modelPolicyHash,
    }),
  );
  const executionPlan = await new EvaluationExecutionPlanRepository(db).create(
    await new EvaluationExecutionPlanBuilder(db).build({
      tenantId,
      datasetId: dataset.dataset_id,
      datasetVersion: dataset.version,
      subjectSnapshot,
      evaluationMode: 'model_gateway',
    }),
  );
  return {
    prompt: { ...prompt, sha256: promptRecord.sha256 },
    agent: { ...agent, sha256: agentRecord.sha256 },
    modelPolicy: { ...modelPolicy, sha256: modelPolicyHash },
    subjectSnapshot,
    executionPlan,
  };
}

async function seedTenantPolicy(db: Db): Promise<TenantRuntimePolicy> {
  const repository = new TenantRuntimePolicyRepository(db);
  const existing = await repository.getLatestPublished(tenantId);
  if (existing) {
    return existing;
  }
  const policy = tenantRuntimePolicySchema.parse({
    tenant_id: tenantId,
    version: 1,
    status: 'draft',
    allowed_tools: [],
    denied_tools: [],
    allowed_models: [
      { model_id: 'dar-local-model' },
      { model_id: 'model_gateway:final_only' },
      { model_id: 'model_gateway:regression_b_degraded' },
    ],
    denied_models: [],
    allowed_handoffs: [],
    denied_handoffs: [],
    budget_cap: { max_segments: 3, max_model_turns: 3, max_tool_calls: 0, max_total_tokens: 4000, max_duration_ms: 120000, max_handoffs: 0, max_context_bytes: 262144 },
    max_concurrent_agent_runs: 4,
  });
  await repository.createDraft(policy, { tenantId, operatorId: userId });
  return repository.publish(tenantId, 1, { tenantId, operatorId: userId, releaseNote: 'evaluation UI smoke tenant policy' });
}

async function seedModelPolicy(db: Db, modelPolicyId: string, status: 'published' | 'validated'): Promise<ModelPolicy> {
  const repository = new ModelPolicyRepository(db);
  const catalog = await ensureModelCatalogEntry(db, {
    profileId: 'local-mock',
    displayName: 'Local mock evaluation UI model',
    baseUrl: 'http://mock-server:4100',
    authType: 'none',
    modelId: 'dar-local-model',
    upstreamModelId: 'dar-local-model',
    provider: 'local-mock',
    capabilities: ['text', 'tools', 'usage', 'tool_choice'],
    operatorId: userId,
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
    retry_policy: { max_attempts_per_target: 1, retryable_status_codes: [429, 500, 502, 503, 504], retry_on_timeout: true, retry_on_network_error: true, backoff_ms: 10, max_backoff_ms: 50 },
    fallback_policy: { enabled: false, ordered_target_ids: [], eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'], stop_on_auth_error: true, stop_on_validation_error: true, stop_on_policy_denial: true },
    request_policy: { temperature: 0, top_p: 1, max_output_tokens: 1000, initial_tool_choice_mode: 'auto', after_tool_result_tool_choice_mode: 'none', response_format: 'text', allow_parallel_tool_calls: false },
    revision: 1,
  }, { tenantId, operatorId: userId });
  if (status === 'validated') {
    return repository.markValidated(modelPolicyId, 1, { tenantId, operatorId: userId });
  }
  return repository.publish(modelPolicyId, 1, { tenantId, operatorId: userId, releaseNote: 'evaluation UI smoke model policy' });
}

async function pollRun(runId: string): Promise<EvaluationRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getJson<EvaluationRun>(`${controlPlaneUrl}/api/v1/evaluation-runs/${encodeURIComponent(runId)}`, auditorHeaders);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return run;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for EvaluationRun ${runId}`);
}

async function waitLatestRun(planRef: string): Promise<EvaluationRun> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const runs = await getJson<EvaluationRun[]>(`${controlPlaneUrl}/api/v1/evaluation-runs?page_size=50`, auditorHeaders);
    const run = runs.find((item) => item.evaluation_execution_plan_ref === planRef);
    if (run) {
      return run;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for run with plan ${planRef}`);
}

async function waitForGateDecision(resourceType: 'prompt', resourceId: string, candidateBundleHash: string): Promise<EvaluationGateDecision> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await getJson<{ items: Array<{ decision: EvaluationGateDecision }> }>(
      `${controlPlaneUrl}/api/v1/evaluation-gate-decisions?resource_type=${resourceType}&resource_id=${encodeURIComponent(resourceId)}&page_size=20`,
      auditorHeaders,
    );
    const item = response.items.find((entry) => entry.decision.candidate_bundle_hash === candidateBundleHash);
    if (item) {
      return item.decision;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for gate decision ${resourceId}`);
}

async function activeOverride(decisionId: string): Promise<{ override_id: string }> {
  const item = await getJson<{ decision: EvaluationGateDecision }>(
    `${controlPlaneUrl}/api/v1/evaluation-gate-decisions/${encodeURIComponent(decisionId)}`,
    auditorHeaders,
  );
  const response = await fetch(`${controlPlaneUrl}/api/v1/evaluation-gate-decisions/${encodeURIComponent(decisionId)}`, { headers: auditorHeaders });
  assert.ok(response.ok);
  const db = createDb({ databaseUrl });
  try {
    const row = await db
      .selectFrom('evaluation_gate_override')
      .select(['override_id'])
      .where('gate_decision_id', '=', item.decision.gate_decision_id)
      .where('resource_hash', '=', item.decision.resource_hash)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    assert.ok(row);
    return row;
  } finally {
    await closeDb(db);
  }
}

async function expectChineseEvaluationShell(page: PageLike): Promise<void> {
  await page.getByText('智能体运行平台').first().waitFor({ timeout: 15_000 });
  await page.getByText('运营总览').first().waitFor({ timeout: 15_000 });
  await page.getByText('评测').first().waitFor({ timeout: 15_000 });
}

function caseSpec(datasetId: string, suffix: string, expected: string): EvaluationCase {
  return {
    case_id: `${datasetId}_${suffix}`,
    dataset_id: datasetId,
    dataset_version: 1,
    name: `Evaluation UI ${suffix}`,
    input: { text: `final_only ${suffix}` },
    context_refs: [],
    expected_status: 'completed',
    expected_tool_calls: [],
    forbidden_tools: [],
    final_assertions: [{ type: 'contains', value: expected }],
    policy_assertions: [],
    weight: 1,
    tags: ['ar-2b-ui'],
    enabled: true,
  };
}

async function setIdentity(page: PageLike, identity: { user_id: string; tenant_id: string; roles: string[] }) {
  await page.goto(controlPlaneUrl);
  await page.evaluate((next) => {
    localStorage.setItem('dar.control-plane.identity', JSON.stringify(next));
  }, identity);
}

function authHeaders(identity: { user_id: string; tenant_id: string; roles: string[] }): Record<string, string> {
  return {
    'x-user-id': identity.user_id,
    'x-tenant-id': identity.tenant_id,
    'x-roles': identity.roles.join(','),
    'x-request-id': `evaluation-ui-${randomUUID()}`,
    'accept-language': 'zh-CN',
  };
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  return parseFetchResponse<T>(response, url);
}

async function postJson<T>(url: string, data: unknown, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  return parseFetchResponse<T>(response, url);
}

async function putJson<T>(url: string, data: unknown, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  return parseFetchResponse<T>(response, url);
}

async function parseFetchResponse<T>(response: Response, url: string): Promise<T> {
  const text = await response.text();
  const payload = parseJsonBody(text, url);
  assert.ok(response.ok, `${url} failed: ${response.status} ${text}`);
  return unwrap<T>(payload);
}

function parseJsonBody(text: string, url: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${url} returned non-JSON response: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
}

function unwrap<T>(payload: unknown): T {
  const parsed = payload as StandardResponse<T>;
  if (!parsed.success) {
    throw new Error(parsed.error?.message ?? 'request failed');
  }
  return parsed.data;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

interface EvaluationDatasetHash {
  dataset_id: string;
  version: number;
  dataset_hash: string;
}

interface RegistryRecord<TSpec> {
  resource_id: string;
  version: number;
  revision: number;
  sha256: string;
  spec: TSpec;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'unknown error' }, null, 2));
  process.exitCode = 1;
});
