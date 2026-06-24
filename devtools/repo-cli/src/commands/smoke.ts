import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { smokeCatalog, scenarioById, scenariosBySuite, smokeSuites, isSmokeSuite } from '../smoke/catalog.js';
import type { SmokeResult, SmokeScenario } from '../smoke/result.js';
import { fromRepo, repoRoot } from '../support/paths.js';
import { runCommand } from '../support/process.js';

export async function handleSmoke(args: string[]): Promise<void> {
  const options = parseSmokeOptions(args);
  const [command, value] = options.positionals;
  if (!command || command === '--help' || command === 'help') {
    printSmokeHelp();
    return;
  }
  if (command === 'list') {
    output(options.json, {
      suites: smokeSuites,
      scenarios: smokeCatalog.map(({ id, suite, description, mode, timeoutMs }) => ({
        id,
        suite,
        description,
        mode,
        timeout_ms: timeoutMs,
      })),
    });
    return;
  }
  if (command === 'run') {
    if (!value) {
      throw new Error('Usage: pnpm dar smoke run <scenario>');
    }
    const scenario = scenarioById(value);
    if (!scenario) {
      throw new Error(`Unknown smoke scenario: ${value}`);
    }
    const result = await runScenario(scenario, options);
    output(options.json, result);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'suite') {
    if (!value || !isSmokeSuite(value)) {
      throw new Error(`Unknown smoke suite: ${value ?? ''}`);
    }
    const results: SmokeResult[] = [];
    for (const scenario of scenariosBySuite(value)) {
      if (options.ci && scenario.mode === 'real') {
        const skipped = {
          ok: true,
          scenario: scenario.id,
          duration_ms: 0,
          summary: { suite: scenario.suite, mode: scenario.mode },
          skipped: true,
          skip_reason: 'real scenarios are manual/self-hosted only',
        };
        results.push(skipped);
        if (!options.json) {
          console.log(JSON.stringify(skipped));
        }
        continue;
      }
      const result = await runScenario(scenario, options);
      results.push(result);
      if (!options.json) {
        console.log(JSON.stringify(result));
      }
      if (!result.ok) {
        break;
      }
    }
    const summary = {
      ok: results.every((result) => result.ok),
      suite: value,
      results,
    };
    output(options.json, summary);
    if (!summary.ok) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(`Unknown smoke command: ${command}`);
}

async function runScenario(
  scenario: SmokeScenario,
  options: { ci: boolean; json: boolean },
): Promise<SmokeResult> {
  const started = Date.now();
  for (const artifact of scenario.artifacts ?? [`artifacts/smoke/${scenario.id}`]) {
    await mkdir(fromRepo(artifact), { recursive: true }).catch(() => undefined);
    await mkdir(dirname(fromRepo(artifact)), { recursive: true }).catch(() => undefined);
  }
  const [command, ...args] = scenario.command;
  if (!command) {
    throw new Error(`Scenario ${scenario.id} has no command`);
  }
  const result = await runCommand(command, args, {
    inherit: !options.json,
    env: {
      CI: options.ci ? 'true' : process.env.CI,
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
      RUNTIME_API_URL: process.env.RUNTIME_API_URL ?? 'http://localhost:3000',
      TOOL_GATEWAY_URL: process.env.TOOL_GATEWAY_URL ?? 'http://localhost:3200',
      RUNTIME_WORKER_URL: process.env.RUNTIME_WORKER_URL ?? 'http://localhost:3300',
      CONTROL_PLANE_URL: process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100',
      SMOKE_SCENARIO_ID: scenario.id,
      SMOKE_SUITE: scenario.suite,
      SMOKE_TIMEOUT_MS: String(scenario.timeoutMs),
      ...(scenario.env ?? {}),
    },
  });
  const durationMs = Date.now() - started;
  return {
    ok: result.code === 0,
    scenario: scenario.id,
    duration_ms: durationMs,
    summary: {
      suite: scenario.suite,
      mode: scenario.mode,
      command: scenario.command.join(' '),
      stdout_tail: safeTail(result.stdout),
      stderr_tail: safeTail(result.stderr),
    },
    artifacts: scenario.artifacts ?? [`${repoRoot}/artifacts/smoke/${scenario.id}`],
  };
}

function parseSmokeOptions(args: string[]) {
  const positionals: string[] = [];
  let json = false;
  let ci = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--ci') {
      ci = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, json, ci };
}

function printSmokeHelp(): void {
  console.log(`Usage:
  pnpm dar smoke list [--json]
  pnpm dar smoke run <scenario> [--ci] [--json]
  pnpm dar smoke suite <core|agent|governance|ui|real> [--ci] [--json]`);
}

function output(json: boolean, value: unknown): void {
  console.log(JSON.stringify(value, null, json ? 2 : 0));
}

function safeTail(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9_.-]+/giu, 'Bearer [REDACTED]')
    .replace(/(TOKEN|SECRET|PASSWORD|API_KEY)=\S+/giu, '$1=[REDACTED]')
    .slice(-2000);
}
