import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactDirectory, prepareArtifactPath } from '../src/commands/smoke.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('repo-cli smoke artifact preparation', () => {
  it('treats json artifact targets as files and only creates their parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dar-smoke-artifact-'));
    tempDirs.push(root);
    const artifact = join(root, 'artifacts/pi-worker-crash-resume/result.json');

    expect(artifactDirectory(artifact)).toBe(join(root, 'artifacts/pi-worker-crash-resume'));

    await prepareArtifactPath(artifact);

    await expect(stat(join(root, 'artifacts/pi-worker-crash-resume'))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(stat(artifact)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps directory artifact targets as directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dar-smoke-artifact-'));
    tempDirs.push(root);
    const artifactDir = join(root, 'artifacts/control-plane-ui-e2e');

    expect(artifactDirectory(artifactDir)).toBe(artifactDir);

    await prepareArtifactPath(artifactDir);

    const info = await stat(artifactDir);
    expect(info.isDirectory()).toBe(true);
  });
});
