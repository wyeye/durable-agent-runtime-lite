import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  hashJson,
  RouteConfigRepository,
  RouteEmbeddingRepository,
  sql,
} from '../src/index.js';

const runPostgres = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describePostgres = runPostgres ? describe : describe.skip;

function vector(first: number, second = 0): number[] {
  return [first, second, ...Array.from({ length: 1534 }, () => 0)];
}

describePostgres('route embedding repository with PostgreSQL', () => {
  it('replaces exact route embeddings and searches top-k with model, tenant, allowed-route, aggregation, and stable sorting', async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string });
    const tenantId = `tenant_${randomUUID()}`;
    const otherTenantId = `tenant_${randomUUID()}`;
    const suffix = randomUUID();
    const routeA = `route_a_${suffix}`;
    const routeB = `route_b_${suffix}`;
    const routeC = `route_c_${suffix}`;
    const modelId = `embedding_${suffix}`;
    const modelHash = 'a'.repeat(64);
    const otherModelHash = 'b'.repeat(64);
    const embeddings = new RouteEmbeddingRepository(db);
    const routes = new RouteConfigRepository(db);

    try {
      await routes.upsert(routeSpec(routeA, `flow_a_${suffix}`, 90), {
        tenantId,
        status: 'published',
        createdBy: 'test',
      });
      await routes.upsert(routeSpec(routeB, `flow_b_${suffix}`, 80), {
        tenantId,
        status: 'published',
        createdBy: 'test',
      });
      await routes.upsert(routeSpec(routeC, `flow_c_${suffix}`, 90), {
        tenantId,
        status: 'published',
        createdBy: 'test',
      });
      await routes.upsert(routeSpec(routeA, `flow_a_${suffix}`, 90), {
        tenantId: otherTenantId,
        status: 'published',
        createdBy: 'test',
      });

      await embeddings.replaceForRoute({
        tenantId,
        routeId: routeA,
        flowVersion: 1,
        routeConfigSha256: '1'.repeat(64),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        rows: [
          row(tenantId, routeA, `flow_a_${suffix}`, '1'.repeat(64), modelId, modelHash, 0, vector(0.99)),
          row(tenantId, routeA, `flow_a_${suffix}`, '1'.repeat(64), modelId, modelHash, 1, vector(0.5)),
        ],
      });
      await embeddings.replaceForRoute({
        tenantId,
        routeId: routeB,
        flowVersion: 1,
        routeConfigSha256: '2'.repeat(64),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        rows: [row(tenantId, routeB, `flow_b_${suffix}`, '2'.repeat(64), modelId, modelHash, 0, vector(0.99))],
      });
      await embeddings.replaceForRoute({
        tenantId,
        routeId: routeC,
        flowVersion: 1,
        routeConfigSha256: '3'.repeat(64),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        rows: [row(tenantId, routeC, `flow_c_${suffix}`, '3'.repeat(64), modelId, modelHash, 0, vector(0.1, 0.9))],
      });
      await embeddings.replaceForRoute({
        tenantId: otherTenantId,
        routeId: routeA,
        flowVersion: 1,
        routeConfigSha256: '1'.repeat(64),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        rows: [row(otherTenantId, routeA, `flow_a_${suffix}`, '1'.repeat(64), modelId, modelHash, 0, vector(1))],
      });

      expect(await embeddings.hasExactIndex({
        tenantId,
        routeId: routeA,
        flowVersion: 1,
        routeConfigSha256: '1'.repeat(64),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        expectedSourceCount: 2,
      })).toBe(true);

      const firstSearch = await embeddings.searchTopK({
        tenantId,
        queryEmbedding: vector(1),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        allowedRoutes: allowedRouteVersions([routeA, routeB, routeC]),
        topK: 3,
      });
      expect(firstSearch.map((candidate) => candidate.route_id)).toEqual([routeA, routeB, routeC]);
      expect(firstSearch[0]?.matched_source_type).toBe('example');
      expect(firstSearch[0]?.matched_source_hash).toMatch(/^[a-f0-9]{64}$/u);

      await embeddings.replaceForRoute({
        tenantId,
        routeId: routeA,
        flowVersion: 1,
        routeConfigSha256: '4'.repeat(64),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        rows: [row(tenantId, routeA, `flow_a_${suffix}`, '4'.repeat(64), modelId, modelHash, 0, vector(0.2, 0.8))],
      });
      expect(await embeddings.hasExactIndex({
        tenantId,
        routeId: routeA,
        flowVersion: 1,
        routeConfigSha256: '1'.repeat(64),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
      })).toBe(false);

      const afterReplace = await embeddings.searchTopK({
        tenantId,
        queryEmbedding: vector(1),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        allowedRoutes: allowedRouteVersions([routeA, routeB]),
        topK: 5,
      });
      expect(afterReplace.map((candidate) => candidate.route_id)).toEqual([routeB, routeA]);

      await routes.upsert(routeSpec(routeA, `flow_a_${suffix}`, 90, 2), {
        tenantId,
        status: 'published',
        createdBy: 'test',
      });
      await embeddings.replaceForRoute({
        tenantId,
        routeId: routeA,
        flowVersion: 2,
        routeConfigSha256: '5'.repeat(64),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        rows: [row(tenantId, routeA, `flow_a_${suffix}`, '5'.repeat(64), modelId, modelHash, 0, vector(1), 2)],
      });
      const versionFiltered = await embeddings.searchTopK({
        tenantId,
        queryEmbedding: vector(1),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        allowedRoutes: [{ routeId: routeA, flowVersion: 2 }],
        topK: 5,
      });
      expect(versionFiltered).toHaveLength(1);
      expect(versionFiltered[0]?.flow_version).toBe(2);

      expect(await embeddings.searchTopK({
        tenantId,
        queryEmbedding: vector(1),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: otherModelHash,
        allowedRoutes: allowedRouteVersions([routeA, routeB]),
        topK: 5,
      })).toEqual([]);
      expect(await embeddings.searchTopK({
        tenantId: otherTenantId,
        queryEmbedding: vector(1),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        allowedRoutes: allowedRouteVersions([routeA]),
        topK: 5,
      })).toHaveLength(1);
      expect(await embeddings.searchTopK({
        tenantId,
        queryEmbedding: vector(1),
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
        allowedRoutes: allowedRouteVersions([routeA]),
        topK: 5,
      })).toHaveLength(1);

      const coverage = await embeddings.listCoverage({
        tenantId,
        routeIds: [routeA, routeB],
        embeddingModelId: modelId,
        embeddingModelVersion: 1,
        embeddingModelHash: modelHash,
      });
      expect(coverage.map((item) => ({
        route_id: item.route_id,
        flow_version: item.flow_version,
        route_config_sha256: item.route_config_sha256,
        source_count: item.source_count,
      }))).toEqual([
        { route_id: routeA, flow_version: 2, route_config_sha256: '5'.repeat(64), source_count: 1 },
        { route_id: routeA, flow_version: 1, route_config_sha256: '4'.repeat(64), source_count: 1 },
        { route_id: routeB, flow_version: 1, route_config_sha256: '2'.repeat(64), source_count: 1 },
      ]);
    } finally {
      await sql`delete from flow_route_embedding where tenant_id in (${tenantId}, ${otherTenantId})`.execute(db);
      await sql`delete from flow_route_config where tenant_id in (${tenantId}, ${otherTenantId})`.execute(db);
      await closeDb(db);
    }
  });
});

