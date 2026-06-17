import type { RouteSpec } from '@dar/contracts';
import { RouteConfigRepository, type Database } from '@dar/db';
import type { Kysely } from 'kysely';
import { defaultRouteSpecs } from './route-registry.js';

export interface RouteSpecSource {
  listPublished(tenantId: string): Promise<RouteSpec[]>;
}

export class MemoryRouteSpecSource implements RouteSpecSource {
  constructor(private readonly routes: RouteSpec[] = defaultRouteSpecs) {}

  async listPublished(_tenantId: string): Promise<RouteSpec[]> {
    return this.routes.filter((route) => route.status !== 'disabled' && route.status !== 'archived');
  }
}

export class DbRouteSpecSource implements RouteSpecSource {
  private readonly repository: RouteConfigRepository;

  constructor(db: Kysely<Database>) {
    this.repository = new RouteConfigRepository(db);
  }

  async listPublished(tenantId: string): Promise<RouteSpec[]> {
    return this.repository.listPublished({ tenantId });
  }
}
