import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentRunRecord, AgentStepRecord, StandardResponse, TaskRun, ToolManifest } from '@dar/contracts';
import { tenantRuntimePolicySchema } from '@dar/contracts';
import {
  AgentExecutionPlanRepository,
  IdempotencyRecordRepository,
  ModelPolicyRepository,
  TenantRuntimePolicyRepository,
  ToolCallLogRepository,
  ToolManifestRepository,
  closeDb,
  createDb,
  hashModelPolicy,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import { ensureModelCatalogEntry } from './model-catalog-seed.js';

const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const mockServerUrl = trimTrailingSlash(process.env.MOCK_SERVER_URL ?? 'http://localhost:4100');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const runId = Date.now();
const tenantId = process.env.SMOKE_TENANT_ID ?? `http_readonly_tool_${runId}`;
const userId = process.env.SMOKE_USER_ID ?? 'http_readonly_tool_user';
const requestId = `http_readonly_tool_${runId}`;
const runtimeHeaders = {
  'x-user-id': userId,
  'x-tenant-id': tenantId,
  'x-roles': 'capability_operator',
  'x-request-id': requestId,
};

async function main() {
  const db = createDb({ databaseUrl });
  try {
    await resetMockBusinessApi();
    const executionPlanRef = await seedAgentPlan(db);
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');

    const task = await postJson<{ task_run_id: string; workflow_id: string; workflow_start?: { mode: string; started: boolean } }>(
      `${runtimeApiUrl}/v1/agent-tasks`,
      {
        tenant_id: tenantId,
        user_id: userId,
        request_id: `${requestId}_task`,
        agent_execution_plan_ref: executionPlanRef,
        input: { text: '我想了解公司差旅费用怎么报销' },
      },
    );
    assert.equal(task.workflow_start?.started, true);
    assert.equal(task.workflow_start?.mode, 'temporal');

    const finalTask = await pollTask(task.task_run_id);
    assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'HTTP readonly tool task should complete');

    const agentRuns = await getJson<{ agent_runs: AgentRunRecord[] }>(
      `${runtimeApiUrl}/v1/agent-runs?tenant_id=${encodeURIComponent(tenantId)}&task_run_id=${encodeURIComponent(task.task_run_id)}&page_size=10`,
    );
    const agentRun = agentRuns.agent_runs[0];
    assert.ok(agentRun, 'AgentRun should exist');
    assert.equal(agentRun.status, 'completed');

    const steps = await getJson<{ agent_steps: AgentStepRecord[] }>(
      `${runtimeApiUrl}/v1/agent-runs/${encodeURIComponent(agentRun.agent_run_id)}/steps?tenant_id=${encodeURIComponent(tenantId)}&page_size=20`,
    );
    assert.ok(steps.agent_steps.some((step) => step.tool_result_refs.length > 0), 'HTTP tool result ref should be recorded');

    const toolCalls = await new ToolCallLogRepository(db).list({
      tenantId,
      taskRunId: task.task_run_id,
      toolName: 'company.policy.lookup',
      limit: 20,
    });
    assert.equal(toolCalls.length, 1, `expected one logical ToolCall, got ${toolCalls.length}`);
    assert.equal(toolCalls[0]?.status, 'committed');
    assert.equal(toolCalls[0]?.adapter_type, 'http_readonly');
    assert.equal((toolCalls[0]?.result_json as { items?: Array<{ id?: string }> } | undefined)?.items?.[0]?.id, 'policy-1');

    const idempotencyKey = toolCalls[0]?.idempotency_key;
    assert.ok(idempotencyKey, 'ToolCall should record idempotency_key');
    const idempotency = await new IdempotencyRecordRepository(db).get(idempotencyKey);
    assert.ok(idempotency, `idempotency record should exist: ${idempotencyKey}`);
    assert.equal(idempotency.status, 'succeeded');

    const stats = await getRawJson<{ request_count: number; last_authorization: string }>(`${mockServerUrl}/business-api/v1/stats`);
    assert.equal(stats.request_count, 1, `external request_count should be 1, got ${stats.request_count}`);
    assert.equal(stats.last_authorization, 'bearer_ok');

    console.log(JSON.stringify({
      ok: true,
      semantic_stage: false,
      http_tool_called: true,
      external_request_count: stats.request_count,
      task_run_id: task.task_run_id,
      workflow_id: task.workflow_id,
      agent_run_id: agentRun.agent_run_id,
    }, null, 2));
  } finally {
    await closeDb(db);
  }
}

