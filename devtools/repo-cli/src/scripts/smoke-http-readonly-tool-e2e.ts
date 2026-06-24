import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  AgentRunRecord,
  AgentStepRecord,
  AuditEvent,
  FlowSpec,
  ModelDefinition,
  ModelPolicy,
  RouterPreviewResponse,
  RunTaskResponse,
  StandardResponse,
  TaskRun,
  TenantRuntimePolicySnapshot,
  ToolManifest,
} from '@dar/contracts';
import { tenantRuntimePolicySchema } from '@dar/contracts';
import {
  AuditEventRepository,
  FlowExecutionPlanRepository,
  HumanTaskRepository,
  IdempotencyRecordRepository,
  RouteEmbeddingRepository,
  TaskRunRepository,
  TenantRuntimePolicySnapshotRepository,
  ToolCallLogRepository,
  closeDb,
  createDb,
  hashModelPolicy,
} from '@dar/db';
import { ensureModelCatalogEntry } from './model-catalog-seed.js';

const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
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
const operatorHeaders = authHeaders('capability_operator', `${requestId}_operator`);
const adminHeaders = authHeaders('platform_admin', `${requestId}_admin`);
const routeQueryText = '我想了解公司差旅费用怎么申请报销';
const routeChannel = 'web';
const routeRoles = ['employee'];
const modelDefinitionId = 'model_gateway:http_readonly_tool';

