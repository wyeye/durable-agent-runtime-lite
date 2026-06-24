import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeDb, createDb } from '@dar/db';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const model = 'qwen2.5:7b-instruct-q4_K_M';
const provider = 'local-ollama';
const tenantPrefix = process.env.OLLAMA_CONTAINER_SMOKE_TENANT_PREFIX ?? `ollama_container_${Date.now()}`;

const scenarios = [
  {
    name: 'final',
    command: ['corepack', 'pnpm', 'dar', 'smoke', 'run', 'ollama-runtime-final'],
    tenantId: `${tenantPrefix}_final`,
    minModelCalls: 1,
    expectedToolName: undefined,
  },
  {
    name: 'readonly',
    command: ['corepack', 'pnpm', 'dar', 'smoke', 'run', 'ollama-runtime-readonly'],
    tenantId: `${tenantPrefix}_readonly`,
    minModelCalls: 2,
    expectedToolName: 'knowledge.search',
  },
  {
    name: 'l3',
    command: ['corepack', 'pnpm', 'dar', 'smoke', 'run', 'ollama-runtime-l3'],
    tenantId: `${tenantPrefix}_l3`,
    minModelCalls: 2,
    expectedToolName: 'record.write.mock',
  },
] as const;

interface ScenarioEvidence {
  scenario: string;
  tenant_id: string;
  task_runs: number;
  agent_runs: number;
  model_calls: number;
  model_attempts: number;
  tool_calls: number;
  committed_tool_calls: number;
  human_tasks: number;
  audit_events: number;
  idempotency_records: number;
}

async function main(): Promise<void> {
  await run('corepack', ['pnpm', 'ollama:probe']);
  await run('corepack', ['pnpm', 'runtime:assert-containerized']);

  const evidence: ScenarioEvidence[] = [];
  for (const scenario of scenarios) {
    await run(scenario.command[0], scenario.command.slice(1), {
      SMOKE_TENANT_ID: scenario.tenantId,
      SMOKE_TIMEOUT_MS: process.env.SMOKE_TIMEOUT_MS ?? '180000',
    });
    evidence.push(await collectEvidence(scenario));
  }

  const logs = await commandOutput('docker', [
    'compose',
    '-f',
    'infra/docker-compose.yml',
    '-f',
    'infra/docker-compose.ollama.yml',
    'logs',
    '--no-color',
    '--tail=500',
    'runtime-api',
    'runtime-worker',
    'tool-gateway',
    'control-plane',
  ], { allowFailure: true });
  assertNoUnsafeRuntimeLog(logs);

  console.log(JSON.stringify({
    ok: true,
    model,
    provider,
    tenant_prefix: tenantPrefix,
    evidence,
  }, null, 2));
}

