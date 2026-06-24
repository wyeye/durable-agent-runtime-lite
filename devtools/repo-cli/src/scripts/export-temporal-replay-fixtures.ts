import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';

interface FixtureRequest {
  name: string;
  workflowId: string;
  runId?: string;
}

interface FixtureManifestEntry {
  name: string;
  workflow_id: string;
  run_id?: string;
  file: string;
  event_count: number;
}

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const fixtureDir = process.env.TEMPORAL_REPLAY_FIXTURE_DIR
  ? process.env.TEMPORAL_REPLAY_FIXTURE_DIR
  : join(repoRoot, 'tests/temporal-replay/histories');

async function main(): Promise<void> {
  const fixtureRequests = await loadFixtureRequests();
  assert.ok(
    fixtureRequests.length > 0,
    'No workflow IDs supplied. Set TEMPORAL_REPLAY_WORKFLOW_ID_MAP, TEMPORAL_REPLAY_WORKFLOW_IDS, or TEMPORAL_REPLAY_SMOKE_RESULT_FILE.',
  );

  const connection = await Connection.connect({ address: temporalAddress });
  const client = new Client({ connection, namespace: temporalNamespace });
  await mkdir(fixtureDir, { recursive: true });

  const histories: FixtureManifestEntry[] = [];
  for (const request of fixtureRequests) {
    const handle = client.workflow.getHandle(request.workflowId, request.runId);
    const history = await handle.fetchHistory();
    const historyText = JSON.stringify(history, null, 2);
    assertNoSecretLikeValues(historyText, request.workflowId);

    const eventCount = countHistoryEvents(history);
    assert.ok(eventCount > 0, `Temporal history for ${request.workflowId} is empty`);

    const file = `${sanitizeFileSegment(request.name)}.history.json`;
    await writeFile(join(fixtureDir, file), `${historyText}\n`, 'utf8');
    histories.push(optionalObject({
      name: request.name,
      workflow_id: request.workflowId,
      run_id: request.runId,
      file,
      event_count: eventCount,
    }) as FixtureManifestEntry);
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    temporal_address: temporalAddress,
    temporal_namespace: temporalNamespace,
    histories,
  };
  await writeFile(join(fixtureDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    fixture_dir: fixtureDir,
    histories: histories.map((entry) => ({
      name: entry.name,
      workflow_id: entry.workflow_id,
      run_id: entry.run_id,
      file: basename(entry.file),
      event_count: entry.event_count,
    })),
  }, null, 2));
}

async function loadFixtureRequests(): Promise<FixtureRequest[]> {
  if (process.env.TEMPORAL_REPLAY_WORKFLOW_ID_MAP) {
    return parseWorkflowIdMap(process.env.TEMPORAL_REPLAY_WORKFLOW_ID_MAP);
  }
  if (process.env.TEMPORAL_REPLAY_WORKFLOW_IDS) {
    return process.env.TEMPORAL_REPLAY_WORKFLOW_IDS
      .split(',')
      .map((workflowId) => workflowId.trim())
      .filter(Boolean)
      .map((workflowId, index) => ({ name: `workflow-${index + 1}`, workflowId }));
  }
  if (process.env.TEMPORAL_REPLAY_SMOKE_RESULT_FILE) {
    const text = await readFile(process.env.TEMPORAL_REPLAY_SMOKE_RESULT_FILE, 'utf8');
    return parseSmokeResult(text);
  }
  return [];
}

function parseWorkflowIdMap(value: string): FixtureRequest[] {
  const parsed = JSON.parse(value) as unknown;
  if (Array.isArray(parsed)) {
    return parsed.map((entry, index) => {
      const record = recordOrThrow(entry, `TEMPORAL_REPLAY_WORKFLOW_ID_MAP[${index}]`);
      const workflowId = stringOrThrow(record.workflow_id ?? record.workflowId, `workflow_id at index ${index}`);
      return optionalObject({
        name: stringOrDefault(record.name, `workflow-${index + 1}`),
        workflowId,
        runId: stringOrUndefined(record.run_id ?? record.runId),
      }) as FixtureRequest;
    });
  }
  const record = recordOrThrow(parsed, 'TEMPORAL_REPLAY_WORKFLOW_ID_MAP');
  return Object.entries(record).map(([name, workflowId]) => ({
    name,
    workflowId: stringOrThrow(workflowId, `workflow id for ${name}`),
  }));
}

