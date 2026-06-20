import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  capabilityReleaseSchema,
  grayPolicySchema,
  specStatusSchema,
  validateSpecStatusTransition,
  type CapabilityRelease,
  type CapabilityReleaseAction,
  type GrayPolicy,
  type RegistryResourceType,
  type RegistryValidationResult,
  type SpecStatus,
} from '@dar/contracts';
import type { Database } from './index.js';

export type RegistryVersion = number;

export interface RegistryResourceRecord<TSpec extends object> {
  tenant_id: string;
  resource_type: RegistryResourceType;
  resource_id: string;
  version: RegistryVersion;
  status: SpecStatus;
  spec: TSpec;
  sha256: string;
  created_by?: string;
  updated_by?: string;
  published_by?: string;
  created_at: string;
  updated_at: string;
  published_at?: string;
  revision: number;
  gray_policy: GrayPolicy;
}

export interface RegistryListOptions {
  tenantId?: string;
  status?: SpecStatus | readonly SpecStatus[];
}

export interface RegistryWriteOptions {
  tenantId?: string;
  operatorId: string;
}

export interface RegistryUpdateDraftInput<TSpec extends object> extends RegistryWriteOptions {
  spec: TSpec;
  expectedRevision: number;
}

export interface RegistryCloneOptions extends RegistryWriteOptions {
  version?: number;
}

export interface RegistryStatusOptions extends RegistryWriteOptions {
  expectedRevision?: number;
  grayPolicy?: GrayPolicy;
}

export interface RegistryRollbackOptions extends RegistryWriteOptions {
  releaseNote?: string;
  validationResult?: RegistryValidationResult;
  metadata?: Record<string, unknown>;
}

export class RegistryRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RegistryRepositoryError';
  }
}

interface RegistrySpecRow {
  tenant_id: string;
  resource_id: string;
  version: number;
  status: string;
  spec_json: unknown;
  sha256: string;
  created_by: string | null;
  updated_by: string | null;
  published_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  published_at: Date | string | null;
  revision: number;
  gray_policy_json: unknown;
}

interface RegistryDefinition<TSpec extends object> {
  resourceType: RegistryResourceType;
  tableName: string;
  idColumn: string;
  versionColumn: string;
  jsonColumn: string;
  schema: { parse(input: unknown): TSpec };
  getSpecId(spec: TSpec): string;
  getSpecVersion(spec: TSpec): number;
  withIdentity(spec: TSpec, resourceId: string, version: number, status: SpecStatus): TSpec;
  insertExtraColumns?(spec: TSpec): Record<string, unknown>;
  updateExtraColumns?(spec: TSpec): Record<string, unknown>;
}

