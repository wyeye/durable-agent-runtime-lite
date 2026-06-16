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
  });

  it('does not define a root production Dockerfile and keeps compose context at repo root', async () => {
    await expect(stat('Dockerfile')).rejects.toThrow();
    const compose = await readFile('infra/docker-compose.yml', 'utf8');
    expect(compose.match(/context: \.\./g)?.length).toBe(4);
    expect(compose).toContain('dockerfile: apps/runtime-api/Dockerfile');
    expect(compose).toContain('dockerfile: apps/tool-gateway/Dockerfile');
  });
});
