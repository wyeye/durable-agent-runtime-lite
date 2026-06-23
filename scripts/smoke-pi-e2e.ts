import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  AgentRunRecord,
  AgentStepRecord,
  HumanTask,
  StandardResponse,
  TaskRun,
} from '@dar/contracts';
import { tenantRuntimePolicySchema } from '@dar/contracts';
import {
  AgentExecutionPlanRepository,
  FlowExecutionPlanRepository,
  FlowDefinitionRepository,
  ModelPolicyRepository,
  TenantRuntimePolicyRepository,
  ToolManifestRepository,
  buildExecutionPlanRef,
  closeDb,
  createDb,
  hashJson,
  hashModelPolicy,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import { ensureModelCatalogEntry, localMockModelCatalogEntryInput, type EnsureModelCatalogEntryInput } from './model-catalog-seed.js';

const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const scenario = process.env.PI_SMOKE_SCENARIO ?? 'readonly_tool';
const mode =
  process.env.PI_SMOKE_MODE ?? (scenario === 'model_gateway' ? 'model_gateway' : 'deterministic');
const runId = Date.now();
const tenantId =
  process.env.SMOKE_TENANT_ID ??
  (mode === 'model_gateway' ? `pi_smoke_${scenario}_${runId}` : 'default');
const userId = process.env.SMOKE_USER_ID ?? 'pi_smoke_user';
const modelGatewayModel = process.env.MODEL_GATEWAY_MODEL ?? 'dar-local-model';
const modelGatewayProvider = process.env.MODEL_GATEWAY_PROVIDER ?? 'local-mock';
const modelGatewayBaseUrl = process.env.MODEL_GATEWAY_BASE_URL ?? 'http://mock-server:4100';
const requestId = `pi_smoke_${scenario}_${Date.now()}`;
const runtimeHeaders = authHeaders(`${requestId}_runtime`);

async function main() {
  const db = createDb({ databaseUrl });
  try {
    const agentExecutionPlanRef = await seedAgentPlan(db);
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');

    const task = await postJson<{
      task_run_id: string;
      workflow_id: string;
      workflow_start?: { mode: string; started: boolean };
    }>(`${runtimeApiUrl}/v1/agent-tasks`, {
      tenant_id: tenantId,
      user_id: userId,
      request_id: `${requestId}_task`,
      agent_execution_plan_ref: agentExecutionPlanRef,
      input: { text: inputTextForScenario(scenario, mode) },
    });
    assert.equal(task.workflow_start?.started, true);
    assert.equal(task.workflow_start?.mode, 'temporal');

    const finalTask = await pollTask(task.task_run_id);
    assert.equal(
      finalTask.status,
      'completed',
      finalTask.error_message ?? 'Pi task should complete',
    );
    const agentRuns = await getJson<{ agent_runs: AgentRunRecord[] }>(
      `${runtimeApiUrl}/v1/agent-runs?tenant_id=${encodeURIComponent(tenantId)}&task_run_id=${encodeURIComponent(task.task_run_id)}&page_size=10`,
    );
    assert.ok(agentRuns.agent_runs.length > 0, 'AgentRun should be queryable');
    const agentRun = agentRuns.agent_runs[0]!;
    assert.equal(agentRun.status, 'completed');
    assert.ok(agentRun.model_turn_count > 0, 'AgentRun should record cumulative model_turn_count');
    assert.ok(agentRun.total_tokens >= 0, 'AgentRun should record cumulative usage');

    const steps = await getJson<{ agent_steps: AgentStepRecord[] }>(
      `${runtimeApiUrl}/v1/agent-runs/${encodeURIComponent(agentRun.agent_run_id)}/steps?tenant_id=${encodeURIComponent(tenantId)}&page_size=20`,
    );
    assert.ok(steps.agent_steps.length >= 1, 'AgentStep records should exist');
    if (expectsToolResult(scenario)) {
      assert.ok(
        steps.agent_steps.some((step) => step.tool_result_refs.length > 0),
        'Tool smoke should record authoritative tool_result_refs',
      );
    }
    if (scenario === 'handoff') {
      assert.ok(
        steps.agent_steps.some((step) => step.handoff_refs.length > 0),
        'Handoff smoke should record child workflow reference',
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          scenario,
          mode,
          task_run_id: task.task_run_id,
          workflow_id: task.workflow_id,
          agent_run_id: agentRun.agent_run_id,
          agent_status: agentRun.status,
          step_count: steps.agent_steps.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeDb(db);
  }
}

async function seedAgentPlan(db: ReturnType<typeof createDb>): Promise<string> {
  const promptId = `pi_smoke_prompt_${scenario}_${mode}`;
  const agentId = `pi_smoke_agent_${scenario}_${mode}`;
  const modelPolicy =
    mode === 'model_gateway'
      ? `model_gateway:${scenario}`
      : `deterministic:${deterministicScenario(scenario)}`;
  const modelPolicyId =
    mode === 'model_gateway'
      ? `pi_smoke_model_${scenario}_${mode}_${safeId(modelGatewayProvider)}_${hashJson(modelGatewayModel).slice(0, 8)}`
      : `pi_smoke_model_${scenario}_${mode}`;
  const publishedModelPolicy = await seedModelPolicy(db, modelPolicyId, modelPolicy);
  const modelPolicyHash = hashModelPolicy(publishedModelPolicy);
  await seedTools(db);
  if (scenario === 'handoff') {
    await seedHandoffTarget(db);
  }
  await upsertPromptDefinition(
    db,
    {
      prompt_id: promptId,
      version: 1,
      name: `Pi smoke prompt ${scenario}`,
      content: systemPromptForScenario(scenario, mode),
      variables: [],
      status: 'published',
    },
    { tenantId, status: 'published', createdBy: 'pi-smoke' },
  );
  await upsertAgentSpec(
    db,
    {
      agent_id: agentId,
      version: 1,
      prompt_ref: `${promptId}@1`,
      model_policy: modelPolicy,
      model_policy_ref: {
        model_policy_id: publishedModelPolicy.model_policy_id,
        model_policy_version: publishedModelPolicy.version,
        model_policy_hash: modelPolicyHash,
      },
      allowed_tools: ['knowledge.search@1.0.0', 'record.write.mock@1.0.0'],
      allowed_handoffs: scenario === 'handoff' ? ['db://flow-execution-plan/plan_handoff'] : [],
      max_steps: scenario === 'restart_resume' ? 6 : 4,
      max_tokens: 2000,
      output_schema: 'pi_smoke_result_v1',
      status: 'published',
    },
    { tenantId, status: 'published', createdBy: 'pi-smoke' },
  );
  const plan = await new AgentExecutionPlanRepository(db).createForAgent({
    tenantId,
    agentId,
    agentVersion: 1,
    operatorId: 'pi-smoke',
  });
  if (mode === 'model_gateway') {
    await seedTenantPolicy(db, modelPolicy, modelGatewayModel);
  }
  return plan.execution_plan_ref;
}

async function seedTenantPolicy(
  db: ReturnType<typeof createDb>,
  modelPolicy: string,
  modelId: string,
): Promise<void> {
  const repository = new TenantRuntimePolicyRepository(db);
  const existing = await repository.getLatestPublished(tenantId);
  if (existing) {
    return;
  }
  const policy = tenantRuntimePolicySchema.parse({
    tenant_id: tenantId,
    version: 1,
    status: 'draft',
    allowed_tools: [
      {
        tool_name: 'knowledge.search',
        versions: ['1.0.0'],
        allowed_operations: ['invoke'],
        max_risk_level: 'L1',
      },
      {
        tool_name: 'record.write.mock',
        versions: ['1.0.0'],
        allowed_operations: ['invoke', 'preview', 'commit'],
        max_risk_level: 'L3',
      },
    ],
    denied_tools: [],
    allowed_models: [{ model_id: modelPolicy }, { model_id: modelId }],
    denied_models: [],
    allowed_handoffs: [],
    denied_handoffs: [],
    budget_cap: {
      max_segments: 4,
      max_model_turns: 4,
      max_tool_calls: 2,
      max_total_tokens: 4000,
      max_duration_ms: 300000,
      max_handoffs: 0,
      max_context_bytes: 262144,
    },
    max_concurrent_agent_runs: 2,
  });
  await repository.createDraft(policy, { tenantId, operatorId: 'pi-smoke' });
  await repository.publish(tenantId, policy.version, {
    tenantId,
    operatorId: 'pi-smoke',
    releaseNote: 'pi model-gateway smoke policy',
  });
}

async function seedModelPolicy(
  db: ReturnType<typeof createDb>,
  modelPolicyId: string,
  displayPolicy: string,
) {
  const repository = new ModelPolicyRepository(db);
  const catalogInput: EnsureModelCatalogEntryInput = mode === 'model_gateway' && modelGatewayProvider === 'local-mock' && modelGatewayModel === 'dar-local-model'
    ? localMockModelCatalogEntryInput('pi-smoke')
    : {
        profileId: mode === 'model_gateway' ? modelGatewayProvider : 'local-deterministic',
        displayName: mode === 'model_gateway'
          ? `${modelGatewayProvider} ${modelGatewayModel}`
          : 'Local deterministic development model gateway',
        baseUrl: mode === 'model_gateway'
          ? modelGatewayBaseUrl
          : process.env.SEED_DETERMINISTIC_MODEL_GATEWAY_BASE_URL ?? 'http://mock-server:4100',
        authType: 'none' as const,
        modelId: mode === 'model_gateway' ? modelGatewayModel : displayPolicy,
        upstreamModelId: mode === 'model_gateway' ? modelGatewayModel : displayPolicy,
        provider: mode === 'model_gateway' ? modelGatewayProvider : 'local-mock',
        capabilities: ['text', 'tools', 'usage'],
        operatorId: 'pi-smoke',
      };
  const catalog = await ensureModelCatalogEntry(db, catalogInput);
  const existing = await repository.getByIdAndVersion(modelPolicyId, 1, { tenantId });
  if (existing?.status === 'published' || existing?.status === 'gray') {
    return existing;
  }
  if (existing) {
    throw new Error(
      `ModelPolicy ${modelPolicyId}@1 already exists with non-executable status ${existing.status}`,
    );
  }
  await repository.createDraft(
    {
      model_policy_id: modelPolicyId,
      version: 1,
      status: 'draft',
      protocol: 'openai_chat_completions',
      targets: [
        {
          target_id: `${modelPolicyId}_primary`,
          model_ref: catalog.model_ref,
          priority: 0,
          enabled: true,
        },
      ],
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
        eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'],
        stop_on_auth_error: true,
        stop_on_validation_error: true,
        stop_on_policy_denial: true,
      },
      request_policy: {
        temperature: 0,
        top_p: 1,
        max_output_tokens: 1000,
        initial_tool_choice_mode: initialToolChoiceForScenario(scenario, mode),
        after_tool_result_tool_choice_mode: afterToolResultToolChoiceForScenario(mode),
        response_format: 'text',
        allow_parallel_tool_calls: false,
      },
      revision: 1,
    },
    { tenantId, operatorId: 'pi-smoke' },
  );
  return repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId: 'pi-smoke',
    releaseNote: `pi smoke ${displayPolicy}`,
  });
}

