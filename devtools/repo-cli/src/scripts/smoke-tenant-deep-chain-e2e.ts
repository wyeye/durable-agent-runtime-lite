import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HumanTask, StandardResponse, TaskRun, TenantRuntimePolicy } from '@dar/contracts';
import { tenantRuntimePolicySchema } from '@dar/contracts';
import {
  AgentExecutionPlanRepository,
  AgentRunRepository,
  AgentStepRepository,
  AuditEventRepository,
  FlowDefinitionRepository,
  FlowExecutionPlanRepository,
  ModelPolicyRepository,
  RouteConfigRepository,
  TaskRunRepository,
  TenantAgentAdmissionRepository,
  TenantRuntimePolicyRepository,
  TenantRuntimePolicySnapshotRepository,
  ToolCallLogRepository,
  ToolManifestRepository,
  closeDb,
  createDb,
  hashJson,
  hashModelPolicy,
  hashTenantRuntimePolicy,
  sql,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import { ensureModelCatalogEntry } from './model-catalog-seed.js';

type Db = ReturnType<typeof createDb>;

const scenario = process.env.TENANT_DEEP_SMOKE_SCENARIO ?? 'flow_agent';
const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const runId = Date.now();
const tenantId = process.env.SMOKE_TENANT_ID ?? `tenant_deep_${scenario}_${runId}`;
const userId = process.env.SMOKE_USER_ID ?? 'tenant_deep_smoke_user';
const requestId = `tenant_deep_${scenario}_${runId}`;
const runtimeHeaders = authHeaders(`${requestId}_runtime`);
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const handoffPlanId = `plan_handoff_${safeId(tenantId)}`;
const handoffPlanRef = `db://flow-execution-plan/${handoffPlanId}`;

async function main(): Promise<void> {
  const db = createDb({ databaseUrl });
  try {
    if (scenario === 'flow_agent') {
      await runFlowAgentScenario(db);
      return;
    }
    if (scenario === 'handoff_lineage') {
      await runHandoffLineageScenario(db);
      return;
    }
    if (scenario === 'policy_crash_snapshot') {
      await runPolicyCrashSnapshotScenario(db);
      return;
    }
    if (scenario === 'admission_reconcile') {
      await runAdmissionReconcileScenario(db);
      return;
    }
    throw new Error(`Unknown TENANT_DEEP_SMOKE_SCENARIO: ${scenario}`);
  } finally {
    await closeDb(db);
  }
}

async function runFlowAgentScenario(db: Db): Promise<void> {
  const flowPlan = await seedFlowAgentFixtures(db, 'readonly_tool');
  await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');
  const task = await postJson<{
    task_run_id: string;
    workflow_id: string;
    workflow_start?: { started: boolean; mode: string; run_id?: string };
  }>(`${runtimeApiUrl}/v1/tasks`, {
    tenant_id: tenantId,
    user_id: userId,
    request_id: `${requestId}_task`,
    input: { text: 'tenant-flow-agent-e2e durable target route' },
  });
  assert.equal(task.workflow_start?.started, true);
  assert.equal(task.workflow_start?.mode, 'temporal');

  const finalTask = await pollTask(db, task.task_run_id);
  assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'Flow -> Agent -> Tool smoke should complete');
  assert.equal(finalTask.execution_plan_ref, flowPlan.execution_plan_ref);
  assert.ok(finalTask.tenant_policy_snapshot_ref, 'TaskRun should store root tenant policy snapshot');
  assert.ok(finalTask.tenant_admission_id, 'Flow with agent step should reserve an admission');

  const rootSnapshot = await requireSnapshot(db, finalTask.tenant_policy_snapshot_ref, 'root');
  assert.equal(rootSnapshot.execution_plan_ref, flowPlan.execution_plan_ref);
  assert.equal(rootSnapshot.derivation_type, 'root');
  assert.equal(rootSnapshot.root_snapshot_ref, rootSnapshot.snapshot_ref);
  assert.equal(rootSnapshot.lineage_depth, 0);

  const childSnapshots = await new TenantRuntimePolicySnapshotRepository(db).listByTenant(tenantId, {
    rootSnapshotRef: rootSnapshot.snapshot_ref,
    derivationType: 'flow_agent_child',
    limit: 20,
  });
  assert.equal(childSnapshots.length, 1, 'Flow agent step should derive one child snapshot');
  const childSnapshot = childSnapshots[0]!;
  assert.equal(childSnapshot.parent_snapshot_ref, rootSnapshot.snapshot_ref);
  assert.equal(childSnapshot.source_policy_version, rootSnapshot.source_policy_version);
  assert.equal(childSnapshot.source_policy_hash, rootSnapshot.source_policy_hash);
  assert.equal(childSnapshot.lineage_depth, 1);

  const agentRuns = await new AgentRunRepository(db).list({ tenantId, taskRunId: finalTask.task_run_id, limit: 10 });
  assert.equal(agentRuns.length, 1, 'Flow should create one child AgentRun');
  assert.equal(agentRuns[0]!.tenant_policy_snapshot_ref, childSnapshot.snapshot_ref);
  assert.equal(agentRuns[0]!.tenant_policy_hash, childSnapshot.snapshot_hash);
  assert.equal(agentRuns[0]!.status, 'completed');

  const toolCalls = await new ToolCallLogRepository(db).list({
    tenantId,
    taskRunId: finalTask.task_run_id,
    toolName: 'knowledge.search',
    limit: 20,
  });
  assert.ok(toolCalls.some((call) => call.status === 'committed'), 'Tool Gateway should execute knowledge.search');
  assert.ok(toolCalls.every((call) => Boolean(call.tenant_policy_snapshot_ref)), 'Tool calls should carry policy snapshot refs');

  const admission = await new TenantAgentAdmissionRepository(db).get(finalTask.tenant_admission_id);
  assert.equal(admission?.status, 'released');
  assert.equal(admission?.policy_snapshot_ref, rootSnapshot.snapshot_ref);

  const taskAudits = await new AuditEventRepository(db).list({
    tenantId,
    taskRunId: finalTask.task_run_id,
    limit: 100,
  });
  const policyAudits = await new AuditEventRepository(db).list({
    tenantId,
    targetType: 'tenant_runtime_policy',
    targetId: tenantId,
    limit: 100,
  });
  const audits = [...taskAudits, ...policyAudits];
  assert.ok(
    policyAudits.some((event) =>
      event.action === 'policy.snapshot.created'
      && payloadField(event.payload, 'policy_snapshot_ref') === rootSnapshot.snapshot_ref),
    'Tenant policy audit should record root snapshot creation',
  );
  assert.ok(
    policyAudits.some((event) =>
      event.action === 'policy.snapshot.derived'
      && payloadField(event.payload, 'policy_snapshot_ref') === childSnapshot.snapshot_ref),
    'Tenant policy audit should record child snapshot derivation',
  );
  assert.ok(taskAudits.some((event) => event.action === 'tool.invoke'));
  assert.ok(audits.every((event) => !JSON.stringify(event.payload).toLowerCase().includes('authorization')));

  console.log(JSON.stringify({
    ok: true,
    scenario,
    task_run_id: finalTask.task_run_id,
    workflow_id: finalTask.workflow_id,
    root_snapshot_ref: rootSnapshot.snapshot_ref,
    child_snapshot_ref: childSnapshot.snapshot_ref,
    agent_run_id: agentRuns[0]!.agent_run_id,
    admission_id: admission?.admission_id,
    tool_call_count: toolCalls.length,
  }, null, 2));
}

