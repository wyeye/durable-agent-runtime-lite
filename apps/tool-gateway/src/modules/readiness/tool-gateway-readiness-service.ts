import type { RuntimeConfig } from '@dar/config';
import {
  TenantRuntimePolicySnapshotRepository,
  type Database,
  sql,
} from '@dar/db';
import { StaticServiceTokenVerifier } from '@dar/security';
import type { Kysely } from 'kysely';
import type { ToolManifestRegistry } from '../tool-registry.js';
import type { TenantPolicySnapshotLookupStore } from '../tool-service.js';

export type ToolGatewayReadinessCheckName =
  | 'config'
  | 'database'
  | 'tool_registry'
  | 'policy_snapshot_store'
  | 'service_auth';
export type ToolGatewayReadinessCheckStatus = 'ok' | 'failed' | 'timeout';

export interface ToolGatewayReadinessCheck {
  status: ToolGatewayReadinessCheckStatus;
  code?: string;
  duration_ms: number;
}

export interface ToolGatewayReadinessResult {
  ready: boolean;
  checked_at: string;
  duration_ms: number;
  checks: Record<ToolGatewayReadinessCheckName, ToolGatewayReadinessCheck>;
}

export interface ToolGatewayReadinessServiceOptions {
  config: RuntimeConfig;
  db?: Kysely<Database>;
  registry?: ToolManifestRegistry;
  tenantPolicySnapshotStore?: TenantPolicySnapshotLookupStore;
  probeTimeoutMs?: number;
  cacheTtlMs?: number;
  databaseProbe?: () => Promise<void>;
}

export class ToolGatewayReadinessService {
  private readonly probeTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private cached?: { expiresAt: number; result: ToolGatewayReadinessResult };

  constructor(private readonly options: ToolGatewayReadinessServiceOptions) {
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1_500;
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
  }

  async check(): Promise<ToolGatewayReadinessResult> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.result;
    }
    const startedAt = Date.now();
    const checks: Record<ToolGatewayReadinessCheckName, ToolGatewayReadinessCheck> = {
      config: await this.runProbe('config', () => this.checkConfig()),
      database: await this.runProbe('database', () => this.checkDatabase()),
      tool_registry: await this.runProbe('tool_registry', () => this.checkToolRegistry()),
      policy_snapshot_store: await this.runProbe('policy_snapshot_store', () => this.checkPolicySnapshotStore()),
      service_auth: await this.runProbe('service_auth', () => this.checkServiceAuth()),
    };
    const result: ToolGatewayReadinessResult = {
      ready: Object.values(checks).every((check) => check.status === 'ok'),
      checked_at: new Date().toISOString(),
      duration_ms: Math.max(0, Date.now() - startedAt),
      checks,
    };
    this.cached = { expiresAt: Date.now() + this.cacheTtlMs, result };
    return result;
  }

  private async runProbe(name: ToolGatewayReadinessCheckName, probe: () => Promise<void> | void): Promise<ToolGatewayReadinessCheck> {
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
      if (config.TOOL_GATEWAY_REGISTRY_SOURCE !== 'db') {
        throw new Error('invalid_registry_source');
      }
      if (config.TOOL_GATEWAY_AUTH_MODE !== 'service_token') {
        throw new Error('invalid_auth_mode');
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
      if (this.options.config.TOOL_GATEWAY_REGISTRY_SOURCE === 'db') {
        throw new Error('database_not_configured');
      }
      return;
    }
    await sql`select 1`.execute(this.options.db);
  }

  private async checkToolRegistry(): Promise<void> {
    if (!this.options.registry) {
      if (this.options.config.TOOL_GATEWAY_REGISTRY_SOURCE === 'db') {
        throw new Error('tool_registry_not_configured');
      }
      return;
    }
    await this.options.registry.list('__readiness__');
  }

  private async checkPolicySnapshotStore(): Promise<void> {
    if (this.options.config.TENANT_RUNTIME_POLICY_MODE !== 'required') {
      return;
    }
    if (this.options.tenantPolicySnapshotStore) {
      await this.options.tenantPolicySnapshotStore.getByRef('__readiness__', { tenantId: '__readiness__' });
      return;
    }
    if (!this.options.db) {
      throw new Error('policy_snapshot_store_not_configured');
    }
    await new TenantRuntimePolicySnapshotRepository(this.options.db).getByRef('__readiness__', {
      tenantId: '__readiness__',
    });
  }

  private checkServiceAuth(): void {
    const verifier = new StaticServiceTokenVerifier({
      authMode: this.options.config.TOOL_GATEWAY_AUTH_MODE,
      nodeEnv: this.options.config.NODE_ENV,
      tokens: {
        'runtime-worker': this.options.config.TOOL_GATEWAY_RUNTIME_WORKER_TOKEN,
        'control-plane': this.options.config.TOOL_GATEWAY_CONTROL_PLANE_TOKEN,
      },
    });
    verifier.validateConfiguration();
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
