import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  AgentRunRecord,
  AgentStepRecord,
  HumanTask,
  StandardResponse,
  TaskRun,
  ToolCallLog,
} from '@dar/contracts';
import {
  AgentExecutionPlanRepository,
  ModelPolicyRepository,
  ToolManifestRepository,
  closeDb,
  createDb,
  hashModelPolicy,
  sql,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';

type Db = ReturnType<typeof createDb>;
type Dateish = Date | string;
type Jsonish = unknown;

interface AgentRunRow {
  agent_run_id: string;
  tenant_id: string;
  user_id: string;
  task_run_id: string;
  workflow_id: string;
  workflow_run_id: string | null;
  parent_workflow_id: string | null;
  execution_plan_ref: string;
  execution_plan_hash: string;
  agent_id: string;
  agent_version: number;
  prompt_id: string;
  prompt_version: number;
  model: string;
  model_policy_id: string | null;
  model_policy_version: number | null;
  model_policy_hash: string | null;
  selected_model_id: string | null;
  selected_provider: string | null;
  execution_mode: string;
  status: string;
  current_segment_index: number;
  model_turn_count: number;
  tool_call_count: number;
  handoff_count: number;
  fallback_count: number;
  model_call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number | null;
  started_at: Dateish | null;
  completed_at: Dateish | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Dateish;
  updated_at: Dateish;
}

interface HumanTaskRow {
  human_task_id: string;
  tenant_id: string;
  task_run_id: string;
  workflow_id: string | null;
  kind: string;
  status: string;
  payload: Jsonish;
  response_json: Jsonish | null;
  responded_by: string | null;
  response_idempotency_key: string | null;
  created_at: Dateish;
}

interface AgentStepRow {
  agent_step_id: string;
  agent_run_id: string;
  segment_index: number;
  stable_step_key: string;
  segment_status: string;
  proposed_tool_calls_json: Jsonish;
  tool_result_refs_json: Jsonish;
  authoritative_tool_result_refs_json: Jsonish;
  human_task_ids_json: Jsonish;
  context_snapshot_before_ref: Jsonish | null;
  context_snapshot_after_ref: Jsonish | null;
  handoff_refs_json: Jsonish;
  context_snapshot_ref: Jsonish | null;
  output_ref: string | null;
  usage_json: Jsonish;
  error_code: string | null;
  error_message: string | null;
  created_at: Dateish;
  updated_at: Dateish;
}

interface TaskRunRow {
  task_run_id: string;
  tenant_id: string;
  user_id: string;
  route_type: string;
  workflow_id: string | null;
  execution_plan_ref: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  created_at: Dateish;
  updated_at: Dateish;
}

interface ToolCallRow {
  tool_call_id: string;
  task_run_id: string | null;
  workflow_id: string | null;
  tenant_id: string;
  user_id: string | null;
  tool_name: string;
  tool_version: string;
  risk_level: string;
  policy_decision: string;
  status: string;
  idempotency_key: string | null;
  input_hash: string | null;
  output_hash: string | null;
  error_code: string | null;
  adapter_type: string | null;
  mode: string | null;
  preview_json: Jsonish | null;
  result_json: Jsonish | null;
  created_at: Dateish;
  updated_at: Dateish;
}

const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const runtimeWorkerUrl = trimTrailingSlash(
  process.env.RUNTIME_WORKER_URL ?? 'http://localhost:3300',
);
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const tenantId = process.env.SMOKE_TENANT_ID ?? 'default';
const userId = process.env.SMOKE_USER_ID ?? 'pi_crash_smoke_user';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
const composeFiles = (
  process.env.PI_CRASH_COMPOSE_FILES ?? 'infra/docker-compose.yml,infra/docker-compose.pi-smoke.yml'
)
  .split(',')
  .map((file) => file.trim())
  .filter(Boolean);
const requestPrefix = `pi_crash_${Date.now()}`;
const runtimeHeaders = authHeaders(`${requestPrefix}_runtime`);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const resultFile = process.env.PI_CRASH_RESULT_FILE;

async function main(): Promise<void> {
  const db = createDb({ databaseUrl });
  try {
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');
    await checkReady(`${runtimeWorkerUrl}/readyz`, 'runtime-worker');
    const waitingUser = await runWaitingUserRecovery(db);
    const l3 = await runL3Recovery(db);
    const summary = {
      ok: true,
      scenarios: {
        waiting_user: waitingUser,
        l3_tool: l3,
      },
    };
    const summaryText = JSON.stringify(summary, null, 2);
    if (resultFile) {
      await mkdir(dirname(resultFile), { recursive: true });
      await writeFile(resultFile, `${summaryText}\n`, 'utf8');
    }
    console.log(summaryText);
  } catch (error) {
    await safeDiagnostics(db, error);
    throw error;
  } finally {
    await ensureWorkerStarted();
    await closeDb(db);
  }
}

async function runWaitingUserRecovery(db: Db) {
  const scenario = 'need_user';
  const planRef = await seedAgentPlan(db, scenario);
  const task = await createAgentTask(planRef, scenario);
  const agentRun = await waitForAgentRun(db, task.task_run_id, 'waiting_user');
  const humanTask = await waitForHumanTask(db, task.task_run_id, 'user_input', 'pending');
  const snapshot = await waitForLatestSnapshot(db, agentRun.agent_run_id);
  const stepsBefore = await listSteps(db, agentRun.agent_run_id);
  const stepKeysBefore = new Set(stepsBefore.map((step) => step.stable_step_key));

  await killWorker();
  await assertWorkerStopped();

  await postJson(
    `${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(humanTask.human_task_id)}/respond`,
    {
      request_id: `${requestPrefix}_${scenario}_respond`,
      response_idempotency_key: `${requestPrefix}:${scenario}:respond:${humanTask.human_task_id}`,
      response: { value: 'provided during worker downtime' },
    },
  );
  const respondedTask = await waitForHumanTaskById(db, humanTask.human_task_id, 'resolved');
  const interimTask = await getTaskRun(db, task.task_run_id);
  assert.notEqual(
    interimTask?.status,
    'completed',
    'TaskRun must not complete while worker is stopped',
  );

  await startWorker();
  await checkReady(`${runtimeWorkerUrl}/readyz`, 'runtime-worker');
  const completedTask = await pollTask(task.task_run_id, 'completed');
  const finalRun = await getSingleAgentRun(db, task.task_run_id);
  const finalSteps = await listSteps(db, finalRun.agent_run_id);
  const humanTasks = await listHumanTasks(db, task.task_run_id);
  const snapshots = await listSnapshots(db, finalRun.agent_run_id);
  const respondedEvents = await countAuditEvents(
    db,
    'human_task.respond',
    respondedTask.human_task_id,
    task.task_run_id,
  );

  assert.equal(finalRun.agent_run_id, agentRun.agent_run_id, 'AgentRun ID must remain stable');
  assert.equal(finalRun.workflow_id, agentRun.workflow_id, 'Agent workflow ID must remain stable');
  assert.equal(completedTask.workflow_id, task.workflow_id, 'Task workflow ID must remain stable');
  assert.equal(finalRun.status, 'completed', 'AgentRun should complete after worker restart');
  assert.equal(completedTask.status, 'completed', 'TaskRun should complete after worker restart');
  assert.equal(
    humanTasks.filter((entry) => entry.kind === 'user_input').length,
    1,
    'Human Task must not duplicate',
  );
  assert.equal(respondedEvents, 1, 'human_task.respond audit should be written once');
  assertNoDuplicate(
    finalSteps.map((step) => step.stable_step_key),
    'AgentStep stable_step_key',
  );
  assert.ok(
    stepKeysBefore.size <= finalSteps.length,
    'AgentStep count should only advance after resume',
  );
  assert.ok(
    snapshots.some((entry) => entry.previous_snapshot_id === snapshot.snapshot_id),
    'Context Snapshot chain should continue from pre-crash snapshot',
  );

  return {
    task_run_id: task.task_run_id,
    workflow_id: task.workflow_id,
    task_workflow_run_id: task.workflow_start?.run_id,
    agent_workflow_id: finalRun.workflow_id,
    workflow_run_id: finalRun.workflow_run_id,
    agent_run_id: finalRun.agent_run_id,
    human_task_id: humanTask.human_task_id,
    context_snapshot_id: snapshot.snapshot_id,
    step_count_before: stepsBefore.length,
    step_count_after: finalSteps.length,
  };
}

async function runL3Recovery(db: Db) {
  const scenario = 'l3_tool';
  const planRef = await seedAgentPlan(db, scenario);
  const task = await createAgentTask(planRef, scenario);
  const agentRun = await waitForAgentRun(db, task.task_run_id, 'waiting_human');
  const humanTask = await waitForHumanTask(db, task.task_run_id, 'approval', 'pending');
  const previewCall = await waitForToolCall(db, task.task_run_id, [
    'pending_confirmation',
    'previewed',
  ]);
  const auditPreviewCount = await countAuditEvents(
    db,
    'tool.preview',
    previewCall.tool_name,
    task.task_run_id,
  );
  const idempotencyBefore = await countIdempotencyRecords(db, previewCall.idempotency_key);
  const stepsBefore = await listSteps(db, agentRun.agent_run_id);

  await killWorker();
  await assertWorkerStopped();

  await postJson(
    `${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(humanTask.human_task_id)}/approve`,
    {
      request_id: `${requestPrefix}_${scenario}_approve`,
      decision_reason: 'Crash smoke approval while worker is down',
      payload: { scenario },
    },
  );
  await waitForHumanTaskById(db, humanTask.human_task_id, 'approved');
  await assertNoCommittedToolCall(db, previewCall.tool_call_id);

  await startWorker();
  await checkReady(`${runtimeWorkerUrl}/readyz`, 'runtime-worker');
  const completedTask = await pollTask(task.task_run_id, 'completed');
  const finalRun = await getSingleAgentRun(db, task.task_run_id);
  const finalSteps = await listSteps(db, finalRun.agent_run_id);
  const finalToolCall = await getToolCall(db, previewCall.tool_call_id);
  const commitEvents = await countAuditEvents(
    db,
    'tool.commit',
    previewCall.tool_name,
    task.task_run_id,
  );
  const commitIdempotency = await countIdempotencyRecords(
    db,
    agentToolGatewayStoreKey({
      tenantId,
      toolName: previewCall.tool_name,
      operation: 'commit',
      agentRunId: finalRun.agent_run_id,
      segmentIndex: 0,
      callId: 'call_l3_1',
      toolVersion: previewCall.tool_version,
    }),
  );
  const snapshots = await listSnapshots(db, finalRun.agent_run_id);

  assert.equal(finalRun.agent_run_id, agentRun.agent_run_id, 'AgentRun ID must remain stable');
  assert.equal(finalRun.workflow_id, agentRun.workflow_id, 'Agent workflow ID must remain stable');
  assert.equal(completedTask.workflow_id, task.workflow_id, 'Task workflow ID must remain stable');
  assert.equal(finalRun.status, 'completed', 'AgentRun should complete after L3 worker restart');
  assert.equal(
    completedTask.status,
    'completed',
    'TaskRun should complete after L3 worker restart',
  );
  assert.equal(finalToolCall.status, 'committed', 'ToolCallLog should be committed after restart');
  assert.equal(commitEvents, 1, 'tool.commit audit should be written once');
  assert.equal(
    commitIdempotency,
    1,
    'commit idempotency record should have one authoritative result',
  );
  assert.ok(idempotencyBefore <= 1, 'preview idempotency should not duplicate before approval');
  assert.ok(auditPreviewCount >= 1, 'preview audit must exist');
  assertNoDuplicate(
    finalSteps.map((step) => step.stable_step_key),
    'AgentStep stable_step_key',
  );
  assert.ok(finalSteps.length >= stepsBefore.length, 'AgentStep count should not shrink');
  assert.ok(
    snapshots.some((entry) =>
      JSON.stringify(entry.sanitized_messages_json).includes('authoritative_tool_result'),
    ),
    'Context Snapshot should include authoritative tool result once after commit',
  );
  const authoritativeMentions = snapshots
    .map((entry) => JSON.stringify(entry.sanitized_messages_json))
    .filter(
      (text) => text.includes('authoritative_tool_result') && text.includes(previewCall.tool_name),
    );
  assert.ok(
    authoritativeMentions.length >= 1,
    'Tool Result should appear in authoritative replacement snapshots',
  );
  const finalSnapshotText = JSON.stringify(snapshots.at(-1)?.sanitized_messages_json ?? {});
  assert.equal(
    countSubstring(finalSnapshotText, 'authoritative_tool_result'),
    1,
    'Final Context Snapshot should contain one authoritative replacement for the L3 tool result',
  );

  return {
    task_run_id: task.task_run_id,
    workflow_id: task.workflow_id,
    task_workflow_run_id: task.workflow_start?.run_id,
    agent_workflow_id: finalRun.workflow_id,
    workflow_run_id: finalRun.workflow_run_id,
    agent_run_id: finalRun.agent_run_id,
    human_task_id: humanTask.human_task_id,
    tool_call_id: previewCall.tool_call_id,
    step_count_before: stepsBefore.length,
    step_count_after: finalSteps.length,
  };
}

async function seedAgentPlan(db: Db, scenario: 'need_user' | 'l3_tool'): Promise<string> {
  const promptId = `pi_crash_prompt_${scenario}`;
  const agentId = `pi_crash_agent_${scenario}`;
  const displayPolicy = `deterministic:${scenario}`;
  const modelPolicyId = `pi_crash_model_${scenario}`;
  const publishedModelPolicy = await seedModelPolicy(db, modelPolicyId, displayPolicy);
  const modelPolicyHash = hashModelPolicy(publishedModelPolicy);
  await seedTools(db);
  await upsertPromptDefinition(
    db,
    {
      prompt_id: promptId,
      version: 1,
      name: `Pi crash smoke prompt ${scenario}`,
      content: `You are a Pi crash smoke agent. Scenario: ${scenario}.`,
      variables: [],
      status: 'published',
    },
    { tenantId, status: 'published', createdBy: 'pi-crash-smoke' },
  );
  await upsertAgentSpec(
    db,
    {
      agent_id: agentId,
      version: 1,
      prompt_ref: `${promptId}@1`,
      model_policy: displayPolicy,
      model_policy_ref: {
        model_policy_id: publishedModelPolicy.model_policy_id,
        model_policy_version: publishedModelPolicy.version,
        model_policy_hash: modelPolicyHash,
      },
      allowed_tools: ['knowledge.search@1.0.0', 'record.write.mock@1.0.0'],
      allowed_handoffs: [],
      max_steps: 6,
      max_tokens: 2000,
      output_schema: 'pi_crash_smoke_result_v1',
      status: 'published',
    },
    { tenantId, status: 'published', createdBy: 'pi-crash-smoke' },
  );
  const plan = await new AgentExecutionPlanRepository(db).createForAgent({
    tenantId,
    agentId,
    agentVersion: 1,
    operatorId: 'pi-crash-smoke',
  });
  return plan.execution_plan_ref;
}

async function seedModelPolicy(db: Db, modelPolicyId: string, displayPolicy: string) {
  const repository = new ModelPolicyRepository(db);
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
      protocol: 'dar_generate',
      targets: [
        {
          target_id: `${modelPolicyId}_primary`,
          gateway_profile: 'local-deterministic',
          model_id: displayPolicy,
          priority: 0,
          enabled: true,
          capabilities: ['text', 'tools', 'usage'],
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
    { tenantId, operatorId: 'pi-crash-smoke' },
  );
  return repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId: 'pi-crash-smoke',
    releaseNote: `pi crash smoke ${displayPolicy}`,
  });
}

