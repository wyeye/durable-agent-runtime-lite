import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HumanTask, StandardResponse, TaskRun, TenantRuntimePolicy } from '@dar/contracts';
import { tenantRuntimePolicySchema } from '@dar/contracts';
import {
  AgentExecutionPlanRepository,
  AgentRunRepository,
  ModelPolicyRepository,
  TaskRunRepository,
  TenantAgentAdmissionRepository,
  TenantRuntimePolicyRepository,
  TenantRuntimePolicySnapshotRepository,
  ToolManifestRepository,
  closeDb,
  createDb,
  hashModelPolicy,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import { ensureModelCatalogEntry } from './model-catalog-seed.js';

const scenario = process.env.TENANT_POLICY_SMOKE_SCENARIO ?? 'policy';
const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const runId = Date.now();
const tenantId = process.env.SMOKE_TENANT_ID ?? `tenant_policy_smoke_${scenario}_${runId}`;
const userId = process.env.SMOKE_USER_ID ?? 'tenant_policy_smoke_user';
const requestId = `tenant_policy_${scenario}_${runId}`;
const runtimeHeaders = authHeaders(`${requestId}_runtime`);

async function main(): Promise<void> {
  const db = createDb({ databaseUrl });
  try {
    await seedTenantPolicy(db, tenantId, scenario);
    if (scenario === 'concurrency') {
      await runConcurrencyScenario(db);
      return;
    }

    const agentExecutionPlanRef = await seedAgentPlan(db, scenario);
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');
    const task = await createAgentTask(agentExecutionPlanRef, `${requestId}_task`);
    const finalTask = await pollTask(db, task.task_run_id);
    assert.equal(finalTask.tenant_id, tenantId);
    assert.ok(finalTask.tenant_policy_snapshot_ref, 'TaskRun should store tenant_policy_snapshot_ref');
    assert.ok(finalTask.tenant_policy_hash, 'TaskRun should store tenant_policy_hash');

    const snapshots = await new TenantRuntimePolicySnapshotRepository(db).listByTenant(tenantId, {
      executionPlanRef: agentExecutionPlanRef,
      limit: 20,
    });
    const rootSnapshot = snapshots.find((snapshot) => snapshot.snapshot_ref === finalTask.tenant_policy_snapshot_ref);
    assert.ok(rootSnapshot, 'Root agent policy snapshot should be queryable by task snapshot ref');
    assert.equal(rootSnapshot.tenant_id, tenantId);
    assert.equal(rootSnapshot.snapshot_hash, finalTask.tenant_policy_hash);
    assert.equal(rootSnapshot.derivation_type, 'root');
    assert.equal(rootSnapshot.execution_plan_ref, agentExecutionPlanRef);

    if (scenario === 'policy') {
      assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'policy smoke task should complete');
      const agentRuns = await new AgentRunRepository(db).list({ tenantId, taskRunId: finalTask.task_run_id, limit: 10 });
      assert.ok(agentRuns.length > 0, 'AgentRun should be persisted');
      assert.equal(agentRuns[0]?.tenant_policy_snapshot_ref, rootSnapshot.snapshot_ref);
      assert.equal(agentRuns[0]?.tenant_policy_hash, rootSnapshot.snapshot_hash);
      assert.equal(agentRuns[0]?.tenant_policy_version, rootSnapshot.source_policy_version);
      console.log(JSON.stringify({
        ok: true,
        scenario,
        task_run_id: finalTask.task_run_id,
        snapshot_ref: rootSnapshot.snapshot_ref,
        snapshot_hash: rootSnapshot.snapshot_hash,
      }, null, 2));
      return;
    }

    if (scenario === 'snapshot') {
      assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'snapshot smoke task should complete');
      const nextPolicy = await publishDenySearchPolicy(db, tenantId);
      assert.equal(nextPolicy.version, rootSnapshot.source_policy_version + 1);
      assert.equal(rootSnapshot.source_policy_version, 1, 'Existing root snapshot must remain locked to v1');
      const afterPublish = await new TenantRuntimePolicySnapshotRepository(db).getByRef(rootSnapshot.snapshot_ref, { tenantId });
      assert.equal(afterPublish?.source_policy_version, 1);
      assert.equal(afterPublish?.source_policy_hash, rootSnapshot.source_policy_hash);
      console.log(JSON.stringify({
        ok: true,
        scenario,
        task_run_id: finalTask.task_run_id,
        root_snapshot_ref: rootSnapshot.snapshot_ref,
        root_source_policy_version: rootSnapshot.source_policy_version,
        latest_policy_version: nextPolicy.version,
      }, null, 2));
      return;
    }

    throw new Error(`Unknown TENANT_POLICY_SMOKE_SCENARIO: ${scenario}`);
  } finally {
    await closeDb(db);
  }
}