async function runHandoffLineageScenario(db: Db): Promise<void> {
  await seedHandoffTarget(db);
  await ensurePolicyAllowsHandoff(db, tenantId);
  await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');
  const task = await postJson<{ task_run_id: string; workflow_id: string }>(`${runtimeApiUrl}/v1/agent-tasks`, {
    tenant_id: tenantId,
    user_id: userId,
    request_id: `${requestId}_handoff_task`,
    agent_execution_plan_ref: await seedHandoffAgentPlan(db),
    input: { text: `tenant-handoff-lineage-e2e handoff_ref:${handoffPlanRef}` },
  });
  const finalTask = await pollTask(db, task.task_run_id);
  assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'Handoff lineage smoke should complete');
  assert.ok(finalTask.tenant_policy_snapshot_ref);
  const rootSnapshot = await requireSnapshot(db, finalTask.tenant_policy_snapshot_ref, 'root');
  const handoffSnapshots = await new TenantRuntimePolicySnapshotRepository(db).listByTenant(tenantId, {
    rootSnapshotRef: rootSnapshot.snapshot_ref,
    derivationType: 'workflow_handoff',
    limit: 20,
  });
  assert.ok(handoffSnapshots.length >= 1, 'Handoff should derive workflow_handoff snapshot');
  for (const snapshot of handoffSnapshots) {
    assert.equal(snapshot.parent_snapshot_ref, rootSnapshot.snapshot_ref);
    assert.equal(snapshot.source_policy_hash, rootSnapshot.source_policy_hash);
    assert.equal(snapshot.lineage_depth, rootSnapshot.lineage_depth + 1);
  }
  const agentRuns = await new AgentRunRepository(db).list({ tenantId, taskRunId: finalTask.task_run_id, limit: 10 });
  const steps = agentRuns[0]
    ? await new AgentStepRepository(db).listByRun(agentRuns[0].agent_run_id, { limit: 20 })
    : [];
  assert.ok(steps.some((step) => step.handoff_refs.length > 0), 'AgentStep should record handoff refs');

  console.log(JSON.stringify({
    ok: true,
    scenario,
    task_run_id: finalTask.task_run_id,
    root_snapshot_ref: rootSnapshot.snapshot_ref,
    handoff_snapshot_refs: handoffSnapshots.map((snapshot) => snapshot.snapshot_ref),
  }, null, 2));
}