async function seedTools(db: Db) {
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
    createdBy: 'pi-crash-smoke',
  });
  await new ToolManifestRepository(db).upsert(recordWrite, {
    tenantId,
    status: 'published',
    createdBy: 'pi-crash-smoke',
  });
}

async function createAgentTask(agentExecutionPlanRef: string, scenario: string) {
  const task = await postJson<{
    task_run_id: string;
    workflow_id: string;
    workflow_start?: { mode: string; started: boolean; run_id?: string };
  }>(`${runtimeApiUrl}/v1/agent-tasks`, {
    request_id: `${requestPrefix}_${scenario}_task`,
    agent_execution_plan_ref: agentExecutionPlanRef,
    input: { text: `${scenario} crash smoke request` },
  });
  assert.equal(task.workflow_start?.started, true);
  assert.equal(task.workflow_start?.mode, 'temporal');
  return task;
}

async function killWorker(): Promise<void> {
  await dockerCompose(['kill', '-s', 'SIGKILL', 'runtime-worker']);
}

async function startWorker(): Promise<void> {
  await dockerCompose(['up', '-d', 'runtime-worker']);
}

async function ensureWorkerStarted(): Promise<void> {
  try {
    await startWorker();
  } catch {
    // Diagnostics already report compose state; final cleanup is best effort.
  }
}

