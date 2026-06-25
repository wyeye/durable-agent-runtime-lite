import type {
  IamTenantMembership,
  IamMembershipCreateRequest,
  IamMembershipUpdateRequest,
  IamMembershipQuery,
} from '@dar/contracts';
import type { TenantMembershipRepository } from '@dar/db';
import { IamServiceError } from './user-directory-service.js';

export interface MembershipAuditWriter {
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

export class MembershipService {
  constructor(
    private readonly repo: TenantMembershipRepository,
    private readonly audit: MembershipAuditWriter,
  ) {}

  async list(query: IamMembershipQuery): Promise<{ items: IamTenantMembership[]; total: number }> {
    return this.repo.list(query);
  }

  async get(tenantId: string, userId: string): Promise<IamTenantMembership> {
    const membership = await this.repo.get(tenantId, userId);
    if (!membership) {
      throw new IamServiceError('IAM_MEMBERSHIP_NOT_FOUND', `成员关系不存在: ${tenantId}/${userId}`, {
        tenant_id: tenantId,
        user_id: userId,
      });
    }
    return membership;
  }

  async create(input: IamMembershipCreateRequest, operatorId: string, requestId?: string): Promise<IamTenantMembership> {
    // Validate: platform_admin is not allowed as membership role
    for (const role of input.roles ?? []) {
      if (role === 'platform_admin' as string) {
        throw new IamServiceError('IAM_MEMBERSHIP_ROLE_SCOPE_INVALID', 'platform_admin 不能作为成员关系角色', {
          roles: input.roles,
        });
      }
    }
    const membership = await this.repo.create(input, operatorId);
    await this.audit.write({
      tenant_id: input.tenant_id,
      actor_id: operatorId,
      action: 'iam.membership.created',
      target_type: 'membership',
      target_id: `${input.tenant_id}/${input.user_id}`,
      result: 'succeeded',
      payload: { roles: membership.roles },
      request_id: requestId,
    });
    return membership;
  }

  async updateRoles(tenantId: string, userId: string, input: IamMembershipUpdateRequest, operatorId: string, requestId?: string): Promise<IamTenantMembership> {
    // Validate: platform_admin is not allowed as membership role
    for (const role of input.roles) {
      if (role === 'platform_admin' as string) {
        throw new IamServiceError('IAM_MEMBERSHIP_ROLE_SCOPE_INVALID', 'platform_admin 不能作为成员关系角色', {
          roles: input.roles,
        });
      }
    }
    const membership = await this.repo.updateRoles(tenantId, userId, input, operatorId);
    await this.audit.write({
      tenant_id: tenantId,
      actor_id: operatorId,
      action: 'iam.membership.roles_updated',
      target_type: 'membership',
      target_id: `${tenantId}/${userId}`,
      result: 'succeeded',
      payload: { roles: membership.roles },
      request_id: requestId,
    });
    return membership;
  }

  async activate(tenantId: string, userId: string, operatorId: string, requestId?: string): Promise<IamTenantMembership> {
    const membership = await this.repo.setStatus(tenantId, userId, 'active', operatorId);
    await this.audit.write({
      tenant_id: tenantId,
      actor_id: operatorId,
      action: 'iam.membership.activated',
      target_type: 'membership',
      target_id: `${tenantId}/${userId}`,
      result: 'succeeded',
      request_id: requestId,
    });
    return membership;
  }

  async disable(tenantId: string, userId: string, operatorId: string, requestId?: string): Promise<IamTenantMembership> {
    const membership = await this.repo.setStatus(tenantId, userId, 'disabled', operatorId);
    await this.audit.write({
      tenant_id: tenantId,
      actor_id: operatorId,
      action: 'iam.membership.disabled',
      target_type: 'membership',
      target_id: `${tenantId}/${userId}`,
      result: 'succeeded',
      request_id: requestId,
    });
    return membership;
  }

  async listForUser(userId: string): Promise<IamTenantMembership[]> {
    return this.repo.listForUser(userId);
  }

  async listForTenant(tenantId: string): Promise<IamTenantMembership[]> {
    return this.repo.listForTenant(tenantId);
  }
}