async function seedTools(db: ReturnType<typeof createDb>) {
  const knowledge = JSON.parse(
    await readFile(
      new URL('../examples/tools/knowledge-search-tool.json', import.meta.url),
      'utf8',
    ),
  );
  const recordWrite = JSON.parse(
    await readFile(
      new URL('../examples/tools/record-write-mock-tool.json', import.meta.url),
      'utf8',
    ),
  );
  await new ToolManifestRepository(db).upsert(knowledge, {
    tenantId,
    status: 'published',
    createdBy: 'pi-smoke',
  });
  await new ToolManifestRepository(db).upsert(recordWrite, {
    tenantId,
    status: 'published',
    createdBy: 'pi-smoke',
  });
}

async function seedHandoffTarget(db: ReturnType<typeof createDb>) {
  const flow = {
    flow_id: 'pi_handoff_target',
    version: 1,
    name: 'Pi handoff target',
    runtime: { workflow_type: 'ConfigDrivenWorkflow' as const, task_queue: 'runtime-worker-main' },
    steps: [{ id: 'normalize', type: 'activity' as const, activity: 'input.normalize' }],
    status: 'published' as const,
  };
  await new FlowDefinitionRepository(db).upsert(flow, {
    tenantId,
    status: 'published',
    createdBy: 'pi-smoke',
  });
  const planWithoutHash = {
    execution_plan_id: 'plan_handoff',
    execution_plan_ref: buildExecutionPlanRef('plan_handoff'),
    tenant_id: tenantId,
    flow_id: flow.flow_id,
    flow_version: flow.version,
    flow_sha256: hashJson(flow),
    flow_spec: flow,
    agents: [],
    tools: [],
    allowed_tools: [],
    budget: { max_steps: 1, max_tokens: 100 },
    generated_at: '2026-01-01T00:00:00.000Z',
  };
  const plan = { ...planWithoutHash, execution_plan_hash: hashJson(planWithoutHash) };
  await db
    .insertInto('flow_execution_plan')
    .values({
      execution_plan_id: plan.execution_plan_id,
      execution_plan_ref: plan.execution_plan_ref,
      tenant_id: plan.tenant_id,
      flow_id: plan.flow_id,
      flow_version: plan.flow_version,
      flow_sha256: plan.flow_sha256,
      plan_json: JSON.stringify(plan),
      execution_plan_hash: plan.execution_plan_hash,
      generated_at: plan.generated_at,
    })
    .onConflict((oc) => oc.column('execution_plan_ref').doNothing())
    .execute();
  void FlowExecutionPlanRepository;
}