async function seedAgentPlan(db: ReturnType<typeof createDb>): Promise<string> {
  const modelPolicyId = `http_readonly_tool_model_${runId}`;
  const promptId = `http_readonly_tool_prompt_${runId}`;
  const agentId = `http_readonly_tool_agent_${runId}`;
  const publishedModelPolicy = await seedModelPolicy(db, modelPolicyId);
  const modelPolicyHash = hashModelPolicy(publishedModelPolicy);
  await new ToolManifestRepository(db).upsert(httpReadonlyToolManifest(), {
    tenantId,
    status: 'published',
    createdBy: 'http-readonly-smoke',
  });
  await upsertPromptDefinition(
    db,
    {
      prompt_id: promptId,
      version: 1,
      name: 'HTTP readonly tool smoke prompt',
      content: '你是 HTTP 只读工具烟测智能体。需要使用公司政策查询工具回答用户问题。',
      variables: [],
      status: 'published',
    },
    { tenantId, status: 'published', createdBy: 'http-readonly-smoke' },
  );
  await upsertAgentSpec(
    db,
    {
      agent_id: agentId,
      version: 1,
      prompt_ref: `${promptId}@1`,
      model_policy: 'deterministic:readonly_tool',
      model_policy_ref: {
        model_policy_id: publishedModelPolicy.model_policy_id,
        model_policy_version: publishedModelPolicy.version,
        model_policy_hash: modelPolicyHash,
      },
      allowed_tools: ['company.policy.lookup@1.0.0'],
      allowed_handoffs: [],
      max_steps: 4,
      max_tokens: 2000,
      output_schema: 'http_readonly_tool_smoke_result_v1',
      status: 'published',
    },
    { tenantId, status: 'published', createdBy: 'http-readonly-smoke' },
  );
  await seedTenantPolicy(db);
  const plan = await new AgentExecutionPlanRepository(db).createForAgent({
    tenantId,
    agentId,
    agentVersion: 1,
    operatorId: 'http-readonly-smoke',
  });
  return plan.execution_plan_ref;
}

function httpReadonlyToolManifest(): ToolManifest {
  return {
    tool_name: 'company.policy.lookup',
    version: '1.0.0',
    description: '通过只读 HTTP API 查询公司政策',
    risk_level: 'L1',
    side_effect: false,
    adapter: {
      type: 'http_readonly',
      base_url: process.env.HTTP_READONLY_TOOL_BASE_URL ?? 'http://mock-server:4100',
      path: '/business-api/v1/policies',
      query_mapping: { keyword: 'query' },
      auth: { type: 'bearer_env', secret_ref: 'env:TOOL_SECRET_BUSINESS_API' },
      timeout_ms: 5000,
      max_response_bytes: 65536,
      retry: { max_attempts: 2, retryable_status_codes: [408, 429, 500, 502, 503, 504], backoff_ms: 100 },
    },
    input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
    output_schema: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } },
    required_permissions: [],
    evaluation_policy: {
      allowed_in_evaluation: true,
      mode: 'preview_only',
      allowed_tenants: [tenantId],
      result_redaction_policy: 'mask_sensitive',
      maximum_calls_per_case: 1,
    },
    status: 'published',
  };
}