async function runConcurrencyScenario(db: ReturnType<typeof createDb>): Promise<void> {
  const agentExecutionPlanRef = await seedAgentPlan(db, 'concurrency');
  await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');
  const first = await createAgentTask(agentExecutionPlanRef, `${requestId}_first`);
  const firstTask = await pollTask(db, first.task_run_id, { stopWhenWaiting: true });
  assert.ok(
    ['queued', 'running', 'waiting_human', 'waiting_user'].includes(firstTask.status),
    `First task should keep admission open, got ${firstTask.status}`,
  );
  const firstAdmission = firstTask.tenant_admission_id
    ? await new TenantAgentAdmissionRepository(db).get(firstTask.tenant_admission_id)
    : undefined;
  assert.ok(firstAdmission, 'First task should reserve admission');
  assert.equal(firstAdmission.tenant_id, tenantId);
  assert.ok(firstAdmission.status === 'reserved' || firstAdmission.status === 'active');

  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      createAgentTaskRaw(agentExecutionPlanRef, `${requestId}_parallel_${index}`)),
  );
  const rejected = attempts.filter((attempt) => attempt.status === 429);
  const accepted = attempts.filter((attempt) => attempt.status >= 200 && attempt.status < 300);
  assert.equal(rejected.length, 20, 'All additional tasks should be rejected while limit=1 admission is open');
  for (const attempt of rejected) {
    assert.equal(attempt.body.success, false);
    assert.equal(attempt.body.error?.code, 'TENANT_AGENT_CONCURRENCY_EXCEEDED');
  }
  assert.equal(accepted.length, 0);
  const activeCount = await new TenantAgentAdmissionRepository(db).getActiveCount(tenantId);
  assert.equal(activeCount, 1);
  console.log(JSON.stringify({
    ok: true,
    scenario,
    first_task_run_id: firstTask.task_run_id,
    rejected_count: rejected.length,
    active_admission_count: activeCount,
  }, null, 2));
}

async function seedAgentPlan(db: ReturnType<typeof createDb>, scenarioValue: string): Promise<string> {
  const promptId = `tenant_policy_prompt_${scenarioValue}`;
  const agentId = `tenant_policy_agent_${scenarioValue}`;
  const modelPolicy = scenarioValue === 'concurrency' ? 'deterministic:need_user' : 'deterministic:readonly_tool';
  const publishedModelPolicy = await seedModelPolicy(
    db,
    `tenant_policy_model_${scenarioValue}`,
    modelPolicy,
  );
  const modelPolicyHash = hashModelPolicy(publishedModelPolicy);
  await seedTools(db);
  await upsertPromptDefinition(db, {
    prompt_id: promptId,
    version: 1,
    name: `Tenant policy smoke prompt ${scenarioValue}`,
    content: `Tenant policy smoke scenario: ${scenarioValue}.`,
    variables: [],
    status: 'published',
  }, { tenantId, status: 'published', createdBy: 'tenant-policy-smoke' });
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
    allowed_handoffs: [],
    max_steps: 4,
    max_tokens: 2000,
    output_schema: 'tenant_policy_smoke_result_v1',
    status: 'published',
  }, { tenantId, status: 'published', createdBy: 'tenant-policy-smoke' });
  const plan = await new AgentExecutionPlanRepository(db).createForAgent({
    tenantId,
    agentId,
    agentVersion: 1,
    operatorId: 'tenant-policy-smoke',
  });
  return plan.execution_plan_ref;
}

async function seedModelPolicy(
  db: ReturnType<typeof createDb>,
  modelPolicyId: string,
  displayPolicy: string,
) {
  const repository = new ModelPolicyRepository(db);
  const catalog = await ensureModelCatalogEntry(db, {
    profileId: 'local-deterministic',
    displayName: 'Local deterministic development model gateway',
    baseUrl: process.env.SEED_DETERMINISTIC_MODEL_GATEWAY_BASE_URL ?? 'http://mock-server:4100',
    authType: 'none',
    modelId: displayPolicy,
    upstreamModelId: displayPolicy,
    provider: 'local-mock',
    capabilities: ['text', 'tools', 'usage'],
    operatorId: 'tenant-policy-smoke',
  });
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
    },
    { tenantId, operatorId: 'tenant-policy-smoke' },
  );
  return repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId: 'tenant-policy-smoke',
    releaseNote: `tenant policy smoke ${displayPolicy}`,
  });
}

async function seedTools(db: ReturnType<typeof createDb>): Promise<void> {
  const knowledge = JSON.parse(await readFile(new URL('../../../../examples/tools/knowledge-search-tool.json', import.meta.url), 'utf8'));
  const recordWrite = JSON.parse(await readFile(new URL('../../../../examples/tools/record-write-mock-tool.json', import.meta.url), 'utf8'));
  await new ToolManifestRepository(db).upsert(knowledge, { tenantId, status: 'published', createdBy: 'tenant-policy-smoke' });
  await new ToolManifestRepository(db).upsert(recordWrite, { tenantId, status: 'published', createdBy: 'tenant-policy-smoke' });
}