function parseSmokeResult(value: string): FixtureRequest[] {
  const parsed = recordOrThrow(JSON.parse(value) as unknown, 'TEMPORAL_REPLAY_SMOKE_RESULT_FILE');
  if (Array.isArray(parsed.runs)) {
    return parseEvaluationSmokeResult(parsed);
  }
  const scenarios = recordOrThrow(parsed.scenarios, 'smoke scenarios');
  return Object.entries(scenarios).flatMap(([name, scenario]) => {
    const record = recordOrThrow(scenario, `smoke scenario ${name}`);
    const safeName = name.replace(/_/gu, '-');
    const taskWorkflowId = stringOrThrow(record.workflow_id, `workflow_id for smoke scenario ${name}`);
    const taskWorkflowRunId = stringOrUndefined(record.task_workflow_run_id);
    const agentWorkflowId = stringOrUndefined(record.agent_workflow_id);
    const agentWorkflowRunId = stringOrUndefined(record.workflow_run_id);
    const requests: FixtureRequest[] = [
      optionalObject({
        name: `pi-${safeName}-task`,
        workflowId: taskWorkflowId,
        runId: taskWorkflowRunId,
      }) as FixtureRequest,
    ];
    if (agentWorkflowId) {
      requests.push(optionalObject({
        name: `pi-${safeName}-agent`,
        workflowId: agentWorkflowId,
        runId: agentWorkflowRunId,
      }) as FixtureRequest);
    }
    return requests;
  });
}

function parseEvaluationSmokeResult(parsed: Record<string, unknown>): FixtureRequest[] {
  const runs = parsed.runs;
  assert.ok(Array.isArray(runs), 'evaluation smoke runs must be an array');
  const run = runs.map((entry) => recordOrThrow(entry, 'evaluation smoke run'))
    .find((entry) => stringOrUndefined(entry.workflow_id) && Array.isArray(entry.case_workflows));
  assert.ok(run, 'evaluation smoke result must contain a run workflow');
  const workflowId = stringOrThrow(run.workflow_id, 'evaluation run workflow_id');
  const runId = stringOrUndefined(run.workflow_run_id);
  const caseWorkflows = (run.case_workflows as unknown[])
    .map((entry, index) => recordOrThrow(entry, `evaluation case workflow ${index}`));
  const successCase = caseWorkflows.find((entry) => entry.status === 'passed' && stringOrUndefined(entry.workflow_id));
  const systemErrorCase = caseWorkflows.find((entry) => entry.status === 'system_error' && stringOrUndefined(entry.workflow_id));
  assert.ok(successCase, 'evaluation smoke must include a passed case workflow');
  assert.ok(systemErrorCase, 'evaluation smoke must include a system_error case workflow');
  return [
    optionalObject({
      name: 'evaluation-run-success',
      workflowId,
      runId,
    }) as FixtureRequest,
    optionalObject({
      name: 'evaluation-case-success',
      workflowId: stringOrThrow(successCase.workflow_id, 'evaluation success case workflow_id'),
      runId: stringOrUndefined(successCase.workflow_run_id),
    }) as FixtureRequest,
    optionalObject({
      name: 'evaluation-case-system-error',
      workflowId: stringOrThrow(systemErrorCase.workflow_id, 'evaluation system_error case workflow_id'),
      runId: stringOrUndefined(systemErrorCase.workflow_run_id),
    }) as FixtureRequest,
  ];
}

function countHistoryEvents(history: unknown): number {
  const record = recordOrThrow(history, 'Temporal history');
  const events = record.events;
  return Array.isArray(events) ? events.length : 0;
}

function assertNoSecretLikeValues(text: string, workflowId: string): void {
  const patterns = [
    /Bearer\s+[A-Za-z0-9_.-]+/iu,
    /dev-only-[A-Za-z0-9_.-]+-token/iu,
    /"(?:api[_-]?key|token|secret|password)"\s*:\s*"[^"]{8,}"/iu,
    /(?:API_KEY|TOKEN|SECRET|PASSWORD)=\S{8,}/iu,
  ];
  for (const pattern of patterns) {
    assert.equal(pattern.test(text), false, `Refusing to write secret-like value from Temporal history ${workflowId}`);
  }
}

function sanitizeFileSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'workflow';
}

function recordOrThrow(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringOrThrow(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  const text = value as string;
  assert.ok(text.trim().length > 0, `${label} must not be empty`);
  return text;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalObject<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
