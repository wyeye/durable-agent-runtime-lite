import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { LOCAL_OLLAMA_MODEL_ID } from './model-catalog-seed.js';

const expectedSha = process.env.BUILD_SHA ?? await commandOutput('git', ['rev-parse', 'HEAD']);
const services = [
  { service: 'control-plane', container: 'dar-control-plane', url: envUrl('CONTROL_PLANE_URL', 'http://localhost:3100'), port: 3100 },
  { service: 'runtime-api', container: 'dar-runtime-api', url: envUrl('RUNTIME_API_URL', 'http://localhost:3000'), port: 3000 },
  { service: 'runtime-worker', container: 'dar-runtime-worker', url: envUrl('RUNTIME_WORKER_URL', 'http://localhost:3300'), port: 3300 },
  { service: 'tool-gateway', container: 'dar-tool-gateway', url: envUrl('TOOL_GATEWAY_URL', 'http://localhost:3200'), port: 3200 },
] as const;

interface DockerContainer {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports?: string;
}

interface VersionResponse {
  service: string;
  version: string;
  build_sha: string;
  build_time: string;
}

async function main(): Promise<void> {
  const containers = await dockerPs();
  assertMockServerStopped(containers);
  await assertPortsOwnedByDocker(containers);

  const versions: VersionResponse[] = [];
  for (const target of services) {
    const container = containers.find((item) => item.Names === target.container);
    assert.ok(container, `${target.container} is not running`);
    assert.equal(container.State, 'running', `${target.container} must be running`);
    assert.match(container.Status, /\(healthy\)/u, `${target.container} must be healthy`);
    assert.ok(container.Ports?.includes(`:${target.port}->`), `${target.container} must publish host port ${target.port}`);

    const version = await fetchJson<VersionResponse>(`${target.url}/version`);
    assert.equal(version.service, target.service);
    assert.equal(version.build_sha, expectedSha, `${target.service} build_sha must match current Git SHA`);
    assert.ok(version.version.length > 0, `${target.service} version must be present`);
    assert.ok(version.build_time.length > 0, `${target.service} build_time must be present`);
    versions.push(version);
  }

  const workerEnv = await dockerInspectEnv('dar-runtime-worker');
  assertEnv(workerEnv, 'PI_AGENT_MODE', 'model_gateway');
  assertEnv(workerEnv, 'MODEL_GATEWAY_MODE', 'openai_compatible');
  assertEnv(workerEnv, 'MODEL_GATEWAY_PROTOCOL', 'openai_chat_completions');
  assert.equal(workerEnv.MODEL_GATEWAY_BASE_URL, 'http://host.docker.internal:11434/v1');

  const logs = await dockerLogs(services.map((target) => target.container));
  assertNoUnsafeRuntimeLog(logs);

  console.log(JSON.stringify({
    ok: true,
    expected_build_sha: expectedSha,
    versions,
    runtime_worker: {
      pi_agent_mode: workerEnv.PI_AGENT_MODE,
      model_gateway_mode: workerEnv.MODEL_GATEWAY_MODE,
      model_gateway_protocol: workerEnv.MODEL_GATEWAY_PROTOCOL,
      model_gateway_provider: 'local-ollama',
      model_gateway_model: LOCAL_OLLAMA_MODEL_ID,
      model_gateway_base_url: workerEnv.MODEL_GATEWAY_BASE_URL,
    },
    mock_server_running: false,
  }, null, 2));
}

async function dockerPs(): Promise<DockerContainer[]> {
  const output = await commandOutput('docker', ['ps', '--format', 'json']);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DockerContainer);
}

async function dockerInspectEnv(containerName: string): Promise<Record<string, string>> {
  const output = await commandOutput('docker', ['inspect', containerName, '--format', '{{json .Config.Env}}']);
  const values = JSON.parse(output) as string[];
  return Object.fromEntries(values.map((value) => {
    const separator = value.indexOf('=');
    return separator === -1 ? [value, ''] : [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

async function dockerLogs(containers: readonly string[]): Promise<string> {
  const chunks = await Promise.all(containers.map((container) =>
    commandOutput('docker', ['logs', '--tail', '500', container], { allowFailure: true }),
  ));
  return chunks.join('\n');
}

function assertMockServerStopped(containers: DockerContainer[]): void {
  const mockServer = containers.find((item) => item.Names === 'dar-mock-server');
  assert.ok(!mockServer, 'mock-server container must not be running for containerized Ollama runtime gate');
}

async function assertPortsOwnedByDocker(containers: DockerContainer[]): Promise<void> {
  for (const target of services) {
    const container = containers.find((item) => item.Names === target.container);
    assert.ok(container?.Ports?.includes(`:${target.port}->`), `${target.container} must publish ${target.port}`);
  }
}

function assertEnv(env: Record<string, string>, name: string, expected: string): void {
  assert.equal(env[name], expected, `runtime-worker ${name} must be ${expected}`);
}

function assertNoUnsafeRuntimeLog(logs: string): void {
  const forbidden = [
    'deterministic mode active',
    'mock model gateway active',
  ];
  for (const pattern of forbidden) {
    assert.ok(!logs.toLowerCase().includes(pattern), `container logs must not include "${pattern}"`);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function commandOutput(
  command: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: new URL('../../../..', import.meta.url),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
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

function envUrl(name: string, fallback: string): string {
  return (process.env[name] ?? fallback).replace(/\/+$/u, '');
}

main().catch((error: unknown) => {
  console.error('runtime:assert-containerized failed');
  console.error(error);
  process.exit(1);
});