async function seedTenantPolicy(
  db: ReturnType<typeof createDb>,
  tenantIdValue: string,
  scenarioValue: string,
): Promise<TenantRuntimePolicy> {
  const repository = new TenantRuntimePolicyRepository(db);
  const existing = await repository.getLatestPublished(tenantIdValue);
  if (existing) {
    return existing;
  }
  const maxConcurrentAgentRuns = scenarioValue === 'concurrency' ? 1 : 2;
  const policy = tenantRuntimePolicySchema.parse({
    tenant_id: tenantIdValue,
    version: 1,
    status: 'draft' as const,
    allowed_tools: [{
      tool_name: 'knowledge.search',
      versions: ['1.0.0'],
      allowed_operations: ['invoke' as const],
      max_risk_level: 'L1' as const,
    }],
    denied_tools: [{
      tool_name: 'record.write.mock',
      versions: ['1.0.0'],
      allowed_operations: ['invoke' as const, 'preview' as const, 'commit' as const],
      max_risk_level: 'L3' as const,
      reason_code: 'TENANT_POLICY_DENY_WRITE',
    }],
    allowed_models: [
      { model_id: 'deterministic:readonly_tool' },
      { model_id: 'deterministic:need_user' },
    ],
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
    max_concurrent_agent_runs: maxConcurrentAgentRuns,
  });
  await repository.createDraft(policy, { tenantId: tenantIdValue, operatorId: 'tenant-policy-smoke' });
  return repository.publish(tenantIdValue, policy.version, {
    tenantId: tenantIdValue,
    operatorId: 'tenant-policy-smoke',
    releaseNote: 'tenant policy smoke v1',
  });
}

async function publishDenySearchPolicy(db: ReturnType<typeof createDb>, tenantIdValue: string): Promise<TenantRuntimePolicy> {
  const repository = new TenantRuntimePolicyRepository(db);
  const latest = await repository.getLatestPublished(tenantIdValue);
  assert.ok(latest, 'v1 policy should exist before v2 publish');
  const draft = await repository.cloneVersion(tenantIdValue, latest.version, {
    tenantId: tenantIdValue,
    operatorId: 'tenant-policy-smoke',
    version: latest.version + 1,
  });
  await repository.updateDraft(tenantIdValue, draft.version, {
    expectedRevision: draft.revision,
    operatorId: 'tenant-policy-smoke',
    policy: {
      allowed_tools: [],
      denied_tools: [{
        tool_name: 'knowledge.search',
        versions: ['1.0.0'],
        allowed_operations: ['invoke', 'preview', 'commit'],
        max_risk_level: 'L1',
        reason_code: 'TENANT_POLICY_DENY_SEARCH',
      }],
    },
  });
  return repository.publish(tenantIdValue, draft.version, {
    tenantId: tenantIdValue,
    operatorId: 'tenant-policy-smoke',
    releaseNote: 'tenant policy smoke v2 deny search',
  });
}

async function createAgentTask(agentExecutionPlanRef: string, taskRequestId: string) {
  const result = await createAgentTaskRaw(agentExecutionPlanRef, taskRequestId);
  if (result.status < 200 || result.status >= 300 || result.body.success !== true) {
    throw new Error(`POST /v1/agent-tasks failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body.data as { task_run_id: string; workflow_id: string; workflow_start?: { mode: string; started: boolean } };
}

async function createAgentTaskRaw(agentExecutionPlanRef: string, taskRequestId: string) {
  const response = await fetch(`${runtimeApiUrl}/v1/agent-tasks`, {
    method: 'POST',
    headers: { ...runtimeHeaders, 'content-type': 'application/json', 'x-request-id': taskRequestId },
    body: JSON.stringify({
      tenant_id: tenantId,
      user_id: userId,
      request_id: taskRequestId,
      agent_execution_plan_ref: agentExecutionPlanRef,
      input: { text: `${scenario} tenant policy smoke` },
    }),
  });
  const body = await response.json() as StandardResponse<unknown>;
  return { status: response.status, body };
}

async function pollTask(
  db: ReturnType<typeof createDb>,
  taskRunId: string,
  options: { stopWhenWaiting?: boolean } = {},
): Promise<TaskRun> {
  const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);
  const handledTasks = new Set<string>();
  let lastTask: TaskRun | undefined;
  while (Date.now() < deadline) {
    if (!options.stopWhenWaiting) {
      await resolvePendingHumanTasks(taskRunId, handledTasks);
    }
    lastTask = await new TaskRunRepository(db).get(taskRunId);
    if (lastTask && (lastTask.status === 'completed' || lastTask.status === 'failed')) {
      return lastTask;
    }
    if (options.stopWhenWaiting && lastTask?.tenant_admission_id) {
      return lastTask;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${taskRunId}; last status=${lastTask?.status ?? 'unknown'}`);
}

async function resolvePendingHumanTasks(taskRunId: string, handledTasks: Set<string>): Promise<void> {
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
        response: { value: 'provided by tenant policy smoke' },
      });
    } else {
      await postJson(`${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(task.human_task_id)}/approve`, {
        tenant_id: tenantId,
        user_id: userId,
        request_id: `${requestId}_approve_${task.human_task_id}`,
        decision_reason: 'Tenant policy smoke approval',
        payload: { scenario },
      });
    }
    handledTasks.add(task.human_task_id);
  }
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

async function checkHealth(url: string, appName: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${appName} healthz failed: ${response.status} ${await response.text()}`);
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
  console.error('smoke:tenant-policy-e2e failed');
  console.error(error);
  process.exit(1);
});