async function assertWorkerStopped(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await dockerComposeOutput(['ps', '--format', 'json', 'runtime-worker']);
    if (state.includes('exited') || state.includes('Exited') || state.trim().length === 0) {
      break;
    }
    await sleep(500);
  }
  try {
    const response = await fetch(`${runtimeWorkerUrl}/readyz`);
    assert.equal(
      response.ok,
      false,
      'runtime-worker /readyz should be unavailable or not ready after SIGKILL',
    );
  } catch {
    return;
  }
}

async function pollTask(taskRunId: string, expectedStatus: TaskRun['status']): Promise<TaskRun> {
  return poll(async () => {
    const task = await getTaskRunFromApi(taskRunId);
    return task.status === expectedStatus ? task : undefined;
  }, `TaskRun ${taskRunId} to reach ${expectedStatus}`);
}

async function getTaskRunFromApi(taskRunId: string): Promise<TaskRun> {
  return getJson<TaskRun>(`${runtimeApiUrl}/v1/tasks/${encodeURIComponent(taskRunId)}`);
}

async function waitForAgentRun(
  db: Db,
  taskRunId: string,
  status: AgentRunRecord['status'],
): Promise<AgentRunRecord> {
  return poll(async () => {
    const rows = await db
      .selectFrom('agent_run')
      .selectAll()
      .where('task_run_id', '=', taskRunId)
      .execute();
    if (rows.length === 0) {
      return undefined;
    }
    assert.equal(rows.length, 1, `Expected at most one AgentRun for ${taskRunId}`);
    const run = agentRunFromRow(rows[0]!);
    return run.status === status ? run : undefined;
  }, `AgentRun for ${taskRunId} to reach ${status}`);
}