async function runPolicyCrashSnapshotScenario(db: Db): Promise<void> {
  await seedTools(db);
  await ensureTenantPolicy(db, tenantId, {
    allowedModels: ['model_gateway:user_input', 'model_gateway:l3_tool'],
    allowedToolNames: ['knowledge.search', 'record.write.mock'],
    maxConcurrentAgentRuns: 2,
  });
  await runCommand('corepack', ['pnpm', 'dar', 'smoke', 'run', 'worker-crash-resume'], {
    SMOKE_TENANT_ID: tenantId,
    SMOKE_USER_ID: userId,
    DATABASE_URL: databaseUrl,
    EVALUATION_WORKER_ENABLED: process.env.EVALUATION_WORKER_ENABLED ?? 'true',
  });
  const snapshots = await new TenantRuntimePolicySnapshotRepository(db).listByTenant(tenantId, { limit: 50 });
  assert.ok(snapshots.length >= 2, 'Crash smoke should leave tenant policy snapshots for need_user and L3 paths');
  const taskRuns = await new TaskRunRepository(db).list({ tenantId, limit: 20 });
  const crashTasks = taskRuns.filter((task) => task.user_id === userId && task.tenant_policy_snapshot_ref);
  assert.ok(crashTasks.length >= 2, 'Crash smoke should create policy-locked TaskRun rows');
  const snapshotByRef = new Map(snapshots.map((snapshot) => [snapshot.snapshot_ref, snapshot]));
  const referencedSnapshots = crashTasks.map((task) => {
    assert.ok(task.tenant_policy_snapshot_ref, 'Crash TaskRun should store a tenant policy snapshot ref');
    assert.ok(task.tenant_policy_hash, 'Crash TaskRun should store a tenant policy hash');
    const snapshot = snapshotByRef.get(task.tenant_policy_snapshot_ref);
    assert.ok(snapshot, 'Crash TaskRun snapshot ref should resolve to an immutable snapshot');
    assert.equal(snapshot.snapshot_hash, task.tenant_policy_hash);
    return snapshot;
  });
  const latestPolicy = await new TenantRuntimePolicyRepository(db).getLatestPublished(tenantId);
  assert.ok(latestPolicy, 'Crash smoke tenant should keep a latest published tenant policy');
  assert.ok(
    referencedSnapshots.every((snapshot) => snapshot.source_policy_version <= latestPolicy.version),
    'Crash TaskRun snapshots should come from current or earlier policy versions',
  );
  assert.ok(
    referencedSnapshots.some((snapshot) => snapshot.source_policy_version < latestPolicy.version),
    'Crash smoke tasks must stay locked to their original snapshots after later policy versions are published',
  );
  console.log(JSON.stringify({
    ok: true,
    scenario,
    locked_snapshot_refs: crashTasks.map((task) => task.tenant_policy_snapshot_ref),
    source_policy_versions: [...new Set(referencedSnapshots.map((snapshot) => snapshot.source_policy_version))],
    latest_policy_version: latestPolicy.version,
  }, null, 2));
}