async function collectEvidence(scenario: (typeof scenarios)[number]): Promise<ScenarioEvidence> {
  const db = createDb({ databaseUrl });
  try {
    const taskRuns = await db
      .selectFrom('task_run')
      .select(['task_run_id', 'status'])
      .where('tenant_id', '=', scenario.tenantId)
      .execute();
    assert.ok(taskRuns.length >= 1, `${scenario.name} must create a TaskRun`);
    assert.ok(taskRuns.every((row) => row.status === 'completed'), `${scenario.name} TaskRun must complete`);

    const agentRuns = await db
      .selectFrom('agent_run')
      .select(['agent_run_id', 'status', 'selected_provider', 'selected_model_id', 'model_call_count'])
      .where('tenant_id', '=', scenario.tenantId)
      .execute();
    assert.ok(agentRuns.length >= 1, `${scenario.name} must create an AgentRun`);
    assert.ok(agentRuns.every((row) => row.status === 'completed'), `${scenario.name} AgentRun must complete`);
    assert.ok(agentRuns.every((row) => row.selected_provider === provider), `${scenario.name} AgentRun provider must be ${provider}`);
    assert.ok(agentRuns.every((row) => row.selected_model_id === model), `${scenario.name} AgentRun model must be ${model}`);

    const modelCalls = await db
      .selectFrom('model_call_log')
      .select(['model_call_id', 'provider', 'model_id', 'status', 'response_id'])
      .where('tenant_id', '=', scenario.tenantId)
      .execute();
    assert.ok(modelCalls.length >= scenario.minModelCalls, `${scenario.name} must have at least ${scenario.minModelCalls} model calls`);
    assert.ok(modelCalls.every((row) => row.provider === provider), `${scenario.name} ModelCall provider must be ${provider}`);
    assert.ok(modelCalls.every((row) => row.model_id === model), `${scenario.name} ModelCall model must be ${model}`);
    assert.ok(modelCalls.every((row) => row.status === 'succeeded'), `${scenario.name} ModelCall must succeed`);
    assert.ok(modelCalls.every((row) => row.response_id), `${scenario.name} ModelCall must record response_id`);

    const modelCallIds = modelCalls.map((row) => row.model_call_id);
    const attempts = modelCallIds.length > 0
      ? await db
        .selectFrom('model_call_attempt')
        .select(['attempt_id', 'provider', 'model_id', 'status', 'response_id'])
        .where('model_call_id', 'in', modelCallIds)
        .execute()
      : [];
    assert.ok(attempts.length >= modelCalls.length, `${scenario.name} must record model call attempts`);
    assert.ok(attempts.every((row) => row.provider === provider), `${scenario.name} ModelCallAttempt provider must be ${provider}`);
    assert.ok(attempts.every((row) => row.model_id === model), `${scenario.name} ModelCallAttempt model must be ${model}`);
    assert.ok(attempts.every((row) => row.status === 'succeeded'), `${scenario.name} ModelCallAttempt must succeed`);

    const toolCalls = await db
      .selectFrom('tool_call_log')
      .select(['tool_call_id', 'tool_name', 'status'])
      .where('tenant_id', '=', scenario.tenantId)
      .execute();
    if (scenario.expectedToolName) {
      const expectedCalls = toolCalls.filter((row) => row.tool_name === scenario.expectedToolName);
      assert.equal(expectedCalls.length, 1, `${scenario.name} must execute ${scenario.expectedToolName} exactly once`);
    } else {
      assert.equal(toolCalls.length, 0, `${scenario.name} must not execute tools`);
    }

    const committedToolCalls = toolCalls.filter((row) => row.status === 'committed').length;
    if (scenario.name === 'l3') {
      assert.equal(committedToolCalls, 1, 'l3 must commit exactly once');
    }

    const humanTasks = await db
      .selectFrom('human_task')
      .select(['human_task_id', 'status'])
      .where('tenant_id', '=', scenario.tenantId)
      .execute();
    if (scenario.name === 'l3') {
      assert.equal(humanTasks.length, 1, 'l3 must create exactly one human task');
      assert.equal(humanTasks[0]?.status, 'approved', 'l3 human task must be approved');
    }

    const auditEvents = await db
      .selectFrom('audit_event')
      .select(['event_id', 'action'])
      .where('tenant_id', '=', scenario.tenantId)
      .execute();
    assert.ok(auditEvents.length > 0, `${scenario.name} must write audit events`);

    const idempotencyRecords = await db
      .selectFrom('idempotency_record')
      .select(['idempotency_key'])
      .where('tenant_id', '=', scenario.tenantId)
      .execute();
    if (scenario.expectedToolName) {
      assert.equal(idempotencyRecords.length, 1, `${scenario.name} tool path must write one idempotency record`);
    }

    return {
      scenario: scenario.name,
      tenant_id: scenario.tenantId,
      task_runs: taskRuns.length,
      agent_runs: agentRuns.length,
      model_calls: modelCalls.length,
      model_attempts: attempts.length,
      tool_calls: toolCalls.length,
      committed_tool_calls: committedToolCalls,
      human_tasks: humanTasks.length,
      audit_events: auditEvents.length,
      idempotency_records: idempotencyRecords.length,
    };
  } finally {
    await closeDb(db);
  }
}

function assertNoUnsafeRuntimeLog(logs: string): void {
  const forbidden = [
    'deterministic mode active',
    'mock model gateway active',
    'hidden chain-of-thought',
  ];
  for (const pattern of forbidden) {
    assert.ok(!logs.toLowerCase().includes(pattern), `container logs must not include "${pattern}"`);
  }
}

async function run(command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  await commandOutput(command, args, { extraEnv });
}

async function commandOutput(
  command: string,
  args: string[],
  options: { allowFailure?: boolean; extraEnv?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`==> ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      cwd: new URL('../../../..', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.extraEnv ?? {}) },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const error = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0 || options.allowFailure) {
        resolve(output || error);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with ${code}: ${error}`));
    });
  });
}

main().catch((error: unknown) => {
  console.error('smoke:ollama-containerized-e2e failed');
  console.error(error);
  process.exit(1);
});