async function getSingleAgentRun(db: Db, taskRunId: string): Promise<AgentRunRecord> {
  const rows = await db
    .selectFrom('agent_run')
    .selectAll()
    .where('task_run_id', '=', taskRunId)
    .execute();
  assert.equal(rows.length, 1, `Expected exactly one AgentRun for ${taskRunId}`);
  const row = rows[0]!;
  return agentRunFromRow(row);
}

function agentRunFromRow(row: AgentRunRow): AgentRunRecord {
  return optionalObject<AgentRunRecord>({
    agent_run_id: row.agent_run_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    task_run_id: row.task_run_id,
    workflow_id: row.workflow_id,
    execution_plan_ref: row.execution_plan_ref,
    execution_plan_hash: row.execution_plan_hash,
    agent_id: row.agent_id,
    agent_version: row.agent_version,
    prompt_id: row.prompt_id,
    prompt_version: row.prompt_version,
    model: row.model,
    model_policy_id: row.model_policy_id ?? undefined,
    model_policy_version: row.model_policy_version ?? undefined,
    model_policy_hash: row.model_policy_hash ?? undefined,
    selected_model_id: row.selected_model_id ?? undefined,
    selected_provider: row.selected_provider ?? undefined,
    execution_mode: row.execution_mode as AgentRunRecord['execution_mode'],
    status: row.status as AgentRunRecord['status'],
    current_segment_index: row.current_segment_index,
    model_turn_count: row.model_turn_count,
    tool_call_count: row.tool_call_count,
    handoff_count: row.handoff_count,
    fallback_count: row.fallback_count,
    model_call_count: row.model_call_count,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    workflow_run_id: row.workflow_run_id ?? undefined,
    parent_workflow_id: row.parent_workflow_id ?? undefined,
    estimated_cost: row.estimated_cost ?? undefined,
    started_at: row.started_at ? new Date(row.started_at).toISOString() : undefined,
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
    error_code: row.error_code ?? undefined,
    error_message: row.error_message ?? undefined,
  });
}

