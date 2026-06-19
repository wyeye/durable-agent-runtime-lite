import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HumanTask, StandardResponse, TaskRun } from '@dar/contracts';
import { closeDb, createDb, sql } from '@dar/db';

type DbClient = ReturnType<typeof createDb>;

const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const toolGatewayUrl = trimTrailingSlash(process.env.TOOL_GATEWAY_URL ?? 'http://localhost:3200');
const runtimeWorkerUrl = trimTrailingSlash(process.env.RUNTIME_WORKER_URL ?? 'http://localhost:3300');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const tenantId = process.env.SMOKE_TENANT_ID ?? 'default';
const userId = process.env.SMOKE_USER_ID ?? 'smoke_user';
const requestId = `smoke_temporal_db_${Date.now()}`;
const smokeText = 'db-smoke 真实链路验证';
const runtimeHeaders = authHeaders(`${requestId}_runtime`);

interface RunTaskData {
  task_run_id: string;
  workflow_id: string;
  status: string;
  route_decision: {
    decision: string;
    flow_id?: string;
    flow_version?: number;
  };
  workflow_start?: {
    started: boolean;
    mode: string;
    run_id?: string;
  };
  flow_id?: string;
  flow_version?: number;
}

interface AuditRow {
  event_id: string;
  action: string;
  target_type: string;
  target_id: string;
  result: string;
  reason: string | null;
  payload: unknown;
  occurred_at: Date;
}

interface HumanTaskListData {
  human_tasks: HumanTask[];
}

interface HumanTaskDecisionData {
  human_task: HumanTask;
  audit_event_id?: string;
}

interface HumanTaskRow {
  human_task_id: string;
  task_run_id: string;
  status: string;
  payload: unknown;
  decision: unknown;
  decided_by: string | null;
  decision_reason: string | null;
}

interface ToolCallLogRow {
  tool_call_id: string;
  task_run_id: string | null;
  tool_name: string;
  status: string;
  mode: string | null;
  policy_decision: string;
  idempotency_key: string | null;
}

interface IdempotencyRow {
  idempotency_key: string;
  target_type: string;
  target_id: string;
  status: string;
}

