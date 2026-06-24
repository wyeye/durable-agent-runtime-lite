import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { smokeCatalog, smokeSuites } from '../smoke/catalog.js';
import { fromRepo, repoRoot } from '../support/paths.js';
import { assertSuccess, runCommand } from '../support/process.js';

type CheckName = 'all' | 'version' | 'i18n' | 'visual-config' | 'docs' | 'mocks';

export async function handleCheck(args: string[]): Promise<void> {
  const options = parseCheckOptions(args);
  const rawTarget = options.positionals[0] ?? 'all';
  if (rawTarget === '--help' || rawTarget === 'help') {
    printCheckHelp();
    return;
  }
  const target = rawTarget as CheckName;
  const checks = target === 'all'
    ? ['version', 'i18n', 'visual-config', 'docs', 'mocks'] as CheckName[]
    : [target];
  const results = [];
  for (const check of checks) {
    const started = Date.now();
    await runCheck(check);
    results.push({ check, ok: true, duration_ms: Date.now() - started });
  }
  console.log(JSON.stringify({ ok: true, results }, null, options.json ? 2 : 0));
}

async function runCheck(check: CheckName): Promise<void> {
  if (check === 'version') {
    assertSuccess(await runCommand('tsx', ['devtools/repo-cli/src/scripts/check-version-consistency.ts']), 'version check');
    return;
  }
  if (check === 'i18n') {
    assertSuccess(await runCommand('tsx', ['devtools/repo-cli/src/scripts/check-i18n.ts']), 'i18n check');
    return;
  }
  if (check === 'visual-config') {
    assertSuccess(await runCommand('tsx', ['devtools/repo-cli/src/scripts/check-visual-config.ts']), 'visual config check');
    return;
  }
  if (check === 'docs') {
    await checkDocs();
    return;
  }
  if (check === 'mocks') {
    await checkMocks();
    return;
  }
  throw new Error(`Unknown check: ${check}`);
}