async function waitForHumanTask(
  db: Db,
  taskRunId: string,
  kind: HumanTask['kind'],
  status: HumanTask['status'],
): Promise<HumanTask> {
  return poll(async () => {
    const tasks = await listHumanTasks(db, taskRunId);
    return tasks.find((task) => task.kind === kind && task.status === status);
  }, `HumanTask ${kind}/${status} for ${taskRunId}`);
}

async function waitForHumanTaskById(
  db: Db,
  humanTaskId: string,
  status: HumanTask['status'],
): Promise<HumanTask> {
  return poll(async () => {
    const row = await db
      .selectFrom('human_task')
      .selectAll()
      .where('human_task_id', '=', humanTaskId)
      .executeTakeFirst();
    if (!row || row.status !== status) {
      return undefined;
    }
    return humanTaskFromRow(row);
  }, `HumanTask ${humanTaskId} to reach ${status}`);
}

async function listHumanTasks(db: Db, taskRunId: string): Promise<HumanTask[]> {
  const rows = await db
    .selectFrom('human_task')
    .selectAll()
    .where('task_run_id', '=', taskRunId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(humanTaskFromRow);
}

function humanTaskFromRow(row: HumanTaskRow): HumanTask {
  return optionalObject<HumanTask>({
    human_task_id: row.human_task_id,
    tenant_id: row.tenant_id,
    task_run_id: row.task_run_id,
    kind: row.kind as HumanTask['kind'],
    status: row.status as HumanTask['status'],
    candidate_groups: [],
    payload: safeRecord(row.payload) ?? {},
    created_at: new Date(row.created_at).toISOString(),
    workflow_id: row.workflow_id ?? undefined,
    response: safeRecord(row.response_json) ?? undefined,
    responded_by: row.responded_by ?? undefined,
    response_idempotency_key: row.response_idempotency_key ?? undefined,
  });
}

async function waitForLatestSnapshot(db: Db, agentRunId: string) {
  return poll(async () => {
    const snapshots = await listSnapshots(db, agentRunId);
    return snapshots.at(-1);
  }, `Context Snapshot for ${agentRunId}`);
}

async function listSnapshots(db: Db, agentRunId: string) {
  return db
    .selectFrom('agent_context_snapshot')
    .selectAll()
    .where('agent_run_id', '=', agentRunId)
    .orderBy('created_at', 'asc')
    .execute();
}

async function listSteps(db: Db, agentRunId: string): Promise<AgentStepRecord[]> {
  const rows = await db
    .selectFrom('agent_step')
    .selectAll()
    .where('agent_run_id', '=', agentRunId)
    .orderBy('segment_index', 'asc')
    .execute();
  return rows.map(agentStepFromRow);
}

function agentStepFromRow(row: AgentStepRow): AgentStepRecord {
  return optionalObject<AgentStepRecord>({
    agent_step_id: row.agent_step_id,
    agent_run_id: row.agent_run_id,
    segment_index: row.segment_index,
    stable_step_key: row.stable_step_key,
    segment_status: row.segment_status as AgentStepRecord['segment_status'],
    proposed_tool_calls: Array.isArray(row.proposed_tool_calls_json)
      ? row.proposed_tool_calls_json
      : [],
    tool_result_refs: Array.isArray(row.tool_result_refs_json)
      ? (row.tool_result_refs_json as AgentStepRecord['tool_result_refs'])
      : [],
    authoritative_tool_result_refs: Array.isArray(row.authoritative_tool_result_refs_json)
      ? (row.authoritative_tool_result_refs_json as AgentStepRecord['authoritative_tool_result_refs'])
      : [],
    human_task_ids: Array.isArray(row.human_task_ids_json)
      ? row.human_task_ids_json.map(String)
      : [],
    handoff_refs: Array.isArray(row.handoff_refs_json)
      ? (row.handoff_refs_json as Array<Record<string, unknown>>)
      : [],
    usage: usageFromJson(row.usage_json),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    context_snapshot_before: safeRecord(row.context_snapshot_before_ref) as
      | AgentStepRecord['context_snapshot_before']
      | undefined,
    context_snapshot_after: safeRecord(row.context_snapshot_after_ref) as
      | AgentStepRecord['context_snapshot_after']
      | undefined,
    context_snapshot_ref: safeRecord(row.context_snapshot_ref) as
      | AgentStepRecord['context_snapshot_ref']
      | undefined,
    output_ref: row.output_ref ?? undefined,
    error_code: row.error_code ?? undefined,
    error_message: row.error_message ?? undefined,
  });
}

async function waitForToolCall(
  db: Db,
  taskRunId: string,
  statuses: ToolCallLog['status'] | ToolCallLog['status'][],
): Promise<ToolCallLog> {
  const expectedStatuses = Array.isArray(statuses) ? statuses : [statuses];
  return poll(
    async () => {
      const rows = await db
        .selectFrom('tool_call_log')
        .selectAll()
        .where('task_run_id', '=', taskRunId)
        .where('status', 'in', expectedStatuses)
        .execute();
      const row = rows[0];
      return row ? toolCallFromRow(row) : undefined;
    },
    `ToolCall ${expectedStatuses.join('/')} for ${taskRunId}`,
  );
}

async function getToolCall(db: Db, toolCallId: string): Promise<ToolCallLog> {
  const row = await db
    .selectFrom('tool_call_log')
    .selectAll()
    .where('tool_call_id', '=', toolCallId)
    .executeTakeFirst();
  assert.ok(row, `ToolCallLog not found: ${toolCallId}`);
  return toolCallFromRow(row);
}

async function assertNoCommittedToolCall(db: Db, toolCallId: string): Promise<void> {
  const toolCall = await getToolCall(db, toolCallId);
  assert.notEqual(
    toolCall.status,
    'committed',
    'Tool commit must not execute while worker is stopped',
  );
}

async function countAuditEvents(
  db: Db,
  action: string,
  targetId: string,
  taskRunId: string,
): Promise<number> {
  const result = await db
    .selectFrom('audit_event')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('tenant_id', '=', tenantId)
    .where('action', '=', action)
    .where('target_id', '=', targetId)
    .where(sql<string>`payload->>'task_run_id'`, '=', taskRunId)
    .executeTakeFirst();
  return Number(result?.count ?? 0);
}

async function countIdempotencyRecords(
  db: Db,
  idempotencyKey: string | undefined,
): Promise<number> {
  if (!idempotencyKey) {
    return 0;
  }
  const result = await db
    .selectFrom('idempotency_record')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  return Number(result?.count ?? 0);
}

async function getTaskRun(db: Db, taskRunId: string): Promise<TaskRun | undefined> {
  const row = await db
    .selectFrom('task_run')
    .selectAll()
    .where('task_run_id', '=', taskRunId)
    .executeTakeFirst();
  if (!row) {
    return undefined;
  }
  return taskRunFromRow(row);
}

function taskRunFromRow(row: TaskRunRow): TaskRun {
  return optionalObject<TaskRun>({
    task_run_id: row.task_run_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    route_type: row.route_type as TaskRun['route_type'],
    status: row.status as TaskRun['status'],
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    workflow_id: row.workflow_id ?? undefined,
    execution_plan_ref: row.execution_plan_ref ?? undefined,
    error_code: row.error_code ?? undefined,
    error_message: row.error_message ?? undefined,
  });
}

function toolCallFromRow(row: ToolCallRow): ToolCallLog {
  return optionalObject<ToolCallLog>({
    tool_call_id: row.tool_call_id,
    tenant_id: row.tenant_id,
    tool_name: row.tool_name,
    tool_version: row.tool_version,
    risk_level: row.risk_level as ToolCallLog['risk_level'],
    policy_decision: row.policy_decision as ToolCallLog['policy_decision'],
    status: row.status as ToolCallLog['status'],
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    task_run_id: row.task_run_id ?? undefined,
    workflow_id: row.workflow_id ?? undefined,
    user_id: row.user_id ?? undefined,
    idempotency_key: row.idempotency_key ?? undefined,
    input_hash: row.input_hash ?? undefined,
    output_hash: row.output_hash ?? undefined,
    mode: row.mode ? (row.mode as ToolCallLog['mode']) : undefined,
    error_code: row.error_code ?? undefined,
    adapter_type: row.adapter_type ?? undefined,
    preview_json: row.preview_json ?? undefined,
    result_json: row.result_json ?? undefined,
  });
}

async function checkHealth(url: string, appName: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(
    response.ok,
    true,
    `${appName} healthz failed: ${response.status} ${await response.text()}`,
  );
}

async function checkReady(url: string, appName: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      last = `${response.status} ${await response.text()}`;
      if (response.ok) {
        return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(1000);
  }
  throw new Error(`${appName} readyz failed: ${last}`);
}

async function postJson<T = unknown>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...runtimeHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      tenant_id: tenantId,
      user_id: userId,
    }),
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

