import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  sql,
  TenantAgentAdmissionRepository,
} from '../src/index.js';

const runPostgres = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres('tenant agent admission with PostgreSQL locks', () => {
  it.each([1, 2])('does not exceed max_concurrent_agent_runs=%s under concurrent reserve', async (limit) => {
    const tenantId = `tenant_admission_${randomUUID()}`;
    const snapshotRef = `db://tenant-runtime-policy-snapshot/${randomUUID()}`;
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string, maxConnections: 24 });
    try {
      const repository = new TenantAgentAdmissionRepository(db);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          repository.reserve({
            tenantId,
            taskRunId: `task_${index}_${randomUUID()}`,
            policySnapshotRef: snapshotRef,
            maxConcurrentAgentRuns: limit,
          })),
      );
      const accepted = results.filter((result) => result.accepted);
      const rejected = results.filter((result) => !result.accepted);
      expect(accepted).toHaveLength(limit);
      expect(rejected).toHaveLength(20 - limit);
      expect(await repository.getActiveCount(tenantId)).toBe(limit);

      const acceptedRows = await repository.listByTenant(tenantId, { status: 'reserved', limit: 30 });
      const rejectedRows = await repository.listByTenant(tenantId, { status: 'rejected', limit: 30 });
      expect(acceptedRows).toHaveLength(limit);
      expect(rejectedRows).toHaveLength(20 - limit);
      expect(new Set(acceptedRows.map((row) => row.task_run_id)).size).toBe(limit);
      expect(new Set(rejectedRows.map((row) => row.task_run_id)).size).toBe(20 - limit);
    } finally {
      await sql`delete from tenant_agent_admission where tenant_id = ${tenantId}`.execute(db);
      await closeDb(db);
    }
  });

  it('is idempotent for the same task_run_id and rejects a different snapshot for that task', async () => {
    const tenantId = `tenant_admission_${randomUUID()}`;
    const taskRunId = `task_${randomUUID()}`;
    const snapshotRef = `db://tenant-runtime-policy-snapshot/${randomUUID()}`;
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string });
    try {
      const repository = new TenantAgentAdmissionRepository(db);
      const first = await repository.reserve({
        tenantId,
        taskRunId,
        policySnapshotRef: snapshotRef,
        maxConcurrentAgentRuns: 1,
      });
      const second = await repository.reserve({
        tenantId,
        taskRunId,
        policySnapshotRef: snapshotRef,
        maxConcurrentAgentRuns: 1,
      });
      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(true);
      expect(second.admission?.admission_id).toBe(first.admission?.admission_id);
      await expect(repository.reserve({
        tenantId,
        taskRunId,
        policySnapshotRef: `${snapshotRef}_different`,
        maxConcurrentAgentRuns: 1,
      })).rejects.toThrow(/TENANT_AGENT_ADMISSION_SNAPSHOT_CONFLICT/u);
    } finally {
      await sql`delete from tenant_agent_admission where tenant_id = ${tenantId}`.execute(db);
      await closeDb(db);
    }
  });
});