async function main(): Promise<void> {
  let taskRunId: string | undefined;
  let workflowId: string | undefined;
  const db = createDb({ databaseUrl });

  try {
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');
    await checkHealth(`${toolGatewayUrl}/healthz`, 'tool-gateway');
    await checkHealth(`${runtimeWorkerUrl}/healthz`, 'runtime-worker');

    const preview = await postJson<{
      route_decision: { decision: string; flow_id?: string; flow_version?: number };
      candidates: Array<{ flow_id: string; version: number; score: number }>;
    }>(`${runtimeApiUrl}/v1/router/preview`, {
      tenant_id: tenantId,
      user_id: userId,
      request_id: `${requestId}_preview`,
      input: { text: smokeText },
    });

    assert.equal(preview.route_decision.decision, 'matched');
    assert.equal(preview.route_decision.flow_id, 'sample_flow');
    assert.equal(preview.route_decision.flow_version, 1);
    assert.ok(
      preview.candidates.some((candidate) => candidate.flow_id === 'sample_flow' && candidate.version === 1),
      'preview should include DB-seeded sample_flow candidate',
    );

    const task = await postJson<RunTaskData>(`${runtimeApiUrl}/v1/tasks`, {
      tenant_id: tenantId,
      user_id: userId,
      request_id: `${requestId}_task`,
      input: { text: smokeText },
    });
    taskRunId = task.task_run_id;
    workflowId = task.workflow_id;

    assert.ok(taskRunId, 'runtime-api should return task_run_id');
    assert.ok(workflowId, 'runtime-api should return workflow_id');
    assert.equal(task.workflow_start?.mode, 'temporal');
    assert.equal(task.workflow_start?.started, true);
    assert.equal(task.flow_id, 'sample_flow');
    assert.equal(task.flow_version, 1);

    const finalTask = await pollTaskAndApprove(taskRunId);
    assert.ok(['completed', 'failed'].includes(finalTask.status), `unexpected final task status: ${finalTask.status}`);
    assert.equal(finalTask.status, 'completed', finalTask.error_message ?? 'workflow should complete');

    const dbTaskRun = await loadTaskRun(db, taskRunId);
    assert.ok(dbTaskRun, 'task_run should exist in DB');
    assert.equal(dbTaskRun.status, 'completed');
    assert.equal(dbTaskRun.workflow_id, workflowId);
    assert.equal(dbTaskRun.flow_id, 'sample_flow');
    assert.equal(dbTaskRun.flow_version, 1);

    const auditEvents = await loadRecentAuditEvents(db, taskRunId);
    assert.ok(
      auditEvents.some((event) => event.target_id === 'knowledge.search' || event.target_id === 'record.write.mock'),
      'audit_event should include tool-gateway tool invocation',
    );
    assert.ok(
      auditEvents.some((event) => event.action === 'tool.preview' && event.target_id === 'record.write.mock'),
      'audit_event should include L3 tool preview',
    );
    assert.ok(
      auditEvents.some((event) => event.action === 'human_task.approve' && event.target_type === 'human_task'),
      'audit_event should include human approval',
    );
    assert.ok(
      auditEvents.some((event) => event.action === 'tool.commit' && event.target_id === 'record.write.mock'),
      'audit_event should include L3 tool commit',
    );

    const humanTasks = await loadHumanTasks(db, taskRunId);
    assert.ok(
      humanTasks.some((task) => task.status === 'approved'),
      'human_task should be approved during smoke',
    );

    const toolCallLogs = await loadToolCallLogs(db, taskRunId);
    assert.ok(
      toolCallLogs.some((log) => log.tool_name === 'record.write.mock' && log.status === 'committed'),
      'tool_call_log should mark L3 record.write.mock as committed',
    );

    const idempotencyRecords = await loadIdempotencyRecords(db, taskRunId);
    assert.ok(
      idempotencyRecords.some(
        (record) => record.target_id === 'knowledge.search' || record.target_id === 'record.write.mock',
      ),
      'idempotency_record should include tool invocation record',
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          task_run_id: taskRunId,
          workflow_id: workflowId,
          status: dbTaskRun.status,
          audit_events: auditEvents.map((event) => ({
            event_id: event.event_id,
            action: event.action,
            target_id: event.target_id,
            result: event.result,
            reason: event.reason,
          })),
          human_tasks: humanTasks.map((task) => ({
            human_task_id: task.human_task_id,
            status: task.status,
            decided_by: task.decided_by,
            decision_reason: task.decision_reason,
          })),
          tool_call_logs: toolCallLogs.map((log) => ({
            tool_call_id: log.tool_call_id,
            tool_name: log.tool_name,
            status: log.status,
            mode: log.mode,
            policy_decision: log.policy_decision,
          })),
          idempotency_records: idempotencyRecords.map((record) => ({
            idempotency_key: record.idempotency_key,
            target_id: record.target_id,
            status: record.status,
          })),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await reportFailure(db, { taskRunId, workflowId, error });
    process.exitCode = 1;
  } finally {
    await closeDb(db);
  }
}

async function checkHealth(url: string, appName: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${appName} healthz failed: ${response.status} ${await response.text()}`);
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
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

async function pollTaskAndApprove(taskRunId: string): Promise<TaskRun> {
  const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);
  let lastTaskRun: TaskRun | undefined;
  const approvedHumanTaskIds = new Set<string>();

  while (Date.now() < deadline) {
    lastTaskRun = await getJson<TaskRun>(`${runtimeApiUrl}/v1/tasks/${encodeURIComponent(taskRunId)}`);
    await approvePendingHumanTasks(taskRunId, approvedHumanTaskIds);
    if (lastTaskRun.status === 'completed' || lastTaskRun.status === 'failed') {
      return lastTaskRun;
    }
    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for task_run ${taskRunId}; last status=${lastTaskRun?.status ?? 'unknown'}`);
}

async function approvePendingHumanTasks(taskRunId: string, approvedHumanTaskIds: Set<string>): Promise<void> {
  const params = new URLSearchParams({
    tenant_id: tenantId,
    user_id: userId,
    task_run_id: taskRunId,
    status: 'pending',
  });
  const list = await getJson<HumanTaskListData>(`${runtimeApiUrl}/v1/human-tasks?${params.toString()}`);
  for (const humanTask of list.human_tasks) {
    if (approvedHumanTaskIds.has(humanTask.human_task_id)) {
      continue;
    }
    const decision = await postJson<HumanTaskDecisionData>(
      `${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(humanTask.human_task_id)}/approve`,
      {
        tenant_id: tenantId,
        user_id: userId,
        request_id: `${requestId}_approve_${humanTask.human_task_id}`,
        decision_reason: 'smoke L3 approval',
        payload: { smoke: true, task_run_id: taskRunId },
      },
    );
    assert.equal(decision.human_task.status, 'approved');
    approvedHumanTaskIds.add(humanTask.human_task_id);
  }
}