function deterministicScenario(value: string): string {
  if (value === 'user_input') {
    return 'need_user';
  }
  if (value === 'restart_resume') {
    return 'readonly_tool';
  }
  return value;
}

function expectsToolResult(value: string): boolean {
  return ['readonly_tool', 'l3_tool', 'model_gateway'].includes(value);
}

function safeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 40) || 'provider'
  );
}

function systemPromptForScenario(value: string, selectedMode: string): string {
  if (selectedMode !== 'model_gateway') {
    return `You are a Pi smoke agent. Scenario: ${value}.`;
  }
  if (value === 'model_gateway_final') {
    return 'You are a Pi smoke agent. Reply directly and do not call tools.';
  }
  if (value === 'readonly_tool') {
    return 'You are a tool-calling assistant. When tool_choice is required, return exactly one structured tool call and no text.';
  }
  if (value === 'l3_tool') {
    return 'You are a tool-calling assistant. When tool_choice is required, return exactly one structured tool call and no text.';
  }
  return `You are a Pi smoke agent. Scenario: ${value}.`;
}

function inputTextForScenario(value: string, selectedMode: string): string {
  if (selectedMode !== 'model_gateway') {
    return `${value} smoke request`;
  }
  if (value === 'model_gateway_final') {
    return 'Reply with the exact text: durable-agent-runtime-lite-ollama-runtime-final-ok';
  }
  if (value === 'readonly_tool') {
    return 'Call the provided search tool exactly once. Query: durable agent runtime ollama readonly smoke.';
  }
  if (value === 'l3_tool') {
    return 'Call the provided record write tool exactly once. Use record.summary: durable agent runtime ollama l3 smoke.';
  }
  return `${value} smoke request`;
}