async function checkDocs(): Promise<void> {
  const failures: string[] = [];
  const rootPackage = JSON.parse(await readFile(fromRepo('package.json'), 'utf8')) as { version: string; scripts: Record<string, string> };
  const activeDocs = (await listFiles(fromRepo('docs')))
    .filter((file) => file.endsWith('.md'))
    .filter((file) => !relative(repoRoot, file).startsWith('docs/archive/'));
  if (activeDocs.length > 18) {
    failures.push(`active docs count ${activeDocs.length} exceeds 18`);
  }
  for (const file of await readdir(fromRepo('docs'))) {
    if (/^\d{2}_.*\.md$/u.test(file)) {
      failures.push(`numbered topic doc remains in docs root: docs/${file}`);
    }
    if (file.endsWith('.docx')) {
      failures.push(`docx remains in docs root: docs/${file}`);
    }
  }
  const docsReadme = await readTextIfExists('docs/README.md');
  if (!docsReadme) {
    failures.push('docs/README.md is required');
  }
  for (const file of activeDocs) {
    const rel = relative(repoRoot, file);
    if (rel !== 'docs/README.md' && !docsReadme.includes(rel.replace(/^docs\//u, ''))) {
      failures.push(`active doc is not indexed by docs/README.md: ${rel}`);
    }
  }
  const readmeLines = (await readTextIfExists('README.md')).split('\n').length;
  if (readmeLines > 250) {
    failures.push(`README.md has ${readmeLines} lines; expected <= 250`);
  }
  const statusDocs = activeDocs.filter((file) => /current-status/i.test(file));
  if (statusDocs.length !== 1) {
    failures.push(`expected exactly one current-status doc, found ${statusDocs.length}`);
  }
  const roadmapDocs = activeDocs.filter((file) => /roadmap|release/i.test(file));
  if (roadmapDocs.length !== 1) {
    failures.push(`expected exactly one roadmap/release doc, found ${roadmapDocs.length}`);
  }
  const status = await readTextIfExists('docs/project/current-status.md');
  if (!status.includes(`当前平台版本：${rootPackage.version}`)) {
    failures.push('docs/project/current-status.md must match root package version');
  }
  const migrationHead = await latestMigration();
  if (migrationHead && !status.includes(migrationHead)) {
    failures.push(`docs/project/current-status.md must include migration head ${migrationHead}`);
  }
  await checkMarkdownLinks(activeDocs, failures);
  await checkDocumentCommands(activeDocs, rootPackage.scripts, failures);
  const archiveDocs = (await listFiles(fromRepo('docs/archive')).catch(() => []))
    .filter((file) => file.endsWith('.md'));
  if (archiveDocs.length > 5) {
    failures.push(`archive docs count ${archiveDocs.length} exceeds 5`);
  }
  for (const file of archiveDocs) {
    const text = await readFile(file, 'utf8');
    if (!text.includes('历史归档')) {
      failures.push(`${relative(repoRoot, file)} must include historical archive warning`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.map((failure) => `- ${failure}`).join('\n'));
  }
}

async function checkMocks(): Promise<void> {
  const failures: string[] = [];
  const productionSourceFiles = (await Promise.all(['apps/control-plane/src', 'apps/runtime-api/src', 'apps/runtime-worker/src', 'apps/tool-gateway/src']
    .map((dir) => listFiles(fromRepo(dir)).catch(() => [])))).flat()
    .filter((file) => /\.(ts|tsx)$/u.test(file));
  for (const file of productionSourceFiles) {
    const rel = relative(repoRoot, file);
    const source = await readFile(file, 'utf8');
    if (/from ['"](?:\.\.\/)*devtools\//u.test(source) || /from ['"][^'"]*devtools\//u.test(source)) {
      failures.push(`${rel}: production app must not import devtools`);
    }
    if (rel.endsWith('deterministic-pi-stream.ts')) {
      failures.push(`${rel}: deterministic external response generator must not live in production app source`);
    }
    if (/route\([^)]*mock-server|Mock.*Gateway.*Response|deterministicEmbedding/u.test(source)) {
      failures.push(`${rel}: external mock implementation belongs in devtools/mock-server`);
    }
  }
  const prodCompose = await readFile(fromRepo('infra/docker-compose.yml'), 'utf8');
  if (prodCompose.includes('mock-server')) {
    failures.push('infra/docker-compose.yml must not include mock-server');
  }
  const piCompose = await readFile(fromRepo('infra/docker-compose.pi-smoke.yml'), 'utf8');
  if (!piCompose.includes('mock-server')) {
    failures.push('pi smoke compose must include mock-server');
  }
  if (/PI_AGENT_MODE:\s*\$\{PI_AGENT_MODE:-deterministic\}/u.test(piCompose)) {
    failures.push('pi smoke compose must default to PI_AGENT_MODE=model_gateway');
  }
  const integration = await readTextIfExists('.github/workflows/integration.yml');
  if (/PI_AGENT_MODE:\s*deterministic/u.test(integration) || /deterministic smoke/u.test(integration)) {
    failures.push('integration workflow must not use deterministic app mode');
  }
  const rootPackage = await readTextIfExists('package.json');
  if (/PI_SMOKE_MODE=deterministic/u.test(rootPackage)) {
    failures.push('root package smoke commands must not use deterministic mode');
  }
  if (failures.length > 0) {
    throw new Error(failures.map((failure) => `- ${failure}`).join('\n'));
  }
}

async function checkMarkdownLinks(files: string[], failures: string[]): Promise<void> {
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/gu;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(linkPattern)) {
      const target = match[1] ?? '';
      if (/^(https?:|mailto:|#)/u.test(target)) {
        continue;
      }
      const [pathPart] = target.split('#');
      if (!pathPart || pathPart.startsWith('http')) {
        continue;
      }
      const resolved = join(dirname(file), decodeURIComponent(pathPart));
      try {
        await access(resolved);
      } catch {
        failures.push(`${relative(repoRoot, file)} links to missing ${target}`);
      }
    }
    if (/pnpm\s+smoke:[a-z0-9-]+/u.test(text) || /corepack\s+pnpm\s+smoke:[a-z0-9-]+/u.test(text)) {
      failures.push(`${relative(repoRoot, file)} references legacy smoke alias`);
    }
    if (/docs\/(?:\d{2}_|CURRENT_STATUS\.md|ROADMAP_TO_V1\.md)/u.test(text)) {
      failures.push(`${relative(repoRoot, file)} references deleted legacy doc path`);
    }
  }
}

async function checkDocumentCommands(files: string[], scripts: Record<string, string>, failures: string[]): Promise<void> {
  const commandPattern = /pnpm\s+([a-z0-9:.-]+)/giu;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(commandPattern)) {
      const command = match[1] ?? '';
      if (['install', 'exec', '--filter', 'dlx', 'dar'].includes(command) || command.startsWith('--')) {
        continue;
      }
      if (!(command in scripts)) {
        failures.push(`${relative(repoRoot, file)} references missing package command pnpm ${command}`);
      }
    }
  }
}

async function latestMigration(): Promise<string | undefined> {
  const files = await readdir(fromRepo('db/migrations')).catch(() => []);
  return files.filter((file) => file.endsWith('.sql')).sort().at(-1);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

async function readTextIfExists(path: string): Promise<string> {
  return readFile(fromRepo(path), 'utf8').catch(() => '');
}

function parseCheckOptions(args: string[]) {
  const positionals: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--ci') {
      continue;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, json };
}

function printCheckHelp(): void {
  console.log(`Usage:
  pnpm dar check all [--ci] [--json]
  pnpm dar check docs [--json]
  pnpm dar check mocks [--json]
  pnpm dar check version|i18n|visual-config`);
}

export function validateSmokeCatalog(): void {
  const ids = new Set<string>();
  for (const scenario of smokeCatalog) {
    assert.ok(!ids.has(scenario.id), `duplicate smoke scenario id ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(smokeSuites.includes(scenario.suite), `invalid suite for ${scenario.id}`);
    assert.ok(scenario.timeoutMs > 0 && scenario.timeoutMs <= 900_000, `invalid timeout for ${scenario.id}`);
  }
  for (const suite of smokeSuites) {
    assert.ok(smokeCatalog.some((scenario) => scenario.suite === suite), `empty smoke suite ${suite}`);
  }
}
