import assert from 'node:assert/strict';
import type {
  AgentRunRecord,
  CapabilityRelease,
  ModelCallAttempt,
  ModelCallRecord,
  ModelDefinition,
  ModelGatewayProfile,
  ModelPolicy,
  StandardResponse,
  TaskRun,
} from '@dar/contracts';
import {
  AgentExecutionPlanRepository,
  closeDb,
  createDb,
  hashModelPolicy,
  ModelCallAttemptRepository,
  ModelCallLogRepository,
  TenantRuntimePolicyRepository,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import { tenantRuntimePolicySchema } from '@dar/contracts';

const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const runtimeWorkerUrl = trimTrailingSlash(process.env.RUNTIME_WORKER_URL ?? 'http://localhost:3300');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const mockGatewayBaseUrl = trimTrailingSlash(
  process.env.MODEL_CATALOG_SMOKE_GATEWAY_BASE_URL ?? 'http://mock-server:4100',
);
const tenantId = process.env.SMOKE_TENANT_ID ?? `model_catalog_${Date.now()}`;
const userId = process.env.SMOKE_USER_ID ?? 'model_catalog_smoke_user';
const runId = Date.now();
const requestPrefix = `model_catalog_smoke_${runId}`;
const adminHeaders = authHeaders('platform_admin', `${requestPrefix}_admin`);
const operatorHeaders = authHeaders('capability_operator', `${requestPrefix}_operator`);

interface RegistryRecord<TSpec> {
  resource_id: string;
  version: number;
  status: string;
  revision: number;
  spec: TSpec;
}

async function main(): Promise<void> {
  const db = createDb({ databaseUrl });
  try {
    await checkHealth(`${controlPlaneUrl}/healthz`, 'control-plane');
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');
    await checkHealth(`${runtimeWorkerUrl}/healthz`, 'runtime-worker');
    const workerBefore = await getWorkerIdentity();

    const gatewayA = await createPublishedGateway({
      profile_id: `${requestPrefix}_gateway_a`,
      display_name: 'Model Catalog Smoke Gateway A',
      base_url: `${mockGatewayBaseUrl}/gateway-a`,
      api_key: 'gateway-a-secret',
      probe_model_id: `${requestPrefix}_upstream_a`,
    });
    const gatewayB = await createPublishedGateway({
      profile_id: `${requestPrefix}_gateway_b`,
      display_name: 'Model Catalog Smoke Gateway B',
      base_url: `${mockGatewayBaseUrl}/gateway-b`,
      api_key: 'gateway-b-secret',
      probe_model_id: `${requestPrefix}_upstream_b`,
    });
    assertSafeGatewayResponse(gatewayA);
    assertSafeGatewayResponse(gatewayB);

    const modelA = await createPublishedModel({
      model_id: `${requestPrefix}_model_a`,
      display_name: 'Model Catalog Smoke Model A',
      gateway_profile_id: gatewayA.profile_id,
      upstream_model_id: `${requestPrefix}_upstream_a`,
      provider: 'mock-gateway-a',
    });
    const modelB = await createPublishedModel({
      model_id: `${requestPrefix}_model_b`,
      display_name: 'Model Catalog Smoke Model B',
      gateway_profile_id: gatewayB.profile_id,
      upstream_model_id: `${requestPrefix}_upstream_b`,
      provider: 'mock-gateway-b',
    });

    const policyA = await createPublishedModelPolicy(1, [targetForModel('primary_a', modelA)], {
      fallback: false,
    });
    const planA = await createAgentPlan(db, 1, policyA, 'Model Catalog smoke agent A');
    await seedTenantPolicy(db, [modelA.model_id, modelB.model_id, policyA.model_policy_id]);
    const callA = await runAgentAndFindModelCall(db, planA.execution_plan_ref, modelA.model_id);
    assert.equal(callA.gateway_profile_id, gatewayA.profile_id);
    assert.equal(callA.upstream_model_id, modelA.upstream_model_id);
    assert.equal(callA.credential_revision, gatewayA.credential_revision);
    assert.equal(callA.credential_fingerprint, gatewayA.credential_fingerprint);

    const policyB = await createPublishedModelPolicy(2, [targetForModel('primary_b', modelB)], {
      fallback: false,
    });
    const planB = await createAgentPlan(db, 2, policyB, 'Model Catalog smoke agent B');
    await seedTenantPolicy(db, [modelA.model_id, modelB.model_id, policyA.model_policy_id, policyB.model_policy_id]);
    const callB = await runAgentAndFindModelCall(db, planB.execution_plan_ref, modelB.model_id);
    assert.equal(callB.gateway_profile_id, gatewayB.profile_id);
    assert.equal(callB.upstream_model_id, modelB.upstream_model_id);
    assert.equal(callB.credential_revision, gatewayB.credential_revision);
    assert.equal(callB.credential_fingerprint, gatewayB.credential_fingerprint);

    const rotatedGatewayB = await rotateGatewayCredential(gatewayB, 'gateway-b-secret-v2');
    assert.equal(rotatedGatewayB.credential_revision, gatewayB.credential_revision + 1);
    assert.notEqual(rotatedGatewayB.credential_fingerprint, gatewayB.credential_fingerprint);
    assertSafeGatewayResponse(rotatedGatewayB);

    const planBAfterRotation = await createAgentPlan(db, 3, policyB, 'Model Catalog smoke agent B rotated');
    const rotatedCallB = await runAgentAndFindModelCall(
      db,
      planBAfterRotation.execution_plan_ref,
      modelB.model_id,
    );
    assert.equal(rotatedCallB.gateway_profile_id, gatewayB.profile_id);
    assert.equal(rotatedCallB.credential_revision, rotatedGatewayB.credential_revision);
    assert.equal(rotatedCallB.credential_fingerprint, rotatedGatewayB.credential_fingerprint);

    const fallbackModelA = await createPublishedModel({
      model_id: `${requestPrefix}_model_a_force_503`,
      display_name: 'Model Catalog Smoke Model A fallback failure',
      gateway_profile_id: gatewayA.profile_id,
      upstream_model_id: `${requestPrefix}_upstream_force_503`,
      provider: 'mock-gateway-a',
    });
    const fallbackPolicy = await createPublishedModelPolicy(
      3,
      [
        targetForModel('primary_failing_a', fallbackModelA, 0),
        targetForModel('secondary_b', modelB, 1),
      ],
      { fallback: true },
    );
    const fallbackPlan = await createAgentPlan(
      db,
      4,
      fallbackPolicy,
      'Model Catalog smoke agent fallback from A to B',
    );
    await seedTenantPolicy(db, [
      modelA.model_id,
      modelB.model_id,
      fallbackModelA.model_id,
      policyA.model_policy_id,
      policyB.model_policy_id,
      fallbackPolicy.model_policy_id,
    ]);
    const fallbackCall = await runAgentAndFindModelCall(
      db,
      fallbackPlan.execution_plan_ref,
      modelB.model_id,
    );
    assert.equal(fallbackCall.gateway_profile_id, gatewayB.profile_id);
    assert.equal(fallbackCall.target_id, 'secondary_b');
    assert.equal(fallbackCall.fallback_index, 1);
    const fallbackAttempts = await new ModelCallAttemptRepository(db).listByModelCall(
      fallbackCall.model_call_id,
    );
    assert.equal(fallbackAttempts.length, 2);
    assert.deepEqual(
      fallbackAttempts.map((attempt) => ({
        status: attempt.status,
        target_id: attempt.target_id,
        model_id: attempt.model_id,
        gateway_profile_id: attempt.gateway_profile_id,
        fallback_index: attempt.fallback_index,
      })),
      [
        {
          status: 'failed',
          target_id: 'primary_failing_a',
          model_id: fallbackModelA.model_id,
          gateway_profile_id: gatewayA.profile_id,
          fallback_index: 0,
        },
        {
          status: 'succeeded',
          target_id: 'secondary_b',
          model_id: modelB.model_id,
          gateway_profile_id: gatewayB.profile_id,
          fallback_index: 1,
        },
      ],
    );

    const workerAfter = await getWorkerIdentity();
    assert.deepEqual(workerAfter, workerBefore, 'runtime-worker version identity changed during smoke');

    const attemptsB = await new ModelCallAttemptRepository(db).listByModelCall(callB.model_call_id);
    const attemptsRotatedB = await new ModelCallAttemptRepository(db).listByModelCall(
      rotatedCallB.model_call_id,
    );
    assertAttemptIdentity(attemptsB, {
      modelId: modelB.model_id,
      gatewayProfileId: gatewayB.profile_id,
      credentialRevision: gatewayB.credential_revision,
    });
    assertAttemptIdentity(attemptsRotatedB, {
      modelId: modelB.model_id,
      gatewayProfileId: gatewayB.profile_id,
      credentialRevision: rotatedGatewayB.credential_revision,
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          worker_restarted: false,
          gateway_count: 2,
          model_count: 2,
          gateway_a: gatewayA.profile_id,
          gateway_b: gatewayB.profile_id,
          model_a: `${modelA.model_id}@${modelA.version}`,
          model_b: `${modelB.model_id}@${modelB.version}`,
          model_call_a: callA.model_call_id,
          model_call_b: callB.model_call_id,
          model_call_b_after_rotation: rotatedCallB.model_call_id,
          fallback_model_a: `${fallbackModelA.model_id}@${fallbackModelA.version}`,
          fallback_model_b: `${modelB.model_id}@${modelB.version}`,
          fallback_model_call: fallbackCall.model_call_id,
          fallback_attempts: fallbackAttempts.map((attempt) => ({
            target_id: attempt.target_id,
            model_id: attempt.model_id,
            status: attempt.status,
            fallback_index: attempt.fallback_index,
          })),
          credential_revision_before: gatewayB.credential_revision,
          credential_revision_after: rotatedGatewayB.credential_revision,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDb(db);
  }
}

async function createPublishedGateway(input: {
  profile_id: string;
  display_name: string;
  base_url: string;
  api_key: string;
  probe_model_id: string;
}): Promise<ModelGatewayProfile> {
  const draft = await postJson<ModelGatewayProfile>(
    `${controlPlaneUrl}/api/v1/model-gateways`,
    {
      profile_id: input.profile_id,
      display_name: input.display_name,
      protocol: 'openai_chat_completions',
      base_url: input.base_url,
      auth_type: 'bearer',
      api_key: input.api_key,
    },
    adminHeaders,
  );
  assert.equal(draft.credential_configured, true);
  const published = await postJson<ModelGatewayProfile>(
    `${controlPlaneUrl}/api/v1/model-gateways/${encodeURIComponent(input.profile_id)}/publish`,
    { expected_revision: draft.revision, release_note: 'model catalog smoke publish gateway' },
    adminHeaders,
  );
  const probe = await postJson<{ reachable: boolean; response_model?: string; safe_error_code?: string }>(
    `${controlPlaneUrl}/api/v1/model-gateways/${encodeURIComponent(input.profile_id)}/test-connection`,
    { probe_model_id: input.probe_model_id },
    adminHeaders,
  );
  assert.equal(probe.reachable, true, `Gateway probe failed: ${JSON.stringify(probe)}`);
  assert.equal(probe.response_model, input.probe_model_id);
  return published;
}

async function createPublishedModel(input: {
  model_id: string;
  display_name: string;
  gateway_profile_id: string;
  upstream_model_id: string;
  provider: string;
}): Promise<ModelDefinition> {
  const draft = await postJson<ModelDefinition>(
    `${controlPlaneUrl}/api/v1/models`,
    {
      model_id: input.model_id,
      version: 1,
      display_name: input.display_name,
      gateway_profile_id: input.gateway_profile_id,
      upstream_model_id: input.upstream_model_id,
      provider: input.provider,
      capabilities: ['text', 'tools', 'usage'],
      context_window: 32768,
      max_output_tokens: 2048,
      input_cost_per_million: 0,
      output_cost_per_million: 0,
      currency: 'USD',
      tags: ['smoke', 'model-catalog'],
    },
    adminHeaders,
  );
  const validation = await postJson<{ validation: { can_publish: boolean; errors: unknown[] } }>(
    `${controlPlaneUrl}/api/v1/models/${encodeURIComponent(input.model_id)}/versions/1/validate`,
    {},
    operatorHeaders,
  );
  assert.equal(
    validation.validation.can_publish,
    true,
    `ModelDefinition should validate: ${JSON.stringify(validation.validation.errors)}`,
  );
  return postJson<ModelDefinition>(
    `${controlPlaneUrl}/api/v1/models/${encodeURIComponent(input.model_id)}/versions/1/publish`,
    { expected_revision: draft.revision, release_note: 'model catalog smoke publish model' },
    adminHeaders,
  );
}

async function createPublishedModelPolicy(
  version: number,
  targets: ModelPolicy['targets'],
  options: { fallback: boolean },
): Promise<ModelPolicy> {
  const modelPolicyId = `${requestPrefix}_policy`;
  const spec = modelPolicySpec(modelPolicyId, version, targets, options);
  await postJson<RegistryRecord<ModelPolicy>>(
    `${controlPlaneUrl}/api/v1/model-policies`,
    { spec },
    operatorHeaders,
  );
  const validation = await postJson<{ validation: { can_publish: boolean; errors: unknown[] } }>(
    `${controlPlaneUrl}/api/v1/model-policies/${encodeURIComponent(modelPolicyId)}/versions/${version}/validate`,
    {},
    operatorHeaders,
  );
  assert.equal(
    validation.validation.can_publish,
    true,
    `ModelPolicy should validate: ${JSON.stringify(validation.validation.errors)}`,
  );
  await postJson<CapabilityRelease>(
    `${controlPlaneUrl}/api/v1/model-policies/${encodeURIComponent(modelPolicyId)}/versions/${version}/publish`,
    { release_note: `model catalog smoke policy v${version}` },
    adminHeaders,
  );
  return { ...spec, status: 'published' };
}

async function createAgentPlan(
  db: ReturnType<typeof createDb>,
  agentVersion: number,
  modelPolicy: ModelPolicy,
  promptContent: string,
) {
  const promptId = `${requestPrefix}_prompt`;
  const agentId = `${requestPrefix}_agent`;
  const modelPolicyHash = hashModelPolicy(modelPolicy);
  await upsertPromptDefinition(
    db,
    {
      prompt_id: promptId,
      version: agentVersion,
      name: `Model Catalog smoke prompt ${agentVersion}`,
      content: `${promptContent}. Reply directly with final_only.`,
      variables: [],
      status: 'published',
    },
    { tenantId, status: 'published', createdBy: 'model-catalog-smoke' },
  );
  await upsertAgentSpec(
    db,
    {
      agent_id: agentId,
      version: agentVersion,
      prompt_ref: `${promptId}@${agentVersion}`,
      model_policy: modelPolicy.model_policy_id,
      model_policy_ref: {
        model_policy_id: modelPolicy.model_policy_id,
        model_policy_version: modelPolicy.version,
        model_policy_hash: modelPolicyHash,
      },
      allowed_tools: [],
      allowed_handoffs: [],
      max_steps: 2,
      max_tokens: 1000,
      output_schema: 'model_catalog_smoke_result_v1',
      status: 'published',
    },
    { tenantId, status: 'published', createdBy: 'model-catalog-smoke' },
  );
  return new AgentExecutionPlanRepository(db).createForAgent({
    tenantId,
    agentId,
    agentVersion,
    operatorId: 'model-catalog-smoke',
  });
}

async function seedTenantPolicy(
  db: ReturnType<typeof createDb>,
  allowedModelIds: string[],
): Promise<void> {
  const repository = new TenantRuntimePolicyRepository(db);
  const versions = await repository.listVersions(tenantId);
  const existing = versions.find((entry) => entry.status === 'draft');
  if (existing) {
    await repository.updateDraft(tenantId, existing.version, {
      tenantId,
      operatorId: 'model-catalog-smoke',
      expectedRevision: existing.revision,
      policy: {
        allowed_models: allowedModelIds.map((modelId) => ({ model_id: modelId })),
        denied_models: [],
        budget_cap: budgetCap(),
        max_concurrent_agent_runs: 2,
      },
    });
    await repository.publish(tenantId, existing.version, {
      tenantId,
      operatorId: 'model-catalog-smoke',
      releaseNote: 'model catalog smoke policy update',
    });
    return;
  }
  const latestVersion = Math.max(0, ...versions.map((entry) => entry.version));
  const policy = tenantRuntimePolicySchema.parse({
    tenant_id: tenantId,
    version: latestVersion + 1,
    status: 'draft',
    allowed_tools: [],
    denied_tools: [],
    allowed_models: allowedModelIds.map((modelId) => ({ model_id: modelId })),
    denied_models: [],
    allowed_handoffs: [],
    denied_handoffs: [],
    budget_cap: budgetCap(),
    max_concurrent_agent_runs: 2,
  });
  await repository.createDraft(policy, { tenantId, operatorId: 'model-catalog-smoke' });
  await repository.publish(tenantId, policy.version, {
    tenantId,
    operatorId: 'model-catalog-smoke',
    releaseNote: 'model catalog smoke policy',
  });
}

async function runAgentAndFindModelCall(
  db: ReturnType<typeof createDb>,
  executionPlanRef: string,
  expectedModelId: string,
): Promise<ModelCallRecord> {
  const task = await postJson<{
    task_run_id: string;
    workflow_id: string;
    workflow_start?: { started: boolean; mode: string };
  }>(
    `${runtimeApiUrl}/v1/agent-tasks`,
    {
      tenant_id: tenantId,
      user_id: userId,
      request_id: `${requestPrefix}_task_${expectedModelId}_${Date.now()}`,
      agent_execution_plan_ref: executionPlanRef,
      input: { text: 'final_only model catalog smoke request' },
    },
    operatorHeaders,
  );
  assert.equal(task.workflow_start?.started, true);
  assert.equal(task.workflow_start?.mode, 'temporal');
  const finalTask = await pollTask(task.task_run_id);
  assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'Agent task failed');
  const agentRuns = await getJson<{ agent_runs: AgentRunRecord[] }>(
    `${runtimeApiUrl}/v1/agent-runs?tenant_id=${encodeURIComponent(tenantId)}&task_run_id=${encodeURIComponent(task.task_run_id)}&page_size=10`,
    operatorHeaders,
  );
  assert.ok(agentRuns.agent_runs.length > 0, 'AgentRun should be queryable');
  const modelCalls = await new ModelCallLogRepository(db).list({
    tenantId,
    taskRunId: task.task_run_id,
    modelId: expectedModelId,
    status: 'succeeded',
    limit: 20,
  });
  assert.equal(
    modelCalls.length,
    1,
    `Expected exactly one succeeded model call for ${expectedModelId}, got ${modelCalls.length}`,
  );
  return modelCalls[0]!;
}

async function pollTask(taskRunId: string): Promise<TaskRun> {
  const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
  let lastTask: TaskRun | undefined;
  while (Date.now() < deadline) {
    lastTask = await getJson<TaskRun>(
      `${runtimeApiUrl}/v1/tasks/${encodeURIComponent(taskRunId)}`,
      operatorHeaders,
    );
    if (lastTask.status === 'completed' || lastTask.status === 'failed') {
      return lastTask;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${taskRunId}; last=${lastTask?.status ?? 'unknown'}`);
}

function modelPolicySpec(
  modelPolicyId: string,
  version: number,
  targets: ModelPolicy['targets'],
  options: { fallback: boolean },
): ModelPolicy {
  return {
    model_policy_id: modelPolicyId,
    version,
    status: 'draft',
    protocol: 'openai_chat_completions',
    targets,
    retry_policy: {
      max_attempts_per_target: 1,
      retryable_status_codes: [429, 500, 502, 503, 504],
      retry_on_timeout: true,
      retry_on_network_error: true,
      backoff_ms: 10,
      max_backoff_ms: 50,
    },
    fallback_policy: {
      enabled: options.fallback,
      ordered_target_ids: targets.map((target) => target.target_id),
      eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'],
      stop_on_auth_error: true,
      stop_on_validation_error: true,
      stop_on_policy_denial: true,
    },
    request_policy: {
      temperature: 0,
      top_p: 1,
      max_output_tokens: 64,
      initial_tool_choice_mode: 'none',
      after_tool_result_tool_choice_mode: 'none',
      response_format: 'text',
      allow_parallel_tool_calls: false,
    },
    revision: 1,
  };
}

function targetForModel(
  targetId: string,
  model: ModelDefinition,
  priority = 0,
): ModelPolicy['targets'][number] {
  return {
    target_id: targetId,
    model_ref: {
      model_id: model.model_id,
      version: model.version,
      model_hash: model.model_hash,
    },
    priority,
    enabled: true,
  };
}

async function rotateGatewayCredential(
  gateway: ModelGatewayProfile,
  apiKey: string,
): Promise<ModelGatewayProfile> {
  return postJson<ModelGatewayProfile>(
    `${controlPlaneUrl}/api/v1/model-gateways/${encodeURIComponent(gateway.profile_id)}/rotate-credential`,
    { api_key: apiKey, expected_credential_revision: gateway.credential_revision },
    adminHeaders,
  );
}

async function getWorkerIdentity(): Promise<Record<string, unknown>> {
  const response = await fetch(`${runtimeWorkerUrl}/version`, {
    headers: { 'accept-language': 'zh-CN' },
  });
  assert.equal(response.ok, true, `runtime-worker /version failed: ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  return {
    app: body.app,
    version: body.version,
    build_sha: body.build_sha,
    build_time: body.build_time,
    process_started_at: body.process_started_at,
  };
}

async function checkHealth(url: string, label: string): Promise<void> {
  const response = await fetch(url, { headers: { 'accept-language': 'zh-CN' } });
  assert.equal(response.ok, true, `${label} failed: ${response.status} ${await response.text()}`);
}

async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readJsonResponse<T>('POST', url, response);
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  return readJsonResponse<T>('GET', url, response);
}

async function readJsonResponse<T>(method: string, url: string, response: Response): Promise<T> {
  const body = (await response.json()) as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`${method} ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

function assertSafeGatewayResponse(value: ModelGatewayProfile): void {
  const raw = value as unknown as Record<string, unknown>;
  assert.equal(raw.api_key, undefined);
  assert.equal(raw.credential_ciphertext, undefined);
  assert.equal(raw.credential_iv, undefined);
  assert.equal(raw.credential_auth_tag, undefined);
  assert.equal(value.credential_configured, true);
  assert.equal(typeof value.credential_fingerprint, 'string');
}

function assertAttemptIdentity(
  attempts: ModelCallAttempt[],
  expected: { modelId: string; gatewayProfileId: string; credentialRevision: number },
): void {
  assert.ok(attempts.length > 0, 'ModelCallAttempt should be recorded');
  assert.ok(
    attempts.some(
      (attempt) =>
        attempt.model_id === expected.modelId &&
        attempt.gateway_profile_id === expected.gatewayProfileId &&
        attempt.credential_revision === expected.credentialRevision,
    ),
    `Attempt identity mismatch: ${JSON.stringify(attempts)}`,
  );
}

function budgetCap() {
  return {
    max_segments: 2,
    max_model_turns: 2,
    max_tool_calls: 0,
    max_total_tokens: 1000,
    max_duration_ms: 120000,
    max_handoffs: 0,
    max_context_bytes: 262144,
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

main().catch((error: unknown) => {
  console.error('smoke:model-catalog-multi-gateway-e2e failed');
  console.error(error);
  process.exit(1);
});