function initialToolChoiceForScenario(
  value: string,
  selectedMode: string,
): 'none' | 'auto' | 'required' {
  if (selectedMode !== 'model_gateway') {
    return 'auto';
  }
  if (value === 'model_gateway_final') {
    return 'none';
  }
  if (expectsToolResult(value)) {
    return 'required';
  }
  return 'auto';
}

function afterToolResultToolChoiceForScenario(selectedMode: string): 'none' | 'auto' {
  return selectedMode === 'model_gateway' ? 'none' : 'auto';
}

async function pollTask(taskRunId: string): Promise<TaskRun> {
  const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);
  const handledTasks = new Set<string>();
  let lastTask: TaskRun | undefined;
  while (Date.now() < deadline) {
    await resolvePendingHumanTasks(taskRunId, handledTasks);
    lastTask = await getJson<TaskRun>(`${runtimeApiUrl}/v1/tasks/${encodeURIComponent(taskRunId)}`);
    if (lastTask.status === 'completed' || lastTask.status === 'failed') {
      return lastTask;
    }
    await sleep(1000);
  }
  throw new Error(
    `Timed out waiting for ${taskRunId}; last status=${lastTask?.status ?? 'unknown'}`,
  );
}

async function resolvePendingHumanTasks(taskRunId: string, handledTasks: Set<string>) {
  const list = await getJson<{ human_tasks: HumanTask[] }>(
    `${runtimeApiUrl}/v1/human-tasks?tenant_id=${encodeURIComponent(tenantId)}&user_id=${encodeURIComponent(userId)}&task_run_id=${encodeURIComponent(taskRunId)}&status=pending&page_size=20`,
  );
  for (const task of list.human_tasks) {
    if (handledTasks.has(task.human_task_id)) {
      continue;
    }
    if (task.kind === 'user_input') {
      await postJson(
        `${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(task.human_task_id)}/respond`,
        {
          tenant_id: tenantId,
          user_id: userId,
          request_id: `${requestId}_respond_${task.human_task_id}`,
          response_idempotency_key: `${requestId}:respond:${task.human_task_id}`,
          response: { value: 'provided by smoke' },
        },
      );
    } else {
      await postJson(
        `${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(task.human_task_id)}/approve`,
        {
          tenant_id: tenantId,
          user_id: userId,
          request_id: `${requestId}_approve_${task.human_task_id}`,
          decision_reason: 'Pi smoke approval',
          payload: { scenario },
        },
      );
    }
    handledTasks.add(task.human_task_id);
  }
}

async function checkHealth(url: string, appName: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(
    response.ok,
    true,
    `${appName} healthz failed: ${response.status} ${await response.text()}`,
  );
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

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function authHeaders(requestIdValue: string): Record<string, string> {
  return {
    'x-user-id': userId,
    'x-tenant-id': tenantId,
    'x-roles': 'capability_operator',
    'x-request-id': requestIdValue,
  };
}

main().catch((error: unknown) => {
  console.error('smoke:pi-e2e failed');
  console.error(error);
  process.exit(1);
});
