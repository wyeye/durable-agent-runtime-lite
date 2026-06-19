import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentRunRecord, AgentStepRecord, HumanTask, ModelGatewayProtocol, StandardResponse, TaskRun } from '@dar/contracts';
import {
  AgentExecutionPlanRepository,
  FlowExecutionPlanRepository,
  FlowDefinitionRepository,
  ModelPolicyRepository,
  ToolManifestRepository,
  buildExecutionPlanRef,
  closeDb,
  createDb,
  hashJson,
  hashModelPolicy,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';

const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const tenantId = process.env.SMOKE_TENANT_ID ?? 'default';
const userId = process.env.SMOKE_USER_ID ?? 'pi_smoke_user';
const scenario = process.env.PI_SMOKE_SCENARIO ?? 'readonly_tool';
const mode = process.env.PI_SMOKE_MODE ?? (scenario === 'model_gateway' ? 'model_gateway' : 'deterministic');
const modelGatewayProtocol = (process.env.MODEL_GATEWAY_PROTOCOL ?? 'openai_chat_completions') as ModelGatewayProtocol;
const modelGatewayModel = process.env.MODEL_GATEWAY_MODEL ?? 'dar-local-model';
const requestId = `pi_smoke_${scenario}_${Date.now()}`;
const runtimeHeaders = authHeaders(`${requestId}_runtime`);

async function main() {
  const db = createDb({ databaseUrl });
  try {
    const agentExecutionPlanRef = await seedAgentPlan(db);
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');

    const task = await postJson<{ task_run_id: string; workflow_id: string; workflow_start?: { mode: string; started: boolean } }>(
      `${runtimeApiUrl}/v1/agent-tasks`,
      {
        tenant_id: tenantId,
        user_id: userId,
        request_id: `${requestId}_task`,
        agent_execution_plan_ref: agentExecutionPlanRef,
        input: { text: `${scenario} smoke request` },
      },
    );
    assert.equal(task.workflow_start?.started, true);
    assert.equal(task.workflow_start?.mode, 'temporal');

    const finalTask = await pollTask(task.task_run_id);
    assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'Pi task should complete');
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
    if (['readonly_tool', 'l3_tool', 'model_gateway'].includes(scenario)) {
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

    console.log(JSON.stringify({
      ok: true,
      scenario,
      mode,
      task_run_id: task.task_run_id,
      workflow_id: task.workflow_id,
      agent_run_id: agentRun.agent_run_id,
      agent_status: agentRun.status,
      step_count: steps.agent_steps.length,
    }, null, 2));
  } finally {
    await closeDb(db);
  }
}

async function seedAgentPlan(db: ReturnType<typeof createDb>): Promise<string> {
  const promptId = `pi_smoke_prompt_${scenario}_${mode}`;
  const agentId = `pi_smoke_agent_${scenario}_${mode}`;
  const modelPolicy = mode === 'model_gateway' ? `model_gateway:${scenario}` : `deterministic:${deterministicScenario(scenario)}`;
  const modelPolicyId = `pi_smoke_model_${scenario}_${mode}`;
  const publishedModelPolicy = await seedModelPolicy(db, modelPolicyId, modelPolicy);
  const modelPolicyHash = hashModelPolicy(publishedModelPolicy);
  await seedTools(db);
  if (scenario === 'handoff') {
    await seedHandoffTarget(db);
  }
  await upsertPromptDefinition(db, {
    prompt_id: promptId,
    version: 1,
    name: `Pi smoke prompt ${scenario}`,
    content: `You are a Pi smoke agent. Scenario: ${scenario}.`,
    variables: [],
    status: 'published',
  }, { tenantId, status: 'published', createdBy: 'pi-smoke' });
  await upsertAgentSpec(db, {
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
  }, { tenantId, status: 'published', createdBy: 'pi-smoke' });
  const plan = await new AgentExecutionPlanRepository(db).createForAgent({
    tenantId,
    agentId,
    agentVersion: 1,
    operatorId: 'pi-smoke',
  });
  return plan.execution_plan_ref;
}

async function seedModelPolicy(db: ReturnType<typeof createDb>, modelPolicyId: string, displayPolicy: string) {
  const repository = new ModelPolicyRepository(db);
  const existing = await repository.getByIdAndVersion(modelPolicyId, 1, { tenantId });
  if (existing?.status === 'published' || existing?.status === 'gray') {
    return existing;
  }
  if (existing) {
    throw new Error(`ModelPolicy ${modelPolicyId}@1 already exists with non-executable status ${existing.status}`);
  }
  await repository.createDraft({
    model_policy_id: modelPolicyId,
    version: 1,
    status: 'draft',
    protocol: mode === 'model_gateway' ? modelGatewayProtocol : 'dar_generate',
    targets: [{
      target_id: `${modelPolicyId}_primary`,
      gateway_profile: 'local-mock',
      model_id: mode === 'model_gateway' ? modelGatewayModel : displayPolicy,
      priority: 0,
      enabled: true,
      capabilities: ['text', 'tools', 'usage'],
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
      eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'],
      stop_on_auth_error: true,
      stop_on_validation_error: true,
      stop_on_policy_denial: true,
    },
    request_policy: {
      temperature: 0,
      top_p: 1,
      max_output_tokens: 1000,
      tool_choice_mode: 'auto',
      response_format: 'text',
      allow_parallel_tool_calls: false,
    },
    revision: 1,
  }, { tenantId, operatorId: 'pi-smoke' });
  return repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId: 'pi-smoke',
    releaseNote: `pi smoke ${displayPolicy}`,
  });
}

async function seedTools(db: ReturnType<typeof createDb>) {
  const knowledge = JSON.parse(await readFile(new URL('../examples/tools/knowledge-search-tool.json', import.meta.url), 'utf8'));
  const recordWrite = JSON.parse(await readFile(new URL('../examples/tools/record-write-mock-tool.json', import.meta.url), 'utf8'));
  await new ToolManifestRepository(db).upsert(knowledge, { tenantId, status: 'published', createdBy: 'pi-smoke' });
  await new ToolManifestRepository(db).upsert(recordWrite, { tenantId, status: 'published', createdBy: 'pi-smoke' });
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
  await new FlowDefinitionRepository(db).upsert(flow, { tenantId, status: 'published', createdBy: 'pi-smoke' });
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
  throw new Error(`Timed out waiting for ${taskRunId}; last status=${lastTask?.status ?? 'unknown'}`);
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
      await postJson(`${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(task.human_task_id)}/respond`, {
        tenant_id: tenantId,
        user_id: userId,
        request_id: `${requestId}_respond_${task.human_task_id}`,
        response_idempotency_key: `${requestId}:respond:${task.human_task_id}`,
        response: { value: 'provided by smoke' },
      });
    } else {
      await postJson(`${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(task.human_task_id)}/approve`, {
        tenant_id: tenantId,
        user_id: userId,
        request_id: `${requestId}_approve_${task.human_task_id}`,
        decision_reason: 'Pi smoke approval',
        payload: { scenario },
      });
    }
    handledTasks.add(task.human_task_id);
  }
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