async function poll<T>(fn: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) {
      return result;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function dockerCompose(args: string[]): Promise<void> {
  await runCommand(
    'docker',
    ['compose', ...composeFiles.flatMap((file) => ['-f', file]), ...args],
    { inherit: true },
  );
}

async function dockerComposeOutput(args: string[]): Promise<string> {
  return runCommand(
    'docker',
    ['compose', ...composeFiles.flatMap((file) => ['-f', file]), ...args],
    { inherit: false },
  );
}

async function runCommand(
  command: string,
  args: string[],
  options: { inherit: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${code}: ${stderr || stdout}`));
    });
  });
}

async function safeDiagnostics(db: Db, error: unknown): Promise<void> {
  console.error('smoke:pi-worker-crash-resume-e2e failed');
  console.error(error instanceof Error ? error.message : String(error));
  await printCommandSummary('docker compose ps', ['ps']);
  await printCommandSummary('runtime-worker logs', ['logs', '--tail', '120', 'runtime-worker']);
  await printCommandSummary('runtime-api logs', ['logs', '--tail', '120', 'runtime-api']);
  await printCommandSummary('tool-gateway logs', ['logs', '--tail', '120', 'tool-gateway']);
  await printCommandSummary('temporal logs', ['logs', '--tail', '120', 'temporal']);
  await printDbSummary(db);
}

async function printCommandSummary(label: string, args: string[]): Promise<void> {
  try {
    const output = await dockerComposeOutput(args);
    console.error(`--- ${label} ---`);
    console.error(redact(output));
  } catch (error) {
    console.error(
      `--- ${label} unavailable: ${error instanceof Error ? error.message : String(error)} ---`,
    );
  }
}

async function printDbSummary(db: Db): Promise<void> {
  try {
    const [taskRuns, agentRuns, agentSteps, humanTasks, snapshots, toolCalls, idempotency, audits] =
      await Promise.all([
        db
          .selectFrom('task_run')
          .select(['task_run_id', 'tenant_id', 'status', 'workflow_id', 'error_code'])
          .orderBy('created_at', 'desc')
          .limit(10)
          .execute(),
        db
          .selectFrom('agent_run')
          .select([
            'agent_run_id',
            'task_run_id',
            'status',
            'workflow_id',
            'workflow_run_id',
            'current_segment_index',
          ])
          .orderBy('created_at', 'desc')
          .limit(10)
          .execute(),
        db
          .selectFrom('agent_step')
          .select(['stable_step_key', 'agent_run_id', 'segment_status'])
          .orderBy('created_at', 'desc')
          .limit(20)
          .execute(),
        db
          .selectFrom('human_task')
          .select(['human_task_id', 'task_run_id', 'kind', 'status', 'workflow_id'])
          .orderBy('created_at', 'desc')
          .limit(20)
          .execute(),
        db
          .selectFrom('agent_context_snapshot')
          .select([
            'snapshot_id',
            'agent_run_id',
            'previous_snapshot_id',
            'snapshot_hash',
            'message_count',
            'byte_size',
          ])
          .orderBy('created_at', 'desc')
          .limit(20)
          .execute(),
        db
          .selectFrom('tool_call_log')
          .select([
            'tool_call_id',
            'task_run_id',
            'tool_name',
            'status',
            'mode',
            'idempotency_key',
            'output_hash',
          ])
          .orderBy('created_at', 'desc')
          .limit(20)
          .execute(),
        db
          .selectFrom('idempotency_record')
          .select(['idempotency_key', 'tenant_id', 'target_type', 'target_id', 'status'])
          .orderBy('created_at', 'desc')
          .limit(20)
          .execute(),
        db
          .selectFrom('audit_event')
          .select([
            'event_id',
            'tenant_id',
            'action',
            'target_type',
            'target_id',
            'result',
            'reason',
          ])
          .orderBy('occurred_at', 'desc')
          .limit(20)
          .execute(),
      ]);
    console.error('--- db summary ---');
    console.error(
      redact(
        JSON.stringify(
          {
            taskRuns,
            agentRuns,
            agentSteps,
            humanTasks,
            snapshots,
            toolCalls,
            idempotency,
            audits,
          },
          null,
          2,
        ),
      ),
    );
  } catch (error) {
    console.error(
      `db summary unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function authHeaders(requestIdValue: string): Record<string, string> {
  return {
    'x-user-id': userId,
    'x-tenant-id': tenantId,
    'x-roles': 'capability_operator',
    'x-request-id': requestIdValue,
  };
}

function agentToolGatewayStoreKey(input: {
  tenantId: string;
  toolName: string;
  operation: 'invoke' | 'preview' | 'commit';
  agentRunId: string;
  segmentIndex: number;
  callId: string;
  toolVersion: string;
}): string {
  const activityIdempotencyKey = [
    'agent',
    input.agentRunId,
    'segment',
    String(input.segmentIndex),
    'call',
    input.callId,
    input.operation,
  ].join(':');
  return [input.tenantId, input.toolName, input.operation, activityIdempotencyKey].join(':');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function assertNoDuplicate(values: string[], label: string): void {
  assert.equal(new Set(values).size, values.length, `${label} should not duplicate`);
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function usageFromJson(value: unknown): AgentStepRecord['usage'] {
  const usage = safeRecord(value);
  return {
    input_tokens: numberFromRecord(usage, 'input_tokens'),
    output_tokens: numberFromRecord(usage, 'output_tokens'),
    total_tokens: numberFromRecord(usage, 'total_tokens'),
    ...(typeof usage?.cache_read_tokens === 'number'
      ? { cache_read_tokens: usage.cache_read_tokens }
      : {}),
    ...(typeof usage?.cache_write_tokens === 'number'
      ? { cache_write_tokens: usage.cache_write_tokens }
      : {}),
    ...(typeof usage?.estimated_cost === 'number' ? { estimated_cost: usage.estimated_cost } : {}),
  };
}

function numberFromRecord(value: Record<string, unknown> | undefined, key: string): number {
  return typeof value?.[key] === 'number' ? value[key] : 0;
}

function countSubstring(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function optionalObject<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gu, 'Bearer [REDACTED]')
    .replace(/(TOKEN|SECRET|PASSWORD|API_KEY)=([^\s]+)/giu, '$1=[REDACTED]')
    .replace(/dev-only-[A-Za-z0-9_.-]+-token/gu, 'dev-only-[REDACTED]-token');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
