import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfiles = [
  'apps/control-plane/Dockerfile',
  'apps/runtime-api/Dockerfile',
  'apps/runtime-worker/Dockerfile',
  'apps/tool-gateway/Dockerfile',
];

describe('docker deployment files', () => {
  it('keeps one app-specific Dockerfile per production app', async () => {
    for (const file of dockerfiles) {
      const content = await readFile(file, 'utf8');
      expect(content).toContain('FROM');
      expect(content).not.toContain('COPY .env');
    }
  });

  it('provides executable docker scripts', async () => {
    await access('scripts/docker-build-all.sh', constants.X_OK);
    await access('scripts/docker-run-local.sh', constants.X_OK);
    await access('scripts/docker-db-migrate.sh', constants.X_OK);
    await access('scripts/docker-seed-examples.sh', constants.X_OK);
  });

  it('keeps backend runner images readable by their unprivileged app user', async () => {
    for (const file of dockerfiles.filter((name) => !name.includes('control-plane'))) {
      const content = await readFile(file, 'utf8');
      expect(content).toContain('COPY --from=builder --chown=app:app /repo /repo');
      expect(content).toContain('--workspace-concurrency=1 build');
      expect(content).toContain('USER app');
    }
  });

  it('keeps the control-plane nginx runner readable by the unprivileged nginx user', async () => {
    const content = await readFile('apps/control-plane/Dockerfile', 'utf8');
    expect(content).toContain('--workspace-concurrency=1 build && test -f apps/control-plane/dist/index.html');
    expect(content).toContain(
      'COPY --chown=nginx:nginx apps/control-plane/docker/nginx.conf /etc/nginx/conf.d/default.conf',
    );
    expect(content).toContain('COPY --from=builder --chown=nginx:nginx /repo/apps/control-plane/dist');
  });

  it('does not define a root production Dockerfile and keeps compose context at repo root', async () => {
    await expect(stat('Dockerfile')).rejects.toThrow();
    const compose = await readFile('infra/docker-compose.yml', 'utf8');
    expect(compose.match(/context: \.\./g)?.length).toBe(4);
    expect(compose).toContain('dockerfile: apps/runtime-api/Dockerfile');
    expect(compose).toContain('dockerfile: apps/tool-gateway/Dockerfile');
    expect(compose).toContain('RUNTIME_API_ROUTE_SOURCE: db');
    expect(compose).toContain('RUNTIME_API_WORKFLOW_STARTER: temporal');
    expect(compose).toContain('RUNTIME_WORKER_MODE: temporal');
    expect(compose).toContain('TOOL_GATEWAY_REGISTRY_SOURCE: db');
  });

  it('provides the real Temporal DB smoke script command target', async () => {
    const rootPackage = await readFile('package.json', 'utf8');
    expect(rootPackage).toContain('"smoke:temporal-db-e2e": "tsx scripts/smoke-temporal-db-e2e.ts"');
    await access('scripts/smoke-temporal-db-e2e.ts', constants.R_OK);
  });

  it('lets example seeding target the local compose database without extra env', async () => {
    const seedScript = await readFile('scripts/seed-examples.ts', 'utf8');
    expect(seedScript).toContain('postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime');
  });
});
