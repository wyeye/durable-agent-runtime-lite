import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { FlowSpec } from '@dar/contracts';
import {
  CapabilityReleaseRepository,
  closeDb,
  createDb,
  FlowDefinitionRepository,
  RegistryRepositoryError,
  RouteConfigRepository,
  sql,
} from '../src/index.js';

const runPostgres = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describePostgres = runPostgres ? describe : describe.skip;

function flow(flowId: string, version: number): FlowSpec {
  return {
    flow_id: flowId,
    version,
    status: 'draft',
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    steps: [{ id: 'one', type: 'activity', activity: 'noop' }],
  };
}

describePostgres('registry repositories with PostgreSQL', () => {
  it('supports draft lifecycle, optimistic locking, clone, release history, gray selection, and archived migration compatibility', async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string });
    const tenantId = `tenant_${randomUUID()}`;
    const flowId = `flow_${randomUUID()}`;
    const routeId = `route_${randomUUID()}`;
    try {
      const migrationSql = await readFile(new URL('../../../db/migrations/004_control_plane_registry.sql', import.meta.url), 'utf8');
      expect(migrationSql).toContain("status = 'deprecated'");
      expect(migrationSql).toContain('capability_release');

      const flows = new FlowDefinitionRepository(db);
      const draft = await flows.createDraft(flow(flowId, 1), { tenantId, operatorId: 'tester' });
      expect(draft.status).toBe('draft');
      expect(draft.revision).toBe(1);

      const updated = await flows.updateDraft(flowId, 1, {
        tenantId,
        operatorId: 'tester',
        expectedRevision: 1,
        spec: { ...flow(flowId, 1), name: 'Updated draft' },
      });
      expect(updated.revision).toBe(2);
      await expect(flows.updateDraft(flowId, 1, {
        tenantId,
        operatorId: 'tester',
        expectedRevision: 1,
        spec: flow(flowId, 1),
      })).rejects.toMatchObject({ code: 'REGISTRY_OPTIMISTIC_LOCK_CONFLICT' });

      await flows.markValidated(flowId, 1, { tenantId, operatorId: 'tester' });
      await flows.publish(flowId, 1, { tenantId, operatorId: 'tester' });
      await expect(flows.updateDraft(flowId, 1, {
        tenantId,
        operatorId: 'tester',
        expectedRevision: 4,
        spec: flow(flowId, 1),
      })).rejects.toBeInstanceOf(RegistryRepositoryError);

      const clone = await flows.cloneVersion(flowId, 1, { tenantId, operatorId: 'tester' });
      expect(clone.version).toBe(2);
      const versions = await flows.listVersions(flowId, { tenantId });
      expect(versions.map((version) => version.version)).toEqual([2, 1]);

      await flows.markValidated(flowId, 2, { tenantId, operatorId: 'tester' });
      await flows.publish(flowId, 2, { tenantId, operatorId: 'tester' });
      await flows.rollback(flowId, 1, { tenantId, operatorId: 'tester' });
      const afterRollback = await flows.getByIdAndVersion(flowId, 2, { tenantId });
      expect(afterRollback?.status).toBe('deprecated');
      expect((await flows.getByIdAndVersion(flowId, 1, { tenantId }))?.status).toBe('published');

      await flows.setGray(flowId, 1, {
        tenantId,
        operatorId: 'tester',
        grayPolicy: { tenant_allowlist: [tenantId], user_allowlist: ['user_a'] },
      });
      await flows.publish(flowId, 1, { tenantId, operatorId: 'tester' });
      expect((await flows.selectVersionForRequest(flowId, { tenantId, userId: 'user_a' }))?.version).toBe(1);

      const route = new RouteConfigRepository(db);
      await route.createDraft({
        route_id: routeId,
        flow_id: flowId,
        version: 1,
        status: 'draft',
        route: { keywords: ['registry-test'], examples: [], negative_examples: [], supported_channels: [], role_constraints: [], priority: 50, confidence_threshold: 0.7, ambiguous_threshold: 0.5 },
      }, { tenantId, operatorId: 'tester' });
      expect((await route.listVersions(routeId, { tenantId }))).toHaveLength(1);

      const release = await new CapabilityReleaseRepository(db).append({
        tenant_id: tenantId,
        resource_type: 'flow',
        resource_id: flowId,
        resource_version: 1,
        action: 'publish',
        target_status: 'published',
        operator_id: 'tester',
        metadata_json: {},
      });
      expect(await flows.listReleaseHistory(flowId, { tenantId })).toMatchObject([{ release_id: release.release_id }]);

      await sql`
        update flow_definition
        set status = 'archived',
            spec_json = jsonb_set(spec_json, '{status}', '"archived"', true)
        where tenant_id = ${tenantId}
          and flow_id = ${flowId}
          and version = 1
      `.execute(db);
      await sql`
        update flow_definition
        set status = 'deprecated',
            spec_json = jsonb_set(spec_json, '{status}', '"deprecated"', true)
        where status = 'archived'
      `.execute(db);
      expect((await flows.getByIdAndVersion(flowId, 1, { tenantId }))?.status).toBe('deprecated');
    } finally {
      await closeDb(db);
    }
  });
});
