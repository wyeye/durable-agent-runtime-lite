import { Connection } from '@temporalio/client';
import type { RuntimeConfig } from '@dar/config';
import {
  ModelDefinitionRepository,
  ModelGatewayProfileRepository,
  TenantRuntimePolicyRepository,
  type Database,
  sql,
} from '@dar/db';
import type { Kysely } from 'kysely';
import type { RouteSpecSource } from '../router/route-source.js';

export type ReadinessCheckName = 'config' | 'database' | 'route_registry' | 'semantic_router' | 'temporal' | 'tenant_policy' | 'auth';
export type ReadinessCheckStatus = 'ok' | 'failed' | 'timeout';

export interface ReadinessCheck {
  status: ReadinessCheckStatus;
  code?: string;
  duration_ms: number;
}

export interface ReadinessResult {
  ready: boolean;
  checked_at: string;
  duration_ms: number;
  checks: Record<ReadinessCheckName, ReadinessCheck>;
}

export interface RuntimeApiReadinessServiceOptions {
  config: RuntimeConfig;
  db?: Kysely<Database>;
  routeSource?: RouteSpecSource;
  probeTimeoutMs?: number;
  cacheTtlMs?: number;
  databaseProbe?: () => Promise<void>;
  temporalProbe?: () => Promise<void>;
  tenantPolicyProbe?: () => Promise<void>;
}

export class RuntimeApiReadinessService {
  private readonly probeTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private cached?: { expiresAt: number; result: ReadinessResult };

  constructor(private readonly options: RuntimeApiReadinessServiceOptions) {
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1_500;
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
  }

  async check(): Promise<ReadinessResult> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.result;
    }

    const startedAt = Date.now();
    const checks: Record<ReadinessCheckName, ReadinessCheck> = {
      config: await this.runProbe('config', () => this.checkConfig()),
      database: await this.runProbe('database', () => this.checkDatabase()),
      route_registry: await this.runProbe('route_registry', () => this.checkRouteRegistry()),
      semantic_router: await this.runProbe('semantic_router', () => this.checkSemanticRouter()),
      temporal: await this.runProbe('temporal', () => this.checkTemporal()),
      tenant_policy: await this.runProbe('tenant_policy', () => this.checkTenantPolicy()),
      auth: await this.runProbe('auth', () => this.checkAuth()),
    };
    const result: ReadinessResult = {
      ready: Object.values(checks).every((check) => check.status === 'ok'),
      checked_at: new Date().toISOString(),
      duration_ms: Math.max(0, Date.now() - startedAt),
      checks,
    };
    this.cached = { expiresAt: Date.now() + this.cacheTtlMs, result };
    return result;
  }

  private async runProbe(name: ReadinessCheckName, probe: () => Promise<void> | void): Promise<ReadinessCheck> {
    const startedAt = Date.now();
    try {
      await withTimeout(Promise.resolve().then(probe), this.probeTimeoutMs);
      return { status: 'ok', duration_ms: Math.max(0, Date.now() - startedAt) };
    } catch (error) {
      return {
        status: isTimeoutError(error) ? 'timeout' : 'failed',
        code: `${name.toUpperCase()}_${isTimeoutError(error) ? 'TIMEOUT' : 'UNAVAILABLE'}`,
        duration_ms: Math.max(0, Date.now() - startedAt),
      };
    }
  }

  private checkConfig(): void {
    const { config } = this.options;
    if (isProductionRuntime(config)) {
      if (config.RUNTIME_API_AUTH_MODE !== 'header') {
        throw new Error('invalid_auth_mode');
      }
      if (config.RUNTIME_API_ROUTE_SOURCE !== 'db') {
        throw new Error('invalid_route_source');
      }
      if (config.RUNTIME_API_WORKFLOW_STARTER !== 'temporal') {
        throw new Error('invalid_workflow_starter');
      }
      if (config.TENANT_RUNTIME_POLICY_MODE !== 'required') {
        throw new Error('invalid_tenant_policy_mode');
      }
    }
  }

  private async checkDatabase(): Promise<void> {
    if (this.options.databaseProbe) {
      await this.options.databaseProbe();
      return;
    }
    if (!this.options.db) {
      if (this.options.config.RUNTIME_API_ROUTE_SOURCE === 'db') {
        throw new Error('database_not_configured');
      }
      return;
    }
    await sql`select 1`.execute(this.options.db);
  }

  private async checkRouteRegistry(): Promise<void> {
    if (!this.options.routeSource) {
      if (this.options.config.RUNTIME_API_ROUTE_SOURCE === 'db') {
        throw new Error('route_registry_not_configured');
      }
      return;
    }
    await this.options.routeSource.listPublished('__readiness__', '__readiness__');
  }

  private async checkSemanticRouter(): Promise<void> {
    const { config, db } = this.options;
    if (!config.ROUTER_SEMANTIC_ENABLED) {
      return;
    }
    if (!config.ROUTER_EMBEDDING_MODEL_ID || !config.ROUTER_EMBEDDING_MODEL_VERSION) {
      throw new Error('router_embedding_model_not_configured');
    }
    if (!db) {
      throw new Error('semantic_router_database_not_configured');
    }
    const model = await new ModelDefinitionRepository(db).get(
      config.ROUTER_EMBEDDING_MODEL_ID,
      config.ROUTER_EMBEDDING_MODEL_VERSION,
    );
    if (
      !model ||
      model.status !== 'published' ||
      !model.capabilities.includes('embeddings') ||
      model.embedding_dimensions !== 1536
    ) {
      throw new Error('router_embedding_model_invalid');
    }
    const profile = await new ModelGatewayProfileRepository(db).get(model.gateway_profile_id);
    if (!profile || profile.status !== 'published' || profile.config_hash !== model.gateway_profile_config_hash) {
      throw new Error('router_embedding_gateway_invalid');
    }
  }

  private async checkTemporal(): Promise<void> {
    if (this.options.config.RUNTIME_API_WORKFLOW_STARTER !== 'temporal') {
      return;
    }
    if (this.options.temporalProbe) {
      await this.options.temporalProbe();
      return;
    }
    const connection = await Connection.connect({ address: this.options.config.TEMPORAL_ADDRESS });
    try {
      await connection.workflowService.getSystemInfo({});
    } finally {
      await connection.close();
    }
  }

  private async checkTenantPolicy(): Promise<void> {
    if (this.options.config.TENANT_RUNTIME_POLICY_MODE !== 'required') {
      return;
    }
    if (this.options.tenantPolicyProbe) {
      await this.options.tenantPolicyProbe();
      return;
    }
    if (!this.options.db) {
      throw new Error('tenant_policy_repository_not_configured');
    }
    await new TenantRuntimePolicyRepository(this.options.db).list({
      tenantId: '__readiness__',
      limit: 1,
    });
  }

  private checkAuth(): void {
    const { config } = this.options;
    if (isProductionRuntime(config) && config.RUNTIME_API_AUTH_MODE !== 'header') {
      throw new Error('invalid_auth_mode');
    }
  }
}

function isProductionRuntime(config: RuntimeConfig): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}

class ProbeTimeoutError extends Error {
  constructor() {
    super('probe_timeout');
    this.name = 'ProbeTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof ProbeTimeoutError;
}