function allowedRouteVersions(routeIds: string[], flowVersion = 1): Array<{ routeId: string; flowVersion: number }> {
  return routeIds.map((routeId) => ({ routeId, flowVersion }));
}

function routeSpec(routeId: string, flowId: string, priority: number, version = 1) {
  return {
    route_id: routeId,
    flow_id: flowId,
    version,
    status: 'published' as const,
    route: {
      priority,
      keywords: [],
      examples: ['example'],
      negative_examples: [],
      supported_channels: [],
      role_constraints: [],
      confidence_threshold: 0.7,
      ambiguous_threshold: 0.5,
    },
  };
}

function row(
  tenantId: string,
  routeId: string,
  flowId: string,
  routeConfigSha256: string,
  embeddingModelId: string,
  embeddingModelHash: string,
  sourceIndex: number,
  embedding: number[],
  flowVersion = 1,
) {
  return {
    tenantId,
    routeId,
    flowId,
    flowVersion,
    routeConfigSha256,
    sourceType: 'example' as const,
    sourceIndex,
    sourceText: `${routeId}-${sourceIndex}`,
    embedding,
    embeddingModelId,
    embeddingModelVersion: 1,
    embeddingModelHash,
    embeddingDimensions: 1536,
    embeddingHash: hashJson(embedding),
  };
}
