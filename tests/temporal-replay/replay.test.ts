import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

interface ReplayFixture {
  name: string;
  workflow_id: string;
  file: string;
}

const fixtureDir = fileURLToPath(new URL('./histories', import.meta.url));
const workflowsPath = fileURLToPath(new URL('../../apps/runtime-worker/src/workflows/index.ts', import.meta.url));
const replayFixtures = await loadReplayFixtures();

describe('Temporal workflow replay fixtures', () => {
  if (replayFixtures.length === 0) {
    it.skip('has no exported histories; run pnpm temporal:export-replay-fixtures after a real Temporal smoke run', () => {
      expect(replayFixtures).toHaveLength(0);
    });
    return;
  }

  for (const fixture of replayFixtures) {
    it(`replays ${fixture.name}`, async () => {
      const history = normalizeTemporalHistoryJson(JSON.parse(await readFile(join(fixtureDir, fixture.file), 'utf8')) as unknown);
      await Worker.runReplayHistory({ workflowsPath }, history, fixture.workflow_id);
    }, 30_000);
  }
});

async function loadReplayFixtures(): Promise<ReplayFixture[]> {
  const files = await safeReadDir(fixtureDir);
  if (!files.includes('manifest.json')) {
    return [];
  }
  const manifest = JSON.parse(await readFile(join(fixtureDir, 'manifest.json'), 'utf8')) as { histories?: unknown };
  if (!Array.isArray(manifest.histories)) {
    return [];
  }
  const historyFiles = new Set(files.filter((file) => file.endsWith('.history.json')));
  return manifest.histories
    .map(toReplayFixture)
    .filter((entry): entry is ReplayFixture => Boolean(entry && historyFiles.has(entry.file)));
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function toReplayFixture(value: unknown): ReplayFixture | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.workflow_id !== 'string' || typeof record.file !== 'string') {
    return undefined;
  }
  return {
    name: record.name,
    workflow_id: record.workflow_id,
    file: record.file,
  };
}

function normalizeTemporalHistoryJson(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeTemporalHistoryJson(entry, key));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (isDurationKey(key) && isDurationRecord(record)) {
    return durationToProto3(record);
  }
  if (isTimestampRecord(record)) {
    return timestampToIso(record);
  }
  return Object.fromEntries(
    Object.entries(record).map(([entryKey, entry]) => [entryKey, normalizeTemporalHistoryJson(entry, entryKey)]),
  );
}

function isTimestampRecord(value: Record<string, unknown>): value is { seconds: string | number; nanos?: number } {
  const keys = Object.keys(value);
  return keys.every((key) => key === 'seconds' || key === 'nanos')
    && (typeof value.seconds === 'string' || typeof value.seconds === 'number')
    && (value.nanos === undefined || typeof value.nanos === 'number');
}

function isDurationRecord(value: Record<string, unknown>): value is { seconds?: string | number; nanos?: number } {
  const keys = Object.keys(value);
  return keys.every((key) => key === 'seconds' || key === 'nanos')
    && (value.seconds === undefined || typeof value.seconds === 'string' || typeof value.seconds === 'number')
    && (value.nanos === undefined || typeof value.nanos === 'number');
}

function timestampToIso(value: { seconds: string | number; nanos?: number }): string {
  const seconds = Number(value.seconds);
  const millis = seconds * 1000 + Math.floor((value.nanos ?? 0) / 1_000_000);
  return new Date(millis).toISOString();
}

function isDurationKey(key: string): boolean {
  return /(?:timeout|interval|backoff|duration)/iu.test(key);
}

function durationToProto3(value: { seconds?: string | number; nanos?: number }): string {
  const seconds = String(value.seconds ?? 0);
  const nanos = value.nanos ?? 0;
  if (nanos === 0) {
    return `${seconds}s`;
  }
  return `${seconds}.${String(nanos).padStart(9, '0').replace(/0+$/u, '')}s`;
}
