import { sql, type Kysely } from 'kysely';
import type {
  IamTenant,
  IamTenantCreateRequest,
  IamTenantUpdateRequest,
  IamTenantQuery,
  IamUserAccount,
  IamUserCreateRequest,
  IamUserUpdateRequest,
  IamUserQuery,
  IamTenantMembership,
  IamMembershipCreateRequest,
  IamMembershipUpdateRequest,
  IamMembershipQuery,
} from '@dar/contracts';
import {
  iamTenantSchema,
  iamUserAccountSchema,
  iamTenantMembershipSchema,
} from '@dar/contracts';
import type { Database, TenantTable, UserAccountTable, TenantMembershipTable } from './index.js';
import type { Insertable, Selectable } from 'kysely';

// =========================================================================
// Errors
// =========================================================================

export class IamRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'IamRepositoryError';
  }
}

function mapTenant(row: Selectable<TenantTable>): IamTenant {
  return iamTenantSchema.parse({
    tenant_id: row.tenant_id,
    display_name: row.display_name,
    description: row.description,
    status: row.status,
    revision: row.revision,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    disabled_at: row.disabled_at
      ? (row.disabled_at instanceof Date ? row.disabled_at.toISOString() : row.disabled_at)
      : null,
  });
}

function mapUser(row: Selectable<UserAccountTable>): IamUserAccount {
  return iamUserAccountSchema.parse({
    user_id: row.user_id,
    display_name: row.display_name,
    email: row.email,
    status: row.status,
    platform_roles: typeof row.platform_roles === 'string' ? JSON.parse(row.platform_roles) : row.platform_roles,
    revision: row.revision,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    disabled_at: row.disabled_at
      ? (row.disabled_at instanceof Date ? row.disabled_at.toISOString() : row.disabled_at)
      : null,
  });
}

function mapMembership(row: Selectable<TenantMembershipTable>): IamTenantMembership {
  return iamTenantMembershipSchema.parse({
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    roles: typeof row.roles === 'string' ? JSON.parse(row.roles) : row.roles,
    status: row.status,
    revision: row.revision,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    disabled_at: row.disabled_at
      ? (row.disabled_at instanceof Date ? row.disabled_at.toISOString() : row.disabled_at)
      : null,
  });
}

// =========================================================================
// TenantRepository
// =========================================================================

export class TenantRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(query: IamTenantQuery): Promise<{ items: IamTenant[]; total: number }> {
    let base = this.db.selectFrom('tenant');
    if (query.status) {
      base = base.where('status', '=', query.status);
    }
    if (query.search) {
      base = base.where((eb) =>
        eb.or([
          eb('tenant_id', 'ilike', `%${query.search}%`),
          eb('display_name', 'ilike', `%${query.search}%`),
        ]),
      );
    }

    const countResult = await base.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow();
    const total = Number(countResult.total);

    const offset = (query.page - 1) * query.page_size;
    const rows = await base
      .orderBy('created_at', 'desc')
      .offset(offset)
      .limit(query.page_size)
      .selectAll()
      .execute();

