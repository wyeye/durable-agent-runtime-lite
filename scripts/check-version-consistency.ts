import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);

async function main() {
  const rootPackage = await readJson<{ version: string }>('package.json');
  const version = rootPackage.version;
  assert.match(version, /^\d+\.\d+\.\d+$/u, 'root package version must be semver');

  const packageFiles = [
    'apps/control-plane/package.json',
    'apps/runtime-api/package.json',
    'apps/runtime-worker/package.json',
    'apps/tool-gateway/package.json',
    'devtools/mock-server/package.json',
    'packages/config/package.json',
    'packages/contracts/package.json',
    'packages/db/package.json',
    'packages/logger/package.json',
    'packages/model-client/package.json',
    'packages/security/package.json',
    'packages/telemetry/package.json',
    'packages/temporal/package.json',
    'packages/tool-client/package.json',
  ];
  for (const file of packageFiles) {
    const pkg = await readJson<{ version: string }>(file);
    assert.equal(pkg.version, version, `${file} version must match root package version`);
  }

  await assertTextIncludes('packages/config/src/index.ts', `APP_VERSION: stringSchema('${version}')`);
  await assertTextIncludes('.env.example', `APP_VERSION=${version}`);
  await assertTextIncludes('README.md', `当前平台版本：${version}`);
  await assertTextIncludes('docs/CURRENT_STATUS.md', `Current platform version: ${version}.`);
  await assertTextIncludes('docs/CURRENT_STATUS.md', '**AR-2A IMPLEMENTATION COMPLETE**');
  await assertTextIncludes('docs/CURRENT_STATUS.md', 'Current AR-2B status: `AR-2B DEVELOPMENT COMPLETE`.');
  await assertTextIncludes('CHANGELOG.md', `## ${version}`);
  console.log(JSON.stringify({ ok: true, version }, null, 2));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readText(path)) as T;
}

async function readText(path: string): Promise<string> {
  return readFile(join(root.pathname, path), 'utf8');
}

async function assertTextIncludes(path: string, needle: string): Promise<void> {
  const text = await readText(path);
  assert.ok(text.includes(needle), `${path} must include ${needle}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