async function runAdmissionReconcileScenario(db: Db): Promise<void> {
  await seedFlowAgentFixtures(db, 'need_user');
  await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');
  const openTask = await postJson<{ task_run_id: string }>(`${runtimeApiUrl}/v1/tasks`, {
    tenant_id: tenantId,
    user_id: userId,
    request_id: `${requestId}_open`,
    input: { text: 'tenant-flow-agent-e2e durable target route' },
  });
  const openTaskRun = await pollTask(db, openTask.task_run_id, { stopWhenAdmissionReserved: true });
  assert.ok(openTaskRun.tenant_admission_id, 'Open task should reserve admission');
  await runReconcileCli(['--tenant-id', tenantId, '--batch-size', '20', '--stale-after-ms', '1']);
  const stillOpen = await new TenantAgentAdmissionRepository(db).get(openTaskRun.tenant_admission_id);
  assert.ok(stillOpen?.status === 'reserved' || stillOpen?.status === 'active', 'Open workflow admission must not be reconciled');

  const orphan = await createTerminalOrphanAdmission(db);
  const dryRun = await runReconcileCli(['--tenant-id', tenantId, '--batch-size', '20', '--stale-after-ms', '1']);
  assert.equal(dryRun.ok, true);
  const dryRunItems = Array.isArray(dryRun.items) ? dryRun.items as Array<{ admission_id?: string; action?: string }> : [];
  assert.ok(dryRunItems.some((item) =>
    item.admission_id === orphan.admission_id && item.action === 'would_reconcile'));
  assert.equal((await new TenantAgentAdmissionRepository(db).get(orphan.admission_id))?.status, 'active');

  const applied = await runReconcileCli(['--apply', '--tenant-id', tenantId, '--batch-size', '20', '--stale-after-ms', '1']);
  assert.equal(applied.ok, true);
  assert.equal((await new TenantAgentAdmissionRepository(db).get(orphan.admission_id))?.status, 'reconciled');
  const second = await runReconcileCli(['--apply', '--tenant-id', tenantId, '--batch-size', '20', '--stale-after-ms', '1']);
  assert.equal(second.ok, true);
  const events = await new AuditEventRepository(db).list({
    tenantId,
    targetType: 'tenant_agent_admission',
    targetId: orphan.admission_id,
    action: 'agent.admission.reconciled',
    limit: 20,
  });
  assert.equal(events.length, 1, 'Reconcile audit should be idempotent');

  console.log(JSON.stringify({
    ok: true,
    scenario,
    open_admission_id: openTaskRun.tenant_admission_id,
    reconciled_admission_id: orphan.admission_id,
    audit_events: events.length,
    second_apply_checked: second.checked,
  }, null, 2));
}

