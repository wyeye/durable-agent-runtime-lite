import { z } from 'zod';
import type { AuthContext } from './index.js';
import { AuthError } from './index.js';

// =========================================================================
// IAM permissions
// =========================================================================

export const iamPermissionSchema = z.enum([
  'iam:read',
  'iam:write',
]);
export type IamPermission = z.infer<typeof iamPermissionSchema>;

// =========================================================================
// Identity Directory interface
// =========================================================================

export interface ResolvedIdentity {
  user_id: string;
  tenant_id: string;
  display_name: string;
  email?: string | undefined;
  platform_roles: string[];
  membership_roles: string[];
  roles: string[];
  identity_source: 'directory' | 'header';
  request_id?: string | undefined;
}

export interface IdentityDirectoryResolveInput {
  user_id: string;
  tenant_id: string;
  request_id?: string | undefined;
}

export interface IdentityDirectory {
  resolve(input: IdentityDirectoryResolveInput): Promise<ResolvedIdentity>;
}

// =========================================================================
// Identity Directory resolution for DB mode
// =========================================================================

export interface IdentityDirectoryDependencies {
  getUser(userId: string): Promise<{
    user_id: string;
    display_name: string;
    email?: string | null | undefined;
    status: string;
    platform_roles: string[];
  } | undefined>;
  getTenant(tenantId: string): Promise<{
    tenant_id: string;
    status: string;
  } | undefined>;
  getMembership(tenantId: string, userId: string): Promise<{
    status: string;
    roles: string[];
  } | undefined>;
  getActiveMembershipsForUser(userId: string): Promise<Array<{
    tenant_id: string;
    status: string;
    roles: string[];
  }>>;
}

export class DbIdentityDirectory implements IdentityDirectory {
  constructor(private readonly deps: IdentityDirectoryDependencies) {}

  async resolve(input: IdentityDirectoryResolveInput): Promise<ResolvedIdentity> {
    const user = await this.deps.getUser(input.user_id);
    if (!user) {
      throw new AuthError('UNAUTHORIZED', 'IAM_USER_NOT_FOUND', {
        code: 'IAM_USER_NOT_FOUND',
        user_id: input.user_id,
      });
    }
    if (user.status === 'disabled') {
      throw new AuthError('FORBIDDEN', 'IAM_USER_DISABLED', {
        code: 'IAM_USER_DISABLED',
        user_id: input.user_id,
      });
    }

    const tenant = await this.deps.getTenant(input.tenant_id);
    if (!tenant) {
      throw new AuthError('UNAUTHORIZED', 'IAM_TENANT_NOT_FOUND', {
        code: 'IAM_TENANT_NOT_FOUND',
        tenant_id: input.tenant_id,
      });
    }
    if (tenant.status === 'disabled') {
      throw new AuthError('FORBIDDEN', 'IAM_TENANT_DISABLED', {
        code: 'IAM_TENANT_DISABLED',
        tenant_id: input.tenant_id,
      });
    }

    const platformRoles = [...user.platform_roles];
    const isGlobalPlatformAdmin = platformRoles.includes('platform_admin');
    const membership = await this.deps.getMembership(input.tenant_id, input.user_id);

    let membershipRoles: string[] = [];
    if (isGlobalPlatformAdmin) {
      // platform_admin can access any tenant
      membershipRoles = [];
    } else if (!membership || membership.status !== 'active') {
      throw new AuthError('FORBIDDEN', 'IAM_MEMBERSHIP_REQUIRED', {
        code: 'IAM_MEMBERSHIP_REQUIRED',
        tenant_id: input.tenant_id,
        user_id: input.user_id,
      });
    } else {
      membershipRoles = membership.roles;
    }

    // roles = global platform_roles + tenant membership_roles (deduplicated, sorted)
    const roleSet = new Set<string>([...platformRoles, ...membershipRoles]);
    const roles = [...roleSet].sort();

    return {
      user_id: user.user_id,
      tenant_id: input.tenant_id,
      display_name: user.display_name,
      ...(user.email ? { email: user.email } : {}),
      platform_roles: platformRoles,
      membership_roles: membershipRoles,
      roles,
      identity_source: 'directory',
      ...(input.request_id ? { request_id: input.request_id } : {}),
    };
  }
}

// =========================================================================
// Header mode identity directory (backward compatible)
// =========================================================================

export class HeaderIdentityDirectory implements IdentityDirectory {
  async resolve(input: IdentityDirectoryResolveInput & { roles?: string[] }): Promise<ResolvedIdentity> {
    return {
      user_id: input.user_id,
      tenant_id: input.tenant_id,
      display_name: input.user_id,
      platform_roles: [],
      membership_roles: [],
      roles: input.roles ?? [],
      identity_source: 'header',
      ...(input.request_id ? { request_id: input.request_id } : {}),
    };
  }
}

// =========================================================================
// Resolved identity -> AuthContext adapter
// =========================================================================

export function resolvedIdentityToAuthContext(identity: ResolvedIdentity): AuthContext {
  return {
    user_id: identity.user_id,
    tenant_id: identity.tenant_id,
    roles: identity.roles,
    request_id: identity.request_id,
  };
}