    return { items: rows.map(mapTenant), total };
  }

  async get(tenantId: string): Promise<IamTenant | undefined> {
    const row = await this.db
      .selectFrom('tenant')
      .where('tenant_id', '=', tenantId)
      .selectAll()
      .executeTakeFirst();
    return row ? mapTenant(row) : undefined;
  }

  async create(input: IamTenantCreateRequest, operatorId: string): Promise<IamTenant> {
    const existing = await this.get(input.tenant_id);
    if (existing) {
      throw new IamRepositoryError('IAM_TENANT_CONFLICT', `租户 ${input.tenant_id} 已存在`, { tenant_id: input.tenant_id });
    }
    const now = new Date().toISOString();
    const row: Insertable<TenantTable> = {
      tenant_id: input.tenant_id,
      display_name: input.display_name,
      description: input.description ?? '',
      status: 'active',
      revision: 1,
      created_by: operatorId,
      updated_by: operatorId,
      created_at: now,
      updated_at: now,
    };
    const inserted = await this.db.insertInto('tenant').values(row).returningAll().executeTakeFirstOrThrow();
    return mapTenant(inserted);
  }

  async update(tenantId: string, input: IamTenantUpdateRequest, operatorId: string): Promise<IamTenant> {
    const existing = await this.get(tenantId);
    if (!existing) {
      throw new IamRepositoryError('IAM_TENANT_NOT_FOUND', `租户 ${tenantId} 不存在`, { tenant_id: tenantId });
    }
    if (existing.revision !== input.expected_revision) {
      throw new IamRepositoryError('IAM_REVISION_CONFLICT', '租户版本已变化，请刷新后重试', {
        tenant_id: tenantId,
        expected: input.expected_revision,
        actual: existing.revision,
      });
    }
    const now = new Date().toISOString();
    const updated = await this.db
      .updateTable('tenant')
      .set({
        ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updated_by: operatorId,
        updated_at: now,
        revision: existing.revision + 1,
      })
      .where('tenant_id', '=', tenantId)
      .where('revision', '=', input.expected_revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapTenant(updated);
  }

  async setStatus(tenantId: string, status: 'active' | 'disabled', operatorId: string): Promise<IamTenant> {
    const existing = await this.get(tenantId);
    if (!existing) {
      throw new IamRepositoryError('IAM_TENANT_NOT_FOUND', `租户 ${tenantId} 不存在`, { tenant_id: tenantId });
    }
    const now = new Date().toISOString();
    const updated = await this.db
      .updateTable('tenant')
      .set({
        status,
        disabled_at: status === 'disabled' ? now : null,
        updated_by: operatorId,
        updated_at: now,
        revision: existing.revision + 1,
      })
      .where('tenant_id', '=', tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapTenant(updated);
  }
}

// =========================================================================
// UserAccountRepository
// =========================================================================

export class UserAccountRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(query: IamUserQuery): Promise<{ items: IamUserAccount[]; total: number }> {
    let base = this.db.selectFrom('user_account');
    if (query.status) {
      base = base.where('status', '=', query.status);
    }
    if (query.search) {
      base = base.where((eb) =>
        eb.or([
          eb('user_id', 'ilike', `%${query.search}%`),
          eb('display_name', 'ilike', `%${query.search}%`),
          eb('email', 'ilike', `%${query.search}%`),
        ]),
      );
    }
    if (query.platform_role) {
      base = base.where('platform_roles', '@>', JSON.stringify([query.platform_role]));
    }

    const countResult = await base.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow();
    const total = Number(countResult.total);

    const offset = (query.page - 1) * query.page_size;
    const rows = await base
      .orderBy('created_at', 'desc')
      .offset(offset)
      .limit(query.page_size)
      .selectAll()
      .execute();

    return { items: rows.map(mapUser), total };
  }

  async get(userId: string): Promise<IamUserAccount | undefined> {
    const row = await this.db
      .selectFrom('user_account')
      .where('user_id', '=', userId)
      .selectAll()
      .executeTakeFirst();
    return row ? mapUser(row) : undefined;
  }

  async create(input: IamUserCreateRequest, operatorId: string): Promise<IamUserAccount> {
    const existing = await this.get(input.user_id);
    if (existing) {
      throw new IamRepositoryError('IAM_USER_CONFLICT', `用户 ${input.user_id} 已存在`, { user_id: input.user_id });
    }
    if (input.email) {
      await this.assertEmailUnique(input.email);
    }
    const now = new Date().toISOString();
    const row: Insertable<UserAccountTable> = {
      user_id: input.user_id,
      display_name: input.display_name,
      email: input.email ?? null,
      status: 'active',
      platform_roles: JSON.stringify(input.platform_roles ?? []),
      revision: 1,
      created_by: operatorId,
      updated_by: operatorId,
      created_at: now,
      updated_at: now,
    };
    const inserted = await this.db.insertInto('user_account').values(row).returningAll().executeTakeFirstOrThrow();
    return mapUser(inserted);
  }

  async update(userId: string, input: IamUserUpdateRequest, operatorId: string): Promise<IamUserAccount> {
    const existing = await this.get(userId);
    if (!existing) {
      throw new IamRepositoryError('IAM_USER_NOT_FOUND', `用户 ${userId} 不存在`, { user_id: userId });
    }
    if (existing.revision !== input.expected_revision) {
      throw new IamRepositoryError('IAM_REVISION_CONFLICT', '用户版本已变化，请刷新后重试', {
        user_id: userId,
        expected: input.expected_revision,
        actual: existing.revision,
      });
    }
    if (input.email !== undefined && input.email !== null && input.email !== existing.email) {
      await this.assertEmailUnique(input.email);
    }
    const now = new Date().toISOString();
    const updated = await this.db
      .updateTable('user_account')
      .set({
        ...(input.display_name !== undefined ? { display_name: input.display_name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.platform_roles !== undefined ? { platform_roles: JSON.stringify(input.platform_roles) } : {}),
        updated_by: operatorId,
        updated_at: now,
        revision: existing.revision + 1,
      })
      .where('user_id', '=', userId)
      .where('revision', '=', input.expected_revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapUser(updated);
  }

  async setStatus(userId: string, status: 'active' | 'disabled', operatorId: string): Promise<IamUserAccount> {
    const existing = await this.get(userId);
    if (!existing) {
      throw new IamRepositoryError('IAM_USER_NOT_FOUND', `用户 ${userId} 不存在`, { user_id: userId });
    }
    const now = new Date().toISOString();
    const updated = await this.db
      .updateTable('user_account')
      .set({
        status,
        disabled_at: status === 'disabled' ? now : null,
        updated_by: operatorId,
        updated_at: now,
        revision: existing.revision + 1,
      })
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapUser(updated);
  }

  async countActivePlatformAdmins(): Promise<number> {
    const result = await this.db
      .selectFrom('user_account')
      .where('status', '=', 'active')
      .where('platform_roles', '@>', '["platform_admin"]')
      .select((eb) => eb.fn.countAll().as('total'))
      .executeTakeFirstOrThrow();
    return Number(result.total);
  }

  private async assertEmailUnique(email: string): Promise<void> {
    const existing = await this.db
      .selectFrom('user_account')
      .where(sql`lower(email)`, '=', email.toLowerCase())
      .select('user_id')
      .executeTakeFirst();
    if (existing) {
      throw new IamRepositoryError('IAM_EMAIL_CONFLICT', `邮箱 ${email} 已被使用`, { email });
    }
  }
}

// =========================================================================
// TenantMembershipRepository
// =========================================================================

export class TenantMembershipRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(query: IamMembershipQuery): Promise<{ items: IamTenantMembership[]; total: number }> {
    let base = this.db.selectFrom('tenant_membership');
    if (query.tenant_id) {
      base = base.where('tenant_id', '=', query.tenant_id);
    }
    if (query.user_id) {
      base = base.where('user_id', '=', query.user_id);
    }
    if (query.status) {
      base = base.where('status', '=', query.status);
    }

    const countResult = await base.select((eb) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow();
    const total = Number(countResult.total);

    const offset = (query.page - 1) * query.page_size;
    const rows = await base
      .orderBy('created_at', 'desc')
      .offset(offset)
      .limit(query.page_size)
      .selectAll()
      .execute();

    return { items: rows.map(mapMembership), total };
  }

  async get(tenantId: string, userId: string): Promise<IamTenantMembership | undefined> {
    const row = await this.db
      .selectFrom('tenant_membership')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .selectAll()
      .executeTakeFirst();
    return row ? mapMembership(row) : undefined;
  }

  async create(input: IamMembershipCreateRequest, operatorId: string): Promise<IamTenantMembership> {
    const existing = await this.get(input.tenant_id, input.user_id);
    if (existing) {
      throw new IamRepositoryError(
        'IAM_MEMBERSHIP_CONFLICT',
        `用户 ${input.user_id} 已是租户 ${input.tenant_id} 的成员`,
        { tenant_id: input.tenant_id, user_id: input.user_id },
      );
    }
    const now = new Date().toISOString();
    const row: Insertable<TenantMembershipTable> = {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      roles: JSON.stringify(input.roles ?? []),
      status: 'active',
      revision: 1,
      created_by: operatorId,
      updated_by: operatorId,
      created_at: now,
      updated_at: now,
    };
    const inserted = await this.db.insertInto('tenant_membership').values(row).returningAll().executeTakeFirstOrThrow();
    return mapMembership(inserted);
  }

  async updateRoles(tenantId: string, userId: string, input: IamMembershipUpdateRequest, operatorId: string): Promise<IamTenantMembership> {
    const existing = await this.get(tenantId, userId);
    if (!existing) {
      throw new IamRepositoryError(
        'IAM_MEMBERSHIP_NOT_FOUND',
        `成员关系不存在: ${tenantId}/${userId}`,
        { tenant_id: tenantId, user_id: userId },
      );
    }
    if (existing.revision !== input.expected_revision) {
      throw new IamRepositoryError('IAM_REVISION_CONFLICT', '成员关系版本已变化，请刷新后重试', {
        tenant_id: tenantId,
        user_id: userId,
        expected: input.expected_revision,
        actual: existing.revision,
      });
    }
    const now = new Date().toISOString();
    const updated = await this.db
      .updateTable('tenant_membership')
      .set({
        roles: JSON.stringify(input.roles),
        updated_by: operatorId,
        updated_at: now,
        revision: existing.revision + 1,
      })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .where('revision', '=', input.expected_revision)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapMembership(updated);
  }

  async setStatus(tenantId: string, userId: string, status: 'active' | 'disabled', operatorId: string): Promise<IamTenantMembership> {
    const existing = await this.get(tenantId, userId);
    if (!existing) {
      throw new IamRepositoryError(
        'IAM_MEMBERSHIP_NOT_FOUND',
        `成员关系不存在: ${tenantId}/${userId}`,
        { tenant_id: tenantId, user_id: userId },
      );
    }
    const now = new Date().toISOString();
    const updated = await this.db
      .updateTable('tenant_membership')
      .set({
        status,
        disabled_at: status === 'disabled' ? now : null,
        updated_by: operatorId,
        updated_at: now,
        revision: existing.revision + 1,
      })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapMembership(updated);
  }

  async listForUser(userId: string): Promise<IamTenantMembership[]> {
    const rows = await this.db
      .selectFrom('tenant_membership')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .selectAll()
      .execute();
    return rows.map(mapMembership);
  }

  async listForTenant(tenantId: string): Promise<IamTenantMembership[]> {
    const rows = await this.db
      .selectFrom('tenant_membership')
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .selectAll()
      .execute();
    return rows.map(mapMembership);
  }
}
