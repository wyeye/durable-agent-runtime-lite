import type {
  IamUserAccount,
  IamUserCreateRequest,
  IamUserUpdateRequest,
  IamUserQuery,
} from '@dar/contracts';
import type { UserAccountRepository } from '@dar/db';

export interface UserDirectoryAuditWriter {
  write(event: {
    tenant_id: string;
    actor_id: string;
    action: string;
    target_type: string;
    target_id: string;
    result: string;
    payload?: Record<string, unknown> | undefined;
    request_id?: string | undefined;
  }): Promise<void>;
}

export class UserDirectoryService {
  constructor(
    private readonly repo: UserAccountRepository,
    private readonly audit: UserDirectoryAuditWriter,
  ) {}

  async list(query: IamUserQuery): Promise<{ items: IamUserAccount[]; total: number }> {
    return this.repo.list(query);
  }

  async get(userId: string): Promise<IamUserAccount> {
    const user = await this.repo.get(userId);
    if (!user) {
      throw new Error(`IAM_USER_NOT_FOUND: ${userId}`);
    }
    return user;
  }

  async create(input: IamUserCreateRequest, operatorId: string, requestId?: string): Promise<IamUserAccount> {
    const user = await this.repo.create(input, operatorId);
    await this.audit.write({
      tenant_id: '*',
      actor_id: operatorId,
      action: 'iam.user.created',
      target_type: 'user',
      target_id: user.user_id,
      result: 'succeeded',
      payload: { platform_roles: user.platform_roles },
      request_id: requestId,
    });
    return user;
  }

  async update(userId: string, input: IamUserUpdateRequest, operatorId: string, requestId?: string): Promise<IamUserAccount> {
    const user = await this.repo.update(userId, input, operatorId);
    const auditAction = input.platform_roles !== undefined
      ? 'iam.user.platform_roles_updated'
      : 'iam.user.updated';
    await this.audit.write({
      tenant_id: '*',
      actor_id: operatorId,
      action: auditAction,
      target_type: 'user',
      target_id: userId,
      result: 'succeeded',
      payload: { revision: user.revision, ...(input.platform_roles !== undefined ? { platform_roles: input.platform_roles } : {}) },
      request_id: requestId,
    });
    return user;
  }

  async activate(userId: string, operatorId: string, requestId?: string): Promise<IamUserAccount> {
    const user = await this.repo.setStatus(userId, 'active', operatorId);
    await this.audit.write({
      tenant_id: '*',
      actor_id: operatorId,
      action: 'iam.user.activated',
      target_type: 'user',
      target_id: userId,
      result: 'succeeded',
      request_id: requestId,
    });
    return user;
  }

  async disable(userId: string, operatorId: string, requestId?: string): Promise<IamUserAccount> {
    // Prevent disabling the last active platform admin
    const user = await this.get(userId);
    if (user.platform_roles.includes('platform_admin') && user.status === 'active') {
      const adminCount = await this.repo.countActivePlatformAdmins();
      if (adminCount <= 1) {
        throw new IamServiceError('IAM_LAST_PLATFORM_ADMIN_REQUIRED', '至少需要保留一个活跃的平台管理员', {
          user_id: userId,
          active_admins: adminCount,
        });
      }
    }
    const result = await this.repo.setStatus(userId, 'disabled', operatorId);
    await this.audit.write({
      tenant_id: '*',
      actor_id: operatorId,
      action: 'iam.user.disabled',
      target_type: 'user',
      target_id: userId,
      result: 'succeeded',
      request_id: requestId,
    });
    return result;
  }

  async updatePlatformRoles(userId: string, platformRoles: string[], expectedRevision: number, operatorId: string, requestId?: string): Promise<IamUserAccount> {
    // Prevent removing the last platform_admin
    const user = await this.get(userId);
    const wasAdmin = user.platform_roles.includes('platform_admin');
    const willBeAdmin = platformRoles.includes('platform_admin');

    if (wasAdmin && !willBeAdmin && user.status === 'active') {
      const adminCount = await this.repo.countActivePlatformAdmins();
      if (adminCount <= 1) {
        throw new IamServiceError('IAM_LAST_PLATFORM_ADMIN_REQUIRED', '至少需要保留一个活跃的平台管理员', {
          user_id: userId,
          active_admins: adminCount,
        });
      }
    }

    const updated = await this.repo.update(userId, {
      platform_roles: platformRoles as ['platform_admin'],
      expected_revision: expectedRevision,
    }, operatorId);

    await this.audit.write({
      tenant_id: '*',
      actor_id: operatorId,
      action: 'iam.user.platform_roles_updated',
      target_type: 'user',
      target_id: userId,
      result: 'succeeded',
      payload: { old_roles: user.platform_roles, new_roles: platformRoles },
      request_id: requestId,
    });

    return updated;
  }
}

export class IamServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'IamServiceError';
  }
}
