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

  it('keeps Node runner images readable by their unprivileged app user', async () => {
    for (const file of dockerfiles) {
      const content = await readFile(file, 'utf8');
      expect(content).not.toContain('COPY --from=builder --chown=app:app /repo /repo');
      expect(content).toContain('COPY --from=builder --chown=app:app /repo/node_modules /repo/node_modules');
      expect(content).toContain('mkdir -p /repo/runtime-packages');
      expect(content).toContain('cp -R "$package_dir/dist" "/repo/runtime-packages/$package_name/dist"');
      expect(content).toContain('COPY --from=builder --chown=app:app /repo/runtime-packages /repo/packages');
      expect(content).not.toContain('COPY --from=builder --chown=app:app /repo/packages /repo/packages');
      expect(content).toContain('COPY --from=builder --chown=app:app /repo/apps/');
      expect(content).toContain('--workspace-concurrency=1 build');
      expect(content).toContain('USER app');
    }
  });

  it('stamps app images with build args, OCI labels, and frozen pnpm installs', async () => {
    for (const file of dockerfiles) {
      const content = await readFile(file, 'utf8');
      expect(content).toContain('ARG APP_VERSION=0.8.0');
      expect(content).toContain('ARG BUILD_SHA=unknown');
      expect(content).toContain('ARG BUILD_TIME=unknown');
      expect(content).toContain('org.opencontainers.image.version="${APP_VERSION}"');
      expect(content).toContain('org.opencontainers.image.revision="${BUILD_SHA}"');
      expect(content).toContain('org.opencontainers.image.created="${BUILD_TIME}"');
      expect(content).toContain('org.opencontainers.image.source="https://github.com/wyeye/durable-agent-runtime-lite"');
      expect(content).toContain('pnpm install --frozen-lockfile');
      expect(content).toContain('CI=true pnpm prune --prod');
      expect(content).toContain('install --prod --frozen-lockfile --offline');
    }
  });

  it('serves control-plane API and Vite assets from the Fastify Node runner', async () => {
    const content = await readFile('apps/control-plane/Dockerfile', 'utf8');
    expect(content).toContain('test -f apps/control-plane/dist/server/server/bootstrap.js');
    expect(content).toContain('test -f apps/control-plane/dist/public/index.html');
    expect(content).toContain('CMD ["node", "dist/server/server/bootstrap.js"]');
    expect(content).not.toContain('nginx');
  });

  it('does not define a root production Dockerfile and keeps compose context at repo root', async () => {
    await expect(stat('Dockerfile')).rejects.toThrow();
    const compose = await readFile('infra/docker-compose.yml', 'utf8');
    expect(compose.match(/context: \.\./g)?.length).toBe(4);
    expect(compose.match(/BUILD_SHA: \${BUILD_SHA:-unknown}/g)?.length).toBe(4);
    expect(compose).toContain('dockerfile: apps/runtime-api/Dockerfile');
    expect(compose).toContain('dockerfile: apps/tool-gateway/Dockerfile');
    expect(compose).toContain('RUNTIME_API_ROUTE_SOURCE: db');
    expect(compose).toContain('RUNTIME_API_WORKFLOW_STARTER: temporal');
    expect(compose).toContain('RUNTIME_WORKER_MODE: temporal');
    expect(compose).toContain('TOOL_GATEWAY_REGISTRY_SOURCE: db');
    expect(compose).toContain('CONTROL_PLANE_AUTH_MODE: header');
    expect(compose).toContain('RUNTIME_API_URL: http://runtime-api:3000');
    expect(compose).toContain('TOOL_GATEWAY_URL: http://tool-gateway:3200');
  });

  it('provides unified repo-cli smoke command targets', async () => {
    const rootPackage = await readFile('package.json', 'utf8');
    expect(rootPackage).toContain('"dar": "tsx devtools/repo-cli/src/cli.ts"');
    expect(rootPackage).toContain('"smoke:core": "pnpm dar smoke suite core"');
    expect(rootPackage).toContain('"smoke:agent": "pnpm dar smoke suite agent"');
    expect(rootPackage).toContain('"runtime:assert-containerized": "tsx devtools/repo-cli/src/scripts/assert-containerized-runtime.ts"');
    await access('devtools/repo-cli/src/scripts/smoke-temporal-db-e2e.ts', constants.R_OK);
    await access('devtools/repo-cli/src/scripts/smoke-control-plane-api-e2e.ts', constants.R_OK);
    await access('devtools/repo-cli/src/scripts/assert-containerized-runtime.ts', constants.R_OK);
    await access('devtools/repo-cli/src/scripts/smoke-ollama-containerized-e2e.ts', constants.R_OK);
  });

  it('lets example seeding target the local compose database without extra env', async () => {
    const seedScript = await readFile('devtools/repo-cli/src/scripts/seed-examples.ts', 'utf8');
    expect(seedScript).toContain('postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime');
  });
});
