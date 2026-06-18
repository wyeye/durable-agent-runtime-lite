import type { RouteSpec } from '@dar/contracts';
import { RouteConfigRepository, type Database } from '@dar/db';
import type { Kysely } from 'kysely';
import { defaultRouteSpecs } from './route-registry.js';

export interface RouteSpecSource {
  listPublished(tenantId: string, userId?: string): Promise<RouteSpec[]>;
}

export class MemoryRouteSpecSource implements RouteSpecSource {
  constructor(private readonly routes: RouteSpec[] = defaultRouteSpecs) {}

  async listPublished(_tenantId: string, _userId?: string): Promise<RouteSpec[]> {
    return this.routes.filter((route) => route.status === undefined || route.status === 'published' || route.status === 'gray');
  }
}

export class DbRouteSpecSource implements RouteSpecSource {
  private readonly repository: RouteConfigRepository;

  constructor(db: Kysely<Database>) {
    this.repository = new RouteConfigRepository(db);
  }

  async listPublished(tenantId: string, userId?: string): Promise<RouteSpec[]> {
    const routes = await this.repository.listPublished({ tenantId });
    const selected = new Map<string, RouteSpec>();
    for (const route of routes) {
      const routeId = route.route_id ?? `${route.flow_id}@${route.version}`;
      const record = await this.repository.selectVersionForRequest(routeId, {
        tenantId,
        ...(userId ? { userId } : {}),
      });
      if (record) {
        selected.set(routeId, record.spec);
      }
    }
    return [...selected.values()];
  }
}