async function main() {
  const db = createDb({ databaseUrl });
  try {
    assertSemanticEnvironment();
    await resetMockBusinessApi();
    const resources = await publishSmokeResources(db);
    const coverage = await new RouteEmbeddingRepository(db).listCoverage({
      tenantId,
      routeIds: [resources.routeId],
      embeddingModelId: process.env.ROUTER_EMBEDDING_MODEL_ID ?? 'mock-embedding-1536',
      embeddingModelVersion: Number(process.env.ROUTER_EMBEDDING_MODEL_VERSION ?? 1),
    });
    assert.equal(coverage.length, 1, `expected published semantic embedding coverage, got ${JSON.stringify(coverage)}`);
    assert.ok((coverage[0]?.source_count ?? 0) >= 3, 'route embedding index should include keyword and examples');

    await checkHealth(`${controlPlaneUrl}/healthz`, 'control-plane');
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');

    const preview = await postRuntimeJson<RouterPreviewResponse>(
      `${runtimeApiUrl}/v1/router/preview`,
      {
        tenant_id: tenantId,
        user_id: userId,
        channel: routeChannel,
        roles: routeRoles,
        request_id: `${requestId}_preview`,
        input: { text: routeQueryText },
      },
    );
    assert.equal(preview.decision_stage, 'semantic');
    assert.equal(preview.route_decision.decision, 'matched');
    assert.equal(preview.route_decision.flow_id, resources.flowId);
    assert.equal(preview.route_decision.flow_version, 1);
    assert.equal(preview.candidates[0]?.route_id, resources.routeId);
    assert.equal(preview.candidates[0]?.reason, 'semantic_match');
    assert.ok((preview.semantic?.top_score ?? 0) >= Number(process.env.ROUTER_SEMANTIC_MATCH_THRESHOLD ?? 0.8));
    assert.ok((preview.semantic?.margin ?? 0) >= Number(process.env.ROUTER_SEMANTIC_MIN_MARGIN ?? 0.05));

    const task = await postRuntimeJson<RunTaskResponse>(
      `${runtimeApiUrl}/v1/tasks`,
      {
        tenant_id: tenantId,
        user_id: userId,
        channel: routeChannel,
        roles: routeRoles,
        request_id: `${requestId}_task`,
        input: { text: routeQueryText },
      },
    );
    assert.equal(task.status, 'queued');
    assert.equal(task.route_decision.decision, 'matched');
    assert.equal(task.route_decision.flow_id, resources.flowId);
    assert.equal(task.route_decision.flow_version, 1);
    assert.equal(task.flow_id, resources.flowId);
    assert.equal(task.flow_version, 1);
    assert.ok(task.tenant_policy_snapshot_ref, 'runtime task should carry tenant policy snapshot ref');
    assert.equal(task.workflow_start?.started, true);
    assert.equal(task.workflow_start?.mode, 'temporal');

    const finalTask = await pollTask(task.task_run_id);
    assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'HTTP readonly tool task should complete');
    assert.equal(finalTask.route_type, 'matched');
    assert.equal(finalTask.flow_id, resources.flowId);
    assert.equal(finalTask.flow_version, 1);
    assert.ok(finalTask.execution_plan_ref, 'TaskRun should record FlowExecutionPlan ref');
    assert.ok(finalTask.tenant_policy_snapshot_ref, 'TaskRun should record tenant policy snapshot ref');

    const storedTask = await new TaskRunRepository(db).get(task.task_run_id);
    assert.equal(storedTask?.execution_plan_ref, finalTask.execution_plan_ref);
    assert.equal(storedTask?.tenant_policy_snapshot_ref, finalTask.tenant_policy_snapshot_ref);
    const flowPlan = await new FlowExecutionPlanRepository(db).getByRef(finalTask.execution_plan_ref, { tenantId });
    assert.ok(flowPlan, 'FlowExecutionPlan should exist');
    assert.equal(flowPlan.flow_id, resources.flowId);
    assert.equal(flowPlan.flow_version, 1);
    assert.equal(flowPlan.execution_plan_hash.length, 64);
    assert.equal(flowPlan.agents.length, 1);
    assert.ok(flowPlan.agents[0]?.agent_execution_plan_ref, 'FlowExecutionPlan should lock AgentExecutionPlan ref');

    const agentRuns = await getJson<{ agent_runs: AgentRunRecord[] }>(
      `${runtimeApiUrl}/v1/agent-runs?tenant_id=${encodeURIComponent(tenantId)}&task_run_id=${encodeURIComponent(task.task_run_id)}&page_size=10`,
    );
    const agentRun = agentRuns.agent_runs[0];
    assert.ok(agentRun, 'AgentRun should exist');
    assert.equal(agentRun.status, 'completed');
    assert.equal(agentRun.parent_workflow_id, task.workflow_id);
    assert.equal(agentRun.execution_plan_ref, flowPlan.agents[0]?.agent_execution_plan_ref);
    assert.equal(agentRun.tool_call_count, 1);

    const steps = await getJson<{ agent_steps: AgentStepRecord[] }>(
      `${runtimeApiUrl}/v1/agent-runs/${encodeURIComponent(agentRun.agent_run_id)}/steps?tenant_id=${encodeURIComponent(tenantId)}&page_size=20`,
    );
    assert.ok(steps.agent_steps.some((step) => step.proposed_tool_calls.length > 0), 'Pi tool proposal should be recorded');
    assert.ok(steps.agent_steps.some((step) => step.tool_result_refs.length > 0), 'HTTP tool result should be written back to Pi context');
    const finalAnswer = steps.agent_steps.find((step) => step.segment_status === 'completed' && step.decision_summary)?.decision_summary;
    assert.ok(finalAnswer, 'Pi final answer step should exist');
    assert.match(finalAnswer, /差旅报销政策摘要|差旅费用可按制度提交报销/u);

    const toolCalls = await new ToolCallLogRepository(db).list({
      tenantId,
      taskRunId: task.task_run_id,
      toolName: 'company.policy.lookup',
      limit: 20,
    });
    assert.equal(toolCalls.length, 1, `expected one logical ToolCall, got ${toolCalls.length}`);
    assert.equal(toolCalls[0]?.status, 'committed');
    assert.equal(toolCalls[0]?.adapter_type, 'http_readonly');
    assert.equal(toolCalls[0]?.policy_decision, 'allow');
    assert.equal(toolCalls[0]?.risk_level, 'L1');
    assert.equal(toolCalls[0]?.tenant_policy_snapshot_ref, agentRun.tenant_policy_snapshot_ref);
    assert.equal((toolCalls[0]?.result_json as { items?: Array<{ id?: string }> } | undefined)?.items?.[0]?.id, 'policy-1');

    const toolCall = toolCalls[0];
    assert.ok(toolCall, 'ToolCall should exist');
    const idempotencyKey = toolCall.idempotency_key;
    assert.ok(idempotencyKey, 'ToolCall should record idempotency_key');
    const idempotencyRecordKey = `${tenantId}:${toolCall.tool_name}:invoke:${idempotencyKey}`;
    const idempotency = await new IdempotencyRecordRepository(db).get(idempotencyRecordKey);
    assert.ok(idempotency, `idempotency record should exist: ${idempotencyRecordKey}`);
    assert.equal(idempotency.status, 'succeeded');
    assert.equal((idempotency.response_json as { idempotency_key?: string } | undefined)?.idempotency_key, idempotencyKey);

    const stats = await getRawJson<{ request_count: number; last_authorization: string }>(`${mockServerUrl}/business-api/v1/stats`);
    assert.equal(stats.request_count, 1, `external request_count should be 1, got ${stats.request_count}`);
    assert.equal(stats.last_authorization, 'bearer_ok');

    const policySnapshots = await new TenantRuntimePolicySnapshotRepository(db).listByTenant(tenantId, { limit: 20 });
    assert.ok(policySnapshots.some((snapshot) => snapshot.execution_plan_ref === flowPlan.execution_plan_ref && snapshot.execution_plan_type === 'flow'), 'root flow tenant policy snapshot should exist');
    assert.ok(policySnapshots.some((snapshot) => snapshot.execution_plan_ref === agentRun.execution_plan_ref && snapshot.execution_plan_type === 'agent' && snapshot.derivation_type === 'flow_agent_child'), 'agent child tenant policy snapshot should exist');
    assert.ok(policySnapshots.every((snapshot) =>
      snapshot.resolved_allowed_tools.some((rule) => rule.tool_name === 'company.policy.lookup' && rule.allowed_operations.includes('invoke'))),
    'tenant policy snapshot should allow the HTTP tool');

    const taskAudits = await new AuditEventRepository(db).list({ tenantId, taskRunId: task.task_run_id, limit: 50 });
    const planAudits = await new AuditEventRepository(db).list({ tenantId, limit: 50 });
    assert.ok(planAudits.some((event) =>
      event.action === 'policy.resolve.allowed'
      && event.target_type === 'tenant_runtime_policy'
      && auditPayloadString(event, 'execution_plan_ref') === flowPlan.execution_plan_ref),
    'tenant policy resolve audit should exist for the FlowExecutionPlan');
    assert.ok(planAudits.some((event) =>
      event.action === 'policy.snapshot.derived'
      && auditPayloadString(event, 'execution_plan_ref') === agentRun.execution_plan_ref),
    'agent child tenant policy snapshot audit should exist');
    assert.ok(taskAudits.some((event) => event.action === 'tool.invoke' && event.target_id === 'company.policy.lookup'), 'tool invoke audit should exist');

    const humanTasks = await new HumanTaskRepository(db).list({ tenantId, taskRunId: task.task_run_id, limit: 20 });
    assert.equal(humanTasks.length, 0, 'L1 HTTP readonly tool should not create HumanTask');
    assertNoSecrets({ toolCalls, taskAudits, planAudits, policySnapshots });

    console.log(JSON.stringify({
      ok: true,
      semantic_stage: true,
      flow_started: true,
      agent_child_started: true,
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

async function publishSmokeResources(db: ReturnType<typeof createDb>): Promise<{
  promptId: string;
  modelPolicyId: string;
  agentId: string;
  flowId: string;
  routeId: string;
}> {
  const modelPolicyId = `http_readonly_tool_model_${runId}`;
  const promptId = `http_readonly_tool_prompt_${runId}`;
  const agentId = `http_readonly_tool_agent_${runId}`;
  const flowId = `http_readonly_tool_flow_${runId}`;
  const routeId = `http_readonly_tool_route_${runId}`;

  const publishedModelPolicy = await createAndPublishModelPolicy(modelPolicyId);
  const modelPolicyHash = hashModelPolicy(publishedModelPolicy);
  await createAndPublishRegistry('prompts', promptId, 1, {
    prompt_id: promptId,
    version: 1,
    name: 'HTTP readonly tool smoke prompt',
    content: 'http_readonly_tool。你是 HTTP 只读工具烟测智能体。必须调用 company.policy.lookup 工具查询政策。收到工具结果后，用中文总结差旅费用报销政策。',
    variables: [],
    status: 'draft',
  });
  await createAndPublishRegistry('tools', 'company.policy.lookup', 1, httpReadonlyToolManifest());
  await createAndPublishRegistry('agents', agentId, 1, {
    agent_id: agentId,
    version: 1,
    prompt_ref: `${promptId}@1`,
    model_policy: modelDefinitionId,
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
    status: 'draft',
  });
  await createRegistryDraft('flows', flowId, flowSpec(flowId, agentId));
  await createRegistryDraft('routes', routeId, routeSpec(routeId, flowId));
  await postControlPlaneJson(
    `${controlPlaneUrl}/api/v1/releases/flow-route`,
    {
      flow_id: flowId,
      flow_version: 1,
      route_id: routeId,
      route_version: 1,
      release_note: 'publish HTTP readonly tool semantic route smoke',
      metadata_json: { smoke: 'http-readonly-tool-e2e' },
    },
    adminHeaders,
  );
  await createAndPublishTenantPolicy();

  const plan = await new FlowExecutionPlanRepository(db).getLatestForFlow(flowId, 1, { tenantId });
  assert.ok(plan, 'Flow publish should create FlowExecutionPlan');
  assert.ok(plan.agents[0]?.agent_execution_plan_ref, 'FlowExecutionPlan should contain AgentExecutionPlan ref');
  return { promptId, modelPolicyId, agentId, flowId, routeId };
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

async function createAndPublishModelPolicy(modelPolicyId: string): Promise<ModelPolicy> {
  const db = createDb({ databaseUrl });
  let model: ModelDefinition;
  try {
    model = await ensureHttpReadonlyModelDefinition(db);
  } finally {
    await closeDb(db);
  }
  assert.equal(model.status, 'published', `${modelDefinitionId} model definition should be seeded and published`);
  const policy = {
    model_policy_id: modelPolicyId,
    version: 1,
    status: 'draft',
    protocol: 'openai_chat_completions',
    targets: [{
      target_id: `${modelPolicyId}_primary`,
      model_ref: {
        model_id: model.model_id,
        version: model.version,
        model_hash: model.model_hash,
      },
      priority: 0,
      enabled: true,
    }],
    retry_policy: {
      max_attempts_per_target: 2,
      retryable_status_codes: [429, 500, 502, 503, 504],
      retry_on_timeout: true,
      retry_on_network_error: true,
      backoff_ms: 10,
      max_backoff_ms: 50,
    },
    fallback_policy: {
      enabled: false,
      ordered_target_ids: [],
      eligible_error_classes: [],
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
  await createRegistryDraft('model-policies', modelPolicyId, policy);
  await publishRegistry('model-policies', modelPolicyId, 1, adminHeaders);
  return getRegistryVersion<ModelPolicy>('model-policies', modelPolicyId, 1);
}

async function ensureHttpReadonlyModelDefinition(db: ReturnType<typeof createDb>): Promise<ModelDefinition> {
  const seeded = await ensureModelCatalogEntry(db, {
    profileId: 'local-mock-http-readonly',
    displayName: 'Local mock HTTP readonly tool model gateway',
    baseUrl: process.env.SEED_HTTP_READONLY_MODEL_GATEWAY_BASE_URL ?? 'http://mock-server:4100',
    authType: 'none',
    modelId: modelDefinitionId,
    upstreamModelId: 'http_readonly_tool',
    provider: 'local-mock',
    capabilities: ['text', 'tools', 'usage', 'tool_choice'],
    contextWindow: 32768,
    maxOutputTokens: 4096,
    tags: ['smoke', 'http-readonly-tool'],
    operatorId: 'smoke-http-readonly-tool',
  });
  return seeded.model;
}

async function createAndPublishTenantPolicy(): Promise<void> {
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
    allowed_models: [{ model_id: modelDefinitionId }],
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
  await createRegistryDraft('tenant-runtime-policies', tenantId, policy);
  await publishRegistry('tenant-runtime-policies', tenantId, 1, adminHeaders);
  const published = await getRegistryVersion<ReturnType<typeof tenantRuntimePolicySchema.parse>>('tenant-runtime-policies', tenantId, 1);
  assert.equal(published.status, 'published');
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

async function createAndPublishRegistry(
  plural: string,
  resourceId: string,
  version: number,
  spec: unknown,
): Promise<void> {
  await createRegistryDraft(plural, resourceId, spec);
  await publishRegistry(plural, resourceId, version, adminHeaders);
}

async function createRegistryDraft(plural: string, _resourceId: string, spec: unknown): Promise<void> {
  await postControlPlaneJson(`${controlPlaneUrl}/api/v1/${plural}`, { spec }, operatorHeaders);
}

async function publishRegistry(
  plural: string,
  resourceId: string,
  version: number,
  headers: Record<string, string>,
): Promise<void> {
  await postControlPlaneJson(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/publish`,
    { release_note: `publish ${resourceId}@${version}` },
    headers,
  );
}

async function getRegistryVersion<T>(plural: string, resourceId: string, version: number): Promise<T> {
  const record = await getControlPlaneJson<{ spec: T }>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}`,
    operatorHeaders,
  );
  return record.spec;
}

function flowSpec(flowId: string, agentId: string): FlowSpec {
  return {
    flow_id: flowId,
    version: 1,
    name: 'HTTP readonly semantic route flow',
    status: 'draft',
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    steps: [{
      id: 'policy_agent',
      type: 'agent',
      agent_id: agentId,
      input: {
        agent_version: 1,
        text: '${input.text}',
      },
    }],
  };
}

function routeSpec(routeId: string, flowId: string) {
  return {
    route_id: routeId,
    flow_id: flowId,
    version: 1,
    status: 'draft',
    route: {
      priority: 80,
      keywords: ['差旅制度'],
      examples: ['查询公司费用报销政策', '了解出差费用规则'],
      negative_examples: ['不要查询报销政策'],
      supported_channels: [routeChannel],
      role_constraints: [],
      confidence_threshold: 0.7,
      ambiguous_threshold: 0.5,
    },
  };
}

function assertSemanticEnvironment(): void {
  if ((process.env.ROUTER_SEMANTIC_ENABLED ?? '').toLowerCase() === 'false') {
    throw new Error('HTTP readonly smoke requires semantic router enabled; use ROUTER_SEMANTIC_ENABLED=true');
  }
}

async function postRuntimeJson<T = unknown>(url: string, payload: unknown): Promise<T> {
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

async function postControlPlaneJson<T = unknown>(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`POST ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function getControlPlaneJson<T = unknown>(
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, { headers });
  const body = (await response.json()) as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
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

function authHeaders(role: string, traceRequestId: string): Record<string, string> {
  return {
    'x-user-id': userId,
    'x-tenant-id': tenantId,
    'x-roles': role,
    'x-request-id': traceRequestId,
    'accept-language': 'zh-CN',
  };
}

function auditPayloadString(event: AuditEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === 'string' ? value : undefined;
}

function assertNoSecrets(input: {
  toolCalls: unknown[];
  taskAudits: AuditEvent[];
  planAudits: AuditEvent[];
  policySnapshots: TenantRuntimePolicySnapshot[];
}): void {
  const serialized = JSON.stringify(input);
  assert.equal(serialized.includes('business-read-secret'), false, 'secret value must not appear in DB evidence');
  assert.equal(/Bearer\s+business-read-secret/u.test(serialized), false, 'Authorization secret must not appear in DB evidence');
}

main().catch((error: unknown) => {
  console.error('smoke:http-readonly-tool-e2e failed');
  console.error(error);
  process.exit(1);
});