async function seedFlowAgentFixtures(db: Db, agentScenario: 'readonly_tool' | 'need_user') {
  await seedTools(db);
  await ensureTenantPolicy(db, tenantId, {
    allowedModels: [`deterministic:${agentScenario}`],
    allowedToolNames: ['knowledge.search'],
    maxConcurrentAgentRuns: 2,
  });
  const promptId = `tenant_deep_prompt_${agentScenario}`;
  const agentId = `tenant_deep_agent_${agentScenario}`;
  const flowId = `tenant_deep_flow_${agentScenario}`;
  const modelPolicy = `deterministic:${agentScenario}`;
  const publishedModelPolicy = await seedModelPolicy(
    db,
    `tenant_deep_model_${agentScenario}`,
    modelPolicy,
  );
  const modelPolicyHash = hashModelPolicy(publishedModelPolicy);
  await upsertPromptDefinition(db, {
    prompt_id: promptId,
    version: 1,
    name: `Tenant deep prompt ${agentScenario}`,
    content: `Tenant deep smoke scenario ${agentScenario}.`,
    variables: [],
    status: 'published',
  }, { tenantId, status: 'published', createdBy: 'tenant-deep-smoke' });
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
    allowed_tools: ['knowledge.search@1.0.0'],
    allowed_handoffs: [],
    max_steps: 4,
    max_tokens: 2000,
    output_schema: 'tenant_deep_result_v1',
    status: 'published',
  }, { tenantId, status: 'published', createdBy: 'tenant-deep-smoke' });
  await new FlowDefinitionRepository(db).upsert({
    flow_id: flowId,
    version: 1,
    name: `Tenant deep flow ${agentScenario}`,
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    steps: [
      { id: 'normalize', type: 'activity', activity: 'input.normalize' },
      { id: 'agent_step', type: 'agent', agent_id: agentId, input: { agent_version: 1 } },
    ],
    status: 'published',
  }, { tenantId, status: 'published', createdBy: 'tenant-deep-smoke' });
  await new RouteConfigRepository(db).upsert({
    route_id: `tenant_deep_route_${agentScenario}`,
    flow_id: flowId,
    version: 1,
    status: 'published',
    route: {
      priority: 100,
      keywords: ['tenant-flow-agent-e2e'],
      examples: ['tenant-flow-agent-e2e durable target route'],
      negative_examples: [],
      supported_channels: ['api', 'web'],
      role_constraints: [],
      confidence_threshold: 0.5,
      ambiguous_threshold: 0.3,
    },
  }, { tenantId, status: 'published', createdBy: 'tenant-deep-smoke' });
  return new FlowExecutionPlanRepository(db).createForFlow({
    tenantId,
    flowId,
    flowVersion: 1,
    operatorId: 'tenant-deep-smoke',
  });
}

async function seedHandoffAgentPlan(db: Db): Promise<string> {
  await seedTools(db);
  await ensurePolicyAllowsHandoff(db, tenantId);
  const promptId = 'tenant_deep_handoff_prompt';
  const agentId = 'tenant_deep_handoff_agent';
  const modelPolicy = 'deterministic:handoff';
  const publishedModelPolicy = await seedModelPolicy(db, 'tenant_deep_model_handoff', modelPolicy);
  const modelPolicyHash = hashModelPolicy(publishedModelPolicy);
  await upsertPromptDefinition(db, {
    prompt_id: promptId,
    version: 1,
    name: 'Tenant deep handoff prompt',
    content: 'Tenant deep handoff smoke.',
    variables: [],
    status: 'published',
  }, { tenantId, status: 'published', createdBy: 'tenant-deep-smoke' });
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
    allowed_tools: ['knowledge.search@1.0.0'],
    allowed_handoffs: [handoffPlanRef],
    max_steps: 4,
    max_tokens: 2000,
    output_schema: 'tenant_deep_handoff_result_v1',
    status: 'published',
  }, { tenantId, status: 'published', createdBy: 'tenant-deep-smoke' });
  const plan = await new AgentExecutionPlanRepository(db).createForAgent({
    tenantId,
    agentId,
    agentVersion: 1,
    operatorId: 'tenant-deep-smoke',
  });
  return plan.execution_plan_ref;
}

async function seedModelPolicy(db: Db, modelPolicyId: string, displayPolicy: string) {
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
    operatorId: 'tenant-deep-smoke',
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
    { tenantId, operatorId: 'tenant-deep-smoke' },
  );
  return repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId: 'tenant-deep-smoke',
    releaseNote: `tenant deep smoke ${displayPolicy}`,
  });
}

async function ensurePolicyAllowsHandoff(db: Db, tenantIdValue: string): Promise<void> {
  await ensureTenantPolicy(db, tenantIdValue, {
    allowedModels: ['deterministic:handoff', 'deterministic:final_only'],
    allowedToolNames: ['knowledge.search'],
    allowedHandoffs: [handoffPlanRef],
    maxConcurrentAgentRuns: 2,
  });
}