async function seedModelPolicy(db: ReturnType<typeof createDb>, modelPolicyId: string) {
  const repository = new ModelPolicyRepository(db);
  const catalog = await ensureModelCatalogEntry(db, {
    profileId: 'local-deterministic',
    displayName: 'Local deterministic HTTP readonly smoke model',
    baseUrl: 'http://mock-server:4100',
    authType: 'none',
    modelId: 'deterministic:readonly_tool',
    upstreamModelId: 'deterministic:readonly_tool',
    provider: 'local-mock',
    capabilities: ['text', 'tools', 'usage'],
    operatorId: 'http-readonly-smoke',
  });
  await repository.createDraft(
    {
      model_policy_id: modelPolicyId,
      version: 1,
      status: 'draft',
      protocol: 'openai_chat_completions',
      targets: [{ target_id: `${modelPolicyId}_primary`, model_ref: catalog.model_ref, priority: 0, enabled: true }],
      retry_policy: {
        max_attempts_per_target: 2,
        retryable_status_codes: [429, 500, 502, 503, 504],
        retry_on_timeout: true,
        retry_on_network_error: true,
        backoff_ms: 10,
        max_backoff_ms: 50,
      },
      fallback_policy: { enabled: false, ordered_target_ids: [], eligible_error_classes: [], stop_on_auth_error: true, stop_on_validation_error: true, stop_on_policy_denial: true },
      request_policy: { temperature: 0, top_p: 1, max_output_tokens: 1000, initial_tool_choice_mode: 'auto', after_tool_result_tool_choice_mode: 'auto', response_format: 'text', allow_parallel_tool_calls: false },
      revision: 1,
    },
    { tenantId, operatorId: 'http-readonly-smoke' },
  );
  return repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId: 'http-readonly-smoke',
    releaseNote: 'HTTP readonly tool smoke model policy',
  });
}

async function seedTenantPolicy(db: ReturnType<typeof createDb>): Promise<void> {
  const repository = new TenantRuntimePolicyRepository(db);
  const policy = tenantRuntimePolicySchema.parse({
    tenant_id: tenantId,
    version: 1,
    status: 'draft',
    allowed_tools: [{
      tool_name: 'company.policy.lookup',
      versions: ['1.0.0'],
      allowed_operations: ['invoke'],
      max_risk_level: 'L1',
    }],
    denied_tools: [],
    allowed_models: [{ model_id: 'deterministic:readonly_tool' }],
    denied_models: [],
    allowed_handoffs: [],
    denied_handoffs: [],
    budget_cap: {
      max_segments: 4,
      max_model_turns: 4,
      max_tool_calls: 1,
      max_total_tokens: 4000,
      max_duration_ms: 300000,
      max_handoffs: 0,
      max_context_bytes: 262144,
    },
    max_concurrent_agent_runs: 2,
  });
  await repository.createDraft(policy, { tenantId, operatorId: 'http-readonly-smoke' });
  await repository.publish(tenantId, policy.version, {
    tenantId,
    operatorId: 'http-readonly-smoke',
    releaseNote: 'HTTP readonly tool smoke tenant policy',
  });
}

async function pollTask(taskRunId: string): Promise<TaskRun> {
  const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);
  let lastTask: TaskRun | undefined;
  while (Date.now() < deadline) {
    lastTask = await getJson<TaskRun>(`${runtimeApiUrl}/v1/tasks/${encodeURIComponent(taskRunId)}`);
    if (lastTask.status === 'completed' || lastTask.status === 'failed') {
      return lastTask;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${taskRunId}; last status=${lastTask?.status ?? 'unknown'}`);
}

async function resetMockBusinessApi(): Promise<void> {
  await fetch(`${mockServerUrl}/business-api/v1/reset`, { method: 'POST' });
}

async function checkHealth(url: string, appName: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${appName} healthz failed: ${response.status} ${await response.text()}`);
}

async function postJson<T = unknown>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...runtimeHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`POST ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: runtimeHeaders });
  const body = (await response.json()) as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function getRawJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

main().catch((error: unknown) => {
  console.error('smoke:http-readonly-tool-e2e failed');
  console.error(error);
  process.exit(1);
});