async function loadTaskRun(db: DbClient, taskRunId: string): Promise<TaskRun | undefined> {
  return db
    .selectFrom('task_run')
    .select([
      'task_run_id',
      'tenant_id',
      'user_id',
      'route_type',
      'flow_id',
      'flow_version',
      'workflow_id',
      'status',
      'error_code',
      'error_message',
      'created_at',
      'updated_at',
    ])
    .where('task_run_id', '=', taskRunId)
    .executeTakeFirst() as Promise<TaskRun | undefined>;
}

async function loadRecentAuditEvents(db: DbClient, taskRunId?: string): Promise<AuditRow[]> {
  let query = db
    .selectFrom('audit_event')
    .select(['event_id', 'action', 'target_type', 'target_id', 'result', 'reason', 'payload', 'occurred_at'])
    .where('tenant_id', '=', tenantId);

  if (taskRunId) {
    query = query.where(sql<boolean>`payload ->> 'task_run_id' = ${taskRunId}`);
  }

  return query.orderBy('occurred_at', 'desc').limit(20).execute() as Promise<AuditRow[]>;
}

async function loadHumanTasks(db: DbClient, taskRunId: string): Promise<HumanTaskRow[]> {
  return db
    .selectFrom('human_task')
    .select([
      'human_task_id',
      'task_run_id',
      'status',
      'payload',
      'decision',
      'decided_by',
      'decision_reason',
    ])
    .where('tenant_id', '=', tenantId)
    .where('task_run_id', '=', taskRunId)
    .orderBy('created_at', 'asc')
    .execute() as Promise<HumanTaskRow[]>;
}

async function loadToolCallLogs(db: DbClient, taskRunId: string): Promise<ToolCallLogRow[]> {
  return db
    .selectFrom('tool_call_log')
    .select([
      'tool_call_id',
      'task_run_id',
      'tool_name',
      'status',
      'mode',
      'policy_decision',
      'idempotency_key',
    ])
    .where('tenant_id', '=', tenantId)
    .where('task_run_id', '=', taskRunId)
    .orderBy('created_at', 'asc')
    .execute() as Promise<ToolCallLogRow[]>;
}

async function loadIdempotencyRecords(db: DbClient, taskRunId: string): Promise<IdempotencyRow[]> {
  return db
    .selectFrom('idempotency_record')
    .select(['idempotency_key', 'target_type', 'target_id', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', 'like', `%${taskRunId}%`)
    .orderBy('created_at', 'desc')
    .execute() as Promise<IdempotencyRow[]>;
}

async function reportFailure(
  db: DbClient,
  input: { taskRunId: string | undefined; workflowId: string | undefined; error: unknown },
): Promise<void> {
  const recentAuditEvents = await loadRecentAuditEvents(db, input.taskRunId).catch(() => []);
  const dbTaskRun = input.taskRunId ? await loadTaskRun(db, input.taskRunId).catch(() => undefined) : undefined;
  const humanTasks = input.taskRunId ? await loadHumanTasks(db, input.taskRunId).catch(() => []) : [];
  const toolCallLogs = input.taskRunId ? await loadToolCallLogs(db, input.taskRunId).catch(() => []) : [];
  console.error(
    JSON.stringify(
      {
        ok: false,
        workflow_id: input.workflowId,
        task_run_id: input.taskRunId,
        task_run: dbTaskRun,
        human_tasks: humanTasks,
        tool_call_logs: toolCallLogs,
        recent_audit_events: recentAuditEvents.map((event) => ({
          event_id: event.event_id,
          target_id: event.target_id,
          result: event.result,
          reason: event.reason,
          payload: event.payload,
        })),
        error: input.error instanceof Error ? { name: input.error.name, message: input.error.message } : input.error,
      },
      null,
      2,
    ),
  );
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
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
  console.error(error);
  process.exit(1);
});