async function ensureTenantPolicy(
  db: Db,
  tenantIdValue: string,
  options: { allowedModels: string[]; allowedToolNames: string[]; allowedHandoffs?: string[]; maxConcurrentAgentRuns: number },
): Promise<TenantRuntimePolicy> {
  const repository = new TenantRuntimePolicyRepository(db);
  const existing = await repository.getLatestPublished(tenantIdValue);
  if (existing) {
    return existing;
  }
  const policy = tenantRuntimePolicySchema.parse({
    tenant_id: tenantIdValue,
    version: 1,
    status: 'draft',
    allowed_tools: options.allowedToolNames.map((toolName) => ({
      tool_name: toolName,
      versions: ['1.0.0'],
      allowed_operations: toolName === 'record.write.mock' ? ['preview', 'commit'] : ['invoke', 'preview', 'commit'],
      max_risk_level: toolName === 'record.write.mock' ? 'L3' : 'L1',
    })),
    denied_tools: [],
    allowed_models: options.allowedModels.map((model_id) => ({ model_id })),
    denied_models: [],
    allowed_handoffs: (options.allowedHandoffs ?? []).map((ref) => ({
      flow_id: ref,
      execution_plan_refs: [ref],
    })),
    denied_handoffs: [],
    budget_cap: {
      max_segments: 6,
      max_model_turns: 12,
      max_tool_calls: 6,
      max_total_tokens: 12000,
      max_duration_ms: 600000,
      max_handoffs: 2,
      max_context_bytes: 524288,
    },
    max_concurrent_agent_runs: options.maxConcurrentAgentRuns,
  });
  await repository.createDraft(policy, { tenantId: tenantIdValue, operatorId: 'tenant-deep-smoke' });
  return repository.publish(tenantIdValue, policy.version, {
    tenantId: tenantIdValue,
    operatorId: 'tenant-deep-smoke',
    releaseNote: 'tenant deep smoke policy',
  });
}

async function seedTools(db: Db): Promise<void> {
  const knowledge = JSON.parse(await readFile(new URL('../../../../examples/tools/knowledge-search-tool.json', import.meta.url), 'utf8'));
  const recordWrite = JSON.parse(await readFile(new URL('../../../../examples/tools/record-write-mock-tool.json', import.meta.url), 'utf8'));
  await new ToolManifestRepository(db).upsert(knowledge, {
    tenantId,
    status: 'published',
    createdBy: 'tenant-deep-smoke',
  });
  await new ToolManifestRepository(db).upsert(recordWrite, {
    tenantId,
    status: 'published',
    createdBy: 'tenant-deep-smoke',
  });
}

async function seedHandoffTarget(db: Db): Promise<void> {
  const flow = {
    flow_id: 'tenant_deep_handoff_target',
    version: 1,
    name: 'Tenant deep handoff target',
    runtime: { workflow_type: 'ConfigDrivenWorkflow' as const, task_queue: 'runtime-worker-main' },
    steps: [{ id: 'normalize', type: 'activity' as const, activity: 'input.normalize' }],
    status: 'published' as const,
  };
  await new FlowDefinitionRepository(db).upsert(flow, { tenantId, status: 'published', createdBy: 'tenant-deep-smoke' });
  const planWithoutHash = {
    execution_plan_id: handoffPlanId,
    execution_plan_ref: handoffPlanRef,
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
      plan_json: plan,
      execution_plan_hash: plan.execution_plan_hash,
      generated_at: plan.generated_at,
    })
    .onConflict((oc) => oc.column('execution_plan_ref').doNothing())
    .execute();
}

function safeId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, '_')
      .replace(/^_+|_+$/gu, '')
      .slice(0, 40) || 'tenant'
  );
}