export class VersionedRegistryRepository<TSpec extends object> {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly definition: RegistryDefinition<TSpec>,
  ) {}

  async list(options: RegistryListOptions = {}): Promise<RegistryResourceRecord<TSpec>[]> {
    const tenantId = tenant(options);
    const statuses = normalizeStatuses(options.status);
    const statusSql = statuses.length > 0
      ? sql`and status in (${sql.join(statuses)})`
      : sql``;
    const result = await sql<RegistrySpecRow>`
      select
        tenant_id,
        ${sql.ref(this.definition.idColumn)} as resource_id,
        ${sql.ref(this.definition.versionColumn)} as version,
        status,
        ${sql.ref(this.definition.jsonColumn)} as spec_json,
        sha256,
        created_by,
        updated_by,
        published_by,
        created_at,
        updated_at,
        published_at,
        revision,
        gray_policy_json
      from ${sql.table(this.definition.tableName)}
      where tenant_id = ${tenantId}
      ${statusSql}
      order by ${sql.ref(this.definition.idColumn)} asc, ${sql.ref(this.definition.versionColumn)} desc
    `.execute(this.db);

    return result.rows.map((row) => this.mapRow(row));
  }

  async getByIdAndVersion(
    resourceId: string,
    version: number,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<TSpec> | undefined> {
    const tenantId = tenant(options);
    const result = await sql<RegistrySpecRow>`
      select
        tenant_id,
        ${sql.ref(this.definition.idColumn)} as resource_id,
        ${sql.ref(this.definition.versionColumn)} as version,
        status,
        ${sql.ref(this.definition.jsonColumn)} as spec_json,
        sha256,
        created_by,
        updated_by,
        published_by,
        created_at,
        updated_at,
        published_at,
        revision,
        gray_policy_json
      from ${sql.table(this.definition.tableName)}
      where tenant_id = ${tenantId}
        and ${sql.ref(this.definition.idColumn)} = ${resourceId}
        and ${sql.ref(this.definition.versionColumn)} = ${version}
      limit 1
    `.execute(this.db);

    const row = result.rows[0];
    return row ? this.mapRow(row) : undefined;
  }

  async getLatestVersion(resourceId: string, options: RegistryListOptions = {}): Promise<RegistryResourceRecord<TSpec> | undefined> {
    return this.getLatestByStatus(resourceId, undefined, options);
  }

  async getLatestPublishedVersion(resourceId: string, options: RegistryListOptions = {}): Promise<RegistryResourceRecord<TSpec> | undefined> {
    return this.getLatestByStatus(resourceId, 'published', options);
  }

  async listVersions(resourceId: string, options: RegistryListOptions = {}): Promise<RegistryResourceRecord<TSpec>[]> {
    const tenantId = tenant(options);
    const result = await sql<RegistrySpecRow>`
      select
        tenant_id,
        ${sql.ref(this.definition.idColumn)} as resource_id,
        ${sql.ref(this.definition.versionColumn)} as version,
        status,
        ${sql.ref(this.definition.jsonColumn)} as spec_json,
        sha256,
        created_by,
        updated_by,
        published_by,
        created_at,
        updated_at,
        published_at,
        revision,
        gray_policy_json
      from ${sql.table(this.definition.tableName)}
      where tenant_id = ${tenantId}
        and ${sql.ref(this.definition.idColumn)} = ${resourceId}
      order by ${sql.ref(this.definition.versionColumn)} desc
    `.execute(this.db);

    return result.rows.map((row) => this.mapRow(row));
  }

  async createDraft(spec: TSpec, options: RegistryWriteOptions): Promise<RegistryResourceRecord<TSpec>> {
    const tenantId = tenant(options);
    const resourceId = this.definition.getSpecId(spec);
    const version = this.definition.getSpecVersion(spec);
    const normalized = this.definition.withIdentity(spec, resourceId, version, 'draft');
    const parsed = this.definition.schema.parse(normalized);
    const now = new Date();
    const saved = await this.insertRecord({
      tenantId,
      resourceId,
      version,
      status: 'draft',
      spec: parsed,
      sha256: hashJson(parsed),
      operatorId: options.operatorId,
      now,
      revision: 1,
      grayPolicy: {},
    });

    return saved;
  }

  async updateDraft(
    resourceId: string,
    version: number,
    input: RegistryUpdateDraftInput<TSpec>,
  ): Promise<RegistryResourceRecord<TSpec>> {
    const existing = await this.requireRecord(resourceId, version, input);
    if (existing.status !== 'draft' && existing.status !== 'validated') {
      throw new RegistryRepositoryError('REGISTRY_VERSION_IMMUTABLE', 'Only draft or validated versions can be updated', {
        resource_type: this.definition.resourceType,
        resource_id: resourceId,
        version,
        status: existing.status,
      });
    }
    if (existing.revision !== input.expectedRevision) {
      throw new RegistryRepositoryError('REGISTRY_OPTIMISTIC_LOCK_CONFLICT', 'Registry resource revision conflict', {
        resource_type: this.definition.resourceType,
        resource_id: resourceId,
        version,
        expected_revision: input.expectedRevision,
        actual_revision: existing.revision,
      });
    }

    if (existing.status === 'validated') {
      assertTransition('validated', 'draft');
    }

    const normalized = this.definition.withIdentity(input.spec, resourceId, version, 'draft');
    const parsed = this.definition.schema.parse(normalized);
    const extraSet = extraSetSql(this.definition.updateExtraColumns?.(parsed) ?? {});
    const result = await sql<RegistrySpecRow>`
      update ${sql.table(this.definition.tableName)}
      set
        status = 'draft',
        ${sql.ref(this.definition.jsonColumn)} = ${parsed},
        sha256 = ${hashJson(parsed)},
        updated_by = ${input.operatorId},
        updated_at = now(),
        revision = revision + 1
        ${extraSet}
      where tenant_id = ${tenant(input)}
        and ${sql.ref(this.definition.idColumn)} = ${resourceId}
        and ${sql.ref(this.definition.versionColumn)} = ${version}
        and revision = ${input.expectedRevision}
      returning
        tenant_id,
        ${sql.ref(this.definition.idColumn)} as resource_id,
        ${sql.ref(this.definition.versionColumn)} as version,
        status,
        ${sql.ref(this.definition.jsonColumn)} as spec_json,
        sha256,
        created_by,
        updated_by,
        published_by,
        created_at,
        updated_at,
        published_at,
        revision,
        gray_policy_json
    `.execute(this.db);

    const row = result.rows[0];
    if (!row) {
      throw new RegistryRepositoryError('REGISTRY_OPTIMISTIC_LOCK_CONFLICT', 'Registry resource revision conflict', {
        resource_type: this.definition.resourceType,
        resource_id: resourceId,
        version,
        expected_revision: input.expectedRevision,
      });
    }
    return this.mapRow(row);
  }

  async cloneVersion(
    resourceId: string,
    version: number,
    options: RegistryCloneOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    const source = await this.requireRecord(resourceId, version, options);
    const nextVersion = options.version ?? (await this.nextVersion(resourceId, options));
    const cloned = this.definition.withIdentity(source.spec, resourceId, nextVersion, 'draft');
    const parsed = this.definition.schema.parse(cloned);
    return this.insertRecord({
      tenantId: tenant(options),
      resourceId,
      version: nextVersion,
      status: 'draft',
      spec: parsed,
      sha256: hashJson(parsed),
      operatorId: options.operatorId,
      now: new Date(),
      revision: 1,
      grayPolicy: {},
    });
  }

  async markValidated(
    resourceId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    return this.transition(resourceId, version, 'validated', options);
  }

  async publish(
    resourceId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    return this.transition(resourceId, version, 'published', options);
  }

  async setGray(
    resourceId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    return this.transition(resourceId, version, 'gray', options);
  }

  async deprecate(
    resourceId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    return this.transition(resourceId, version, 'deprecated', options);
  }

  async disable(
    resourceId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    return this.transition(resourceId, version, 'disabled', options);
  }

  async rollback(
    resourceId: string,
    targetVersion: number,
    options: RegistryRollbackOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    const target = await this.requireRecord(resourceId, targetVersion, options);
    if (target.status !== 'published') {
      throw new RegistryRepositoryError('REGISTRY_ROLLBACK_TARGET_NOT_PUBLISHED', 'Rollback target must already be published', {
        resource_type: this.definition.resourceType,
        resource_id: resourceId,
        target_version: targetVersion,
        status: target.status,
      });
    }

    await sql`
      update ${sql.table(this.definition.tableName)}
      set
        status = 'deprecated',
        ${sql.ref(this.definition.jsonColumn)} = jsonb_set(${sql.ref(this.definition.jsonColumn)}::jsonb, '{status}', '"deprecated"', true),
        updated_by = ${options.operatorId},
        updated_at = now(),
        revision = revision + 1
      where tenant_id = ${tenant(options)}
        and ${sql.ref(this.definition.idColumn)} = ${resourceId}
        and ${sql.ref(this.definition.versionColumn)} > ${targetVersion}
        and status in ('published', 'gray')
    `.execute(this.db);

    return this.requireRecord(resourceId, targetVersion, options);
  }

  async listReleaseHistory(resourceId: string, options: RegistryListOptions = {}): Promise<CapabilityRelease[]> {
    return new CapabilityReleaseRepository(this.db).list({
      tenantId: tenant(options),
      resourceType: this.definition.resourceType,
      resourceId,
    });
  }

  async selectVersionForRequest(
    resourceId: string,
    input: { tenantId?: string; userId?: string },
  ): Promise<RegistryResourceRecord<TSpec> | undefined> {
    const listOptions: RegistryListOptions = input.tenantId ? { tenantId: input.tenantId } : {};
    const versions = await this.listVersions(resourceId, listOptions);
    const gray = versions.find((record) => {
      if (record.status !== 'gray') {
        return false;
      }
      const tenants = record.gray_policy.tenant_allowlist;
      const users = record.gray_policy.user_allowlist;
      return tenants.includes(tenant(input)) || (input.userId ? users.includes(input.userId) : false);
    });

    return gray ?? versions.find((record) => record.status === 'published');
  }

  private async getLatestByStatus(
    resourceId: string,
    status: SpecStatus | undefined,
    options: RegistryListOptions,
  ): Promise<RegistryResourceRecord<TSpec> | undefined> {
    const statusSql = status ? sql`and status = ${status}` : sql``;
    const result = await sql<RegistrySpecRow>`
      select
        tenant_id,
        ${sql.ref(this.definition.idColumn)} as resource_id,
        ${sql.ref(this.definition.versionColumn)} as version,
        status,
        ${sql.ref(this.definition.jsonColumn)} as spec_json,
        sha256,
        created_by,
        updated_by,
        published_by,
        created_at,
        updated_at,
        published_at,
        revision,
        gray_policy_json
      from ${sql.table(this.definition.tableName)}
      where tenant_id = ${tenant(options)}
        and ${sql.ref(this.definition.idColumn)} = ${resourceId}
        ${statusSql}
      order by ${sql.ref(this.definition.versionColumn)} desc
      limit 1
    `.execute(this.db);

    const row = result.rows[0];
    return row ? this.mapRow(row) : undefined;
  }

  private async requireRecord(
    resourceId: string,
    version: number,
    options: RegistryListOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    const record = await this.getByIdAndVersion(resourceId, version, options);
    if (!record) {
      throw new RegistryRepositoryError('REGISTRY_VERSION_NOT_FOUND', 'Registry resource version not found', {
        resource_type: this.definition.resourceType,
        resource_id: resourceId,
        version,
      });
    }
    return record;
  }

  private async nextVersion(resourceId: string, options: RegistryListOptions): Promise<number> {
    const latest = await this.getLatestVersion(resourceId, options);
    return (latest?.version ?? 0) + 1;
  }

  private async transition(
    resourceId: string,
    version: number,
    targetStatus: SpecStatus,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<TSpec>> {
    const existing = await this.requireRecord(resourceId, version, options);
    if (options.expectedRevision !== undefined && existing.revision !== options.expectedRevision) {
      throw new RegistryRepositoryError('REGISTRY_OPTIMISTIC_LOCK_CONFLICT', 'Registry resource revision conflict', {
        resource_type: this.definition.resourceType,
        resource_id: resourceId,
        version,
        expected_revision: options.expectedRevision,
        actual_revision: existing.revision,
      });
    }
    if (existing.status !== targetStatus) {
      assertTransition(existing.status, targetStatus);
    }

    const spec = this.definition.withIdentity(existing.spec, resourceId, version, targetStatus);
    const parsed = this.definition.schema.parse(spec);
    const publishedAt = targetStatus === 'published' || targetStatus === 'gray' ? sql`, published_at = coalesce(published_at, now())` : sql``;
    const publishedBy = targetStatus === 'published' || targetStatus === 'gray' ? sql`, published_by = ${options.operatorId}` : sql``;
    const grayPolicy = options.grayPolicy ?? existing.gray_policy;
    const result = await sql<RegistrySpecRow>`
      update ${sql.table(this.definition.tableName)}
      set
        status = ${targetStatus},
        ${sql.ref(this.definition.jsonColumn)} = ${parsed},
        sha256 = ${hashJson(parsed)},
        updated_by = ${options.operatorId},
        updated_at = now(),
        revision = revision + 1,
        gray_policy_json = ${grayPolicy}
        ${publishedAt}
        ${publishedBy}
      where tenant_id = ${tenant(options)}
        and ${sql.ref(this.definition.idColumn)} = ${resourceId}
        and ${sql.ref(this.definition.versionColumn)} = ${version}
      returning
        tenant_id,
        ${sql.ref(this.definition.idColumn)} as resource_id,
        ${sql.ref(this.definition.versionColumn)} as version,
        status,
        ${sql.ref(this.definition.jsonColumn)} as spec_json,
        sha256,
        created_by,
        updated_by,
        published_by,
        created_at,
        updated_at,
        published_at,
        revision,
        gray_policy_json
    `.execute(this.db);

    const row = result.rows[0];
    if (!row) {
      throw new RegistryRepositoryError('REGISTRY_VERSION_NOT_FOUND', 'Registry resource version not found', {
        resource_type: this.definition.resourceType,
        resource_id: resourceId,
        version,
      });
    }
    return this.mapRow(row);
  }

  private async insertRecord(input: {
    tenantId: string;
    resourceId: string;
    version: number;
    status: SpecStatus;
    spec: TSpec;
    sha256: string;
    operatorId: string;
    now: Date;
    revision: number;
    grayPolicy: GrayPolicy | Record<string, unknown>;
  }): Promise<RegistryResourceRecord<TSpec>> {
    const extraColumns = this.definition.insertExtraColumns?.(input.spec) ?? {};
    const columnNames = Object.keys(extraColumns);
    const columnSql = columnNames.length > 0 ? sql`, ${sql.join(columnNames.map((name) => sql.ref(name)), sql`, `)}` : sql``;
    const valueSql = columnNames.length > 0
      ? sql`, ${sql.join(columnNames.map((name) => extraColumns[name]), sql`, `)}`
      : sql``;

    const result = await sql<RegistrySpecRow>`
      insert into ${sql.table(this.definition.tableName)} (
        tenant_id,
        ${sql.ref(this.definition.idColumn)},
        ${sql.ref(this.definition.versionColumn)},
        status,
        ${sql.ref(this.definition.jsonColumn)},
        sha256,
        created_by,
        updated_by,
        published_by,
        created_at,
        updated_at,
        published_at,
        revision,
        gray_policy_json
        ${columnSql}
      ) values (
        ${input.tenantId},
        ${input.resourceId},
        ${input.version},
        ${input.status},
        ${input.spec},
        ${input.sha256},
        ${input.operatorId},
        ${input.operatorId},
        ${input.status === 'published' || input.status === 'gray' ? input.operatorId : null},
        ${input.now},
        ${input.now},
        ${input.status === 'published' || input.status === 'gray' ? input.now : null},
        ${input.revision},
        ${input.grayPolicy}
        ${valueSql}
      )
      returning
        tenant_id,
        ${sql.ref(this.definition.idColumn)} as resource_id,
        ${sql.ref(this.definition.versionColumn)} as version,
        status,
        ${sql.ref(this.definition.jsonColumn)} as spec_json,
        sha256,
        created_by,
        updated_by,
        published_by,
        created_at,
        updated_at,
        published_at,
        revision,
        gray_policy_json
    `.execute(this.db);

    return this.mapRow(result.rows[0] as RegistrySpecRow);
  }

  private mapRow(row: RegistrySpecRow): RegistryResourceRecord<TSpec> {
    const status = normalizeStatus(row.status);
    const rawSpec = isRecord(row.spec_json) ? { ...row.spec_json, status } : row.spec_json;
    const spec = this.definition.schema.parse(rawSpec);
    const record: RegistryResourceRecord<TSpec> = {
      tenant_id: row.tenant_id,
      resource_type: this.definition.resourceType,
      resource_id: row.resource_id,
      version: row.version,
      status,
      spec,
      sha256: row.sha256,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
      revision: row.revision,
      gray_policy: grayPolicySchema.parse(row.gray_policy_json ?? {}),
    };
    if (row.created_by) {
      record.created_by = row.created_by;
    }
    if (row.updated_by) {
      record.updated_by = row.updated_by;
    }
    if (row.published_by) {
      record.published_by = row.published_by;
    }
    if (row.published_at) {
      record.published_at = toIso(row.published_at);
    }
    return record;
  }
}

export class CapabilityReleaseRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async append(input: Omit<CapabilityRelease, 'release_id' | 'created_at'> & { release_id?: string }): Promise<CapabilityRelease> {
    const release = capabilityReleaseSchema.parse({
      ...input,
      release_id: input.release_id ?? `release_${randomUUID()}`,
      created_at: new Date().toISOString(),
    });

    const result = await sql<{
      release_id: string;
      tenant_id: string;
      resource_type: string;
      resource_id: string;
      resource_version: number;
      action: string;
      previous_version: number | null;
      target_status: string;
      operator_id: string;
      validation_result: unknown | null;
      release_note: string | null;
      metadata_json: unknown;
      evaluation_gate_decision_id: string | null;
      evaluation_gate_override_id: string | null;
      created_at: Date | string;
    }>`
      insert into capability_release (
        release_id,
        tenant_id,
        resource_type,
        resource_id,
        resource_version,
        action,
        previous_version,
        target_status,
        operator_id,
        validation_result,
        release_note,
        metadata_json,
        evaluation_gate_decision_id,
        evaluation_gate_override_id,
        created_at
      ) values (
        ${release.release_id},
        ${release.tenant_id},
        ${release.resource_type},
        ${release.resource_id},
        ${release.resource_version},
        ${release.action},
        ${release.previous_version ?? null},
        ${release.target_status},
        ${release.operator_id},
        ${release.validation_result ?? null},
        ${release.release_note ?? null},
        ${release.metadata_json},
        ${release.evaluation_gate_decision_id ?? null},
        ${release.evaluation_gate_override_id ?? null},
        ${release.created_at ?? new Date().toISOString()}
      )
      returning *
    `.execute(this.db);

    return mapRelease(result.rows[0]);
  }

  async get(releaseId: string): Promise<CapabilityRelease | undefined> {
    const result = await sql<ReleaseRow>`
      select * from capability_release where release_id = ${releaseId} limit 1
    `.execute(this.db);
    const row = result.rows[0];
    return row ? mapRelease(row) : undefined;
  }

  async list(options: {
    tenantId?: string;
    resourceType?: RegistryResourceType;
    resourceId?: string;
    action?: CapabilityReleaseAction;
    operatorId?: string;
    startTime?: string;
    endTime?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<CapabilityRelease[]> {
    const resourceTypeSql = options.resourceType ? sql`and resource_type = ${options.resourceType}` : sql``;
    const resourceIdSql = options.resourceId ? sql`and resource_id = ${options.resourceId}` : sql``;
    const actionSql = options.action ? sql`and action = ${options.action}` : sql``;
    const operatorSql = options.operatorId ? sql`and operator_id = ${options.operatorId}` : sql``;
    const startTimeSql = options.startTime ? sql`and created_at >= ${new Date(options.startTime)}` : sql``;
    const endTimeSql = options.endTime ? sql`and created_at <= ${new Date(options.endTime)}` : sql``;
    const result = await sql<ReleaseRow>`
      select *
      from capability_release
      where tenant_id = ${tenant(options)}
        ${resourceTypeSql}
        ${resourceIdSql}
        ${actionSql}
        ${operatorSql}
        ${startTimeSql}
        ${endTimeSql}
      order by created_at desc
      limit ${Math.min(Math.max(options.limit ?? 20, 1), 100)}
      offset ${Math.max(options.offset ?? 0, 0)}
    `.execute(this.db);

    return result.rows.map(mapRelease);
  }
}

type ReleaseRow = {
  release_id: string;
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  resource_version: number;
  action: string;
  previous_version: number | null;
  target_status: string;
  operator_id: string;
  validation_result: unknown | null;
  release_note: string | null;
  metadata_json: unknown;
  evaluation_gate_decision_id: string | null;
  evaluation_gate_override_id: string | null;
  created_at: Date | string;
};

function assertTransition(from: SpecStatus, to: SpecStatus): void {
  const result = validateSpecStatusTransition({ from, to });
  if (!result.ok) {
    throw new RegistryRepositoryError(result.error.code, result.error.message, result.error.details ?? {});
  }
}

function normalizeStatus(status: string): SpecStatus {
  return specStatusSchema.parse(status === 'archived' ? 'deprecated' : status);
}

function normalizeStatuses(status: RegistryListOptions['status']): SpecStatus[] {
  if (!status) {
    return [];
  }
  return (Array.isArray(status) ? status : [status]).map((entry) => specStatusSchema.parse(entry));
}

function tenant(options: { tenantId?: string }): string {
  return options.tenantId ?? 'default';
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
  }
  return value;
}

function extraSetSql(values: Record<string, unknown>) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return sql``;
  }
  return sql`, ${sql.join(entries.map(([key, value]) => sql`${sql.ref(key)} = ${value}`), sql`, `)}`;
}

function mapRelease(row: ReleaseRow | undefined): CapabilityRelease {
  if (!row) {
    throw new RegistryRepositoryError('CAPABILITY_RELEASE_NOT_FOUND', 'Capability release not found');
  }
  return capabilityReleaseSchema.parse({
    release_id: row.release_id,
    tenant_id: row.tenant_id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    resource_version: row.resource_version,
    action: row.action,
    previous_version: row.previous_version ?? undefined,
    target_status: row.target_status,
    operator_id: row.operator_id,
    validation_result: row.validation_result ?? undefined,
    release_note: row.release_note ?? undefined,
    metadata_json: isRecord(row.metadata_json) ? row.metadata_json : {},
    evaluation_gate_decision_id: row.evaluation_gate_decision_id ?? undefined,
    evaluation_gate_override_id: row.evaluation_gate_override_id ?? undefined,
    created_at: toIso(row.created_at),
  });
}