async function createTerminalOrphanAdmission(db: Db) {
  const taskRunId = `tenant_deep_orphan_task_${Date.now()}`;
  const plan = await seedFlowAgentFixtures(db, 'readonly_tool');
  const policy = await new TenantRuntimePolicyRepository(db).getLatestPublished(tenantId);
  assert.ok(policy);
  const rootSnapshot = await new TenantRuntimePolicySnapshotRepository(db).createImmutableSnapshot({
    tenantId,
    policy,
    policyHash: hashTenantRuntimePolicy(policy),
    executionPlanRef: plan.execution_plan_ref,
    executionPlanHash: plan.execution_plan_hash,
    executionPlanType: 'flow',
    resolvedPolicy: {
      resolved_allowed_tools: [{
        tool_name: 'knowledge.search',
        versions: ['1.0.0'],
        allowed_operations: ['invoke'],
        max_risk_level: 'L1',
      }],
      resolved_denied_tools: [],
      resolved_allowed_models: [{ model_id: 'deterministic:readonly_tool' }],
      resolved_allowed_handoffs: [],
      resolved_budget: {
        max_segments: 4,
        max_model_turns: 4,
        max_tool_calls: 2,
        max_input_tokens: 8000,
        max_output_tokens: 8000,
        max_total_tokens: 12000,
        max_duration_ms: 600000,
        max_handoffs: 0,
        max_context_bytes: 524288,
      },
      max_concurrent_agent_runs: 2,
    },
  });
  await new TaskRunRepository(db).create({
    taskRun: {
      task_run_id: taskRunId,
      tenant_id: tenantId,
      user_id: userId,
      route_type: 'matched',
      flow_id: plan.flow_id,
      flow_version: plan.flow_version,
      workflow_id: `missing-${taskRunId}`,
      execution_plan_ref: plan.execution_plan_ref,
      tenant_policy_snapshot_ref: rootSnapshot.snapshot_ref,
      tenant_policy_hash: rootSnapshot.snapshot_hash,
      status: 'completed',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    input: { text: 'orphan admission' },
    routeResult: {
      route_decision: { decision: 'matched', flow_id: plan.flow_id, flow_version: plan.flow_version, confidence: 1, slots: {} },
      candidates: [],
    },
  });
  const reserved = await new TenantAgentAdmissionRepository(db).reserve({
    tenantId,
    taskRunId,
    policySnapshotRef: rootSnapshot.snapshot_ref,
    maxConcurrentAgentRuns: 2,
  });
  assert.ok(reserved.admission);
  await new TenantAgentAdmissionRepository(db).activate(reserved.admission.admission_id, {
    workflowId: `missing-${taskRunId}`,
  });
  await sql`update tenant_agent_admission set acquired_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' where admission_id = ${reserved.admission.admission_id}`.execute(db);
  return reserved.admission;
}

async function requireSnapshot(db: Db, ref: string | undefined, expectedDerivation: string) {
  assert.ok(ref, `Expected ${expectedDerivation} snapshot ref`);
  const snapshot = await new TenantRuntimePolicySnapshotRepository(db).getByRef(ref, { tenantId });
  assert.ok(snapshot, `Snapshot ${ref} should exist`);
  return snapshot;
}

async function pollTask(db: Db, taskRunId: string, options: { stopWhenAdmissionReserved?: boolean } = {}): Promise<TaskRun> {
  const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000);
  const handledTasks = new Set<string>();
  let lastTask: TaskRun | undefined;
  while (Date.now() < deadline) {
    if (!options.stopWhenAdmissionReserved) {
      await resolvePendingHumanTasks(taskRunId, handledTasks);
    }
    lastTask = await new TaskRunRepository(db).get(taskRunId);
    if (lastTask && (lastTask.status === 'completed' || lastTask.status === 'failed')) {
      return lastTask;
    }
    if (options.stopWhenAdmissionReserved && lastTask?.tenant_admission_id) {
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
        response: { value: 'provided by tenant deep smoke' },
      });
    } else {
      await postJson(`${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(task.human_task_id)}/approve`, {
        tenant_id: tenantId,
        user_id: userId,
        request_id: `${requestId}_approve_${task.human_task_id}`,
        decision_reason: 'Tenant deep smoke approval',
        payload: { scenario },
      });
    }
    handledTasks.add(task.human_task_id);
  }
}

async function runReconcileCli(args: string[]): Promise<Record<string, unknown>> {
  const result = await runCommand(process.execPath, ['--import', 'tsx', 'devtools/repo-cli/src/scripts/reconcile-tenant-agent-admissions.ts', ...args], {
    DATABASE_URL: databaseUrl,
  });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function runCommand(
  command: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${exitCode} ${redact(stderr)}`);
  }
  return { stdout, stderr };
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

function payloadField(payload: unknown, field: string): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  return (payload as Record<string, unknown>)[field];
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/gu, 'Bearer [REDACTED]')
    .replace(/(TOKEN|SECRET|PASSWORD|API_KEY)=([^\s]+)/giu, '$1=[REDACTED]')
    .replace(/dev-only-[A-Za-z0-9_.-]+-token/gu, 'dev-only-[REDACTED]-token');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? redact(error.message) : 'unknown error';
  console.error(JSON.stringify({
    ok: false,
    scenario,
    error: 'tenant deep chain smoke failed',
    code: error instanceof Error ? error.name : 'UNKNOWN',
    message,
  }, null, 2));
  process.exit(1);
});
