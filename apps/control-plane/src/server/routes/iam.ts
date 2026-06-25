import type { FastifyInstance } from 'fastify';
import {
  iamTenantCreateRequestSchema,
  iamTenantUpdateRequestSchema,
  iamTenantQuerySchema,
  iamUserCreateRequestSchema,
  iamUserUpdateRequestSchema,
  iamUserQuerySchema,
  iamMembershipCreateRequestSchema,
  iamMembershipUpdateRequestSchema,
  iamMembershipQuerySchema,
  iamRoleCatalogResponseSchema,
  iamResolvedIdentitySchema,
} from '@dar/contracts';
import type { TenantDirectoryService } from '../services/iam/tenant-directory-service.js';
import type { UserDirectoryService } from '../services/iam/user-directory-service.js';
import type { MembershipService } from '../services/iam/membership-service.js';
import { IamServiceError } from '../services/iam/user-directory-service.js';
import { IamRepositoryError } from '@dar/db';
import { authOf, requirePermission, resolvedIdentityOf } from '../plugins/auth.js';
import { jsonSchema, ok, requestIdOf } from '../utils/http.js';

const ROLE_CATALOG = {
  roles: [
    {
      role: 'platform_admin',
      scope: 'global',
      description: '全局平台管理员：管理租户、用户、成员关系和角色分配。',
      can_manage_iam: true,
      can_write_registry: true,
      can_handle_human_task: true,
      is_read_only: false,
      can_use_runtime: true,
    },
  ],
  membership_roles: [
    {
      role: 'capability_operator',
      scope: 'tenant',
      description: '租户级能力运营员：管理 Registry、发布、运营操作和 Human Task。',
      can_manage_iam: false,
      can_write_registry: true,
      can_handle_human_task: true,
      is_read_only: false,
      can_use_runtime: true,
    },
    {
      role: 'auditor',
      scope: 'tenant',
      description: '租户级审计员：只读查看配置、运行、评测和审计。',
      can_manage_iam: false,
      can_write_registry: false,
      can_handle_human_task: false,
      is_read_only: true,
      can_use_runtime: true,
    },
    {
      role: '(普通成员)',
      scope: 'tenant',
      description: '普通成员：可使用 Runtime 入口，可查看自己的运行数据。',
      can_manage_iam: false,
      can_write_registry: false,
      can_handle_human_task: false,
      is_read_only: false,
      can_use_runtime: true,
    },
  ],
};

export interface IamRouteOptions {
  tenantService: TenantDirectoryService;
  userService: UserDirectoryService;
  membershipService: MembershipService;
}

export async function iamRoutes(server: FastifyInstance, options: IamRouteOptions): Promise<void> {
  const { tenantService, userService, membershipService } = options;

  // -----------------------------------------------------------------------
  // GET /api/v1/auth/me - Current identity
  // -----------------------------------------------------------------------
  server.get('/api/v1/auth/me', async (request) => {
    const auth = authOf(request);
    const resolved = resolvedIdentityOf(request);
    if (resolved) {
      return ok(iamResolvedIdentitySchema.parse(resolved), auth.request_id);
    }
    // Header mode fallback
    return ok(iamResolvedIdentitySchema.parse({
      user_id: auth.user_id,
      tenant_id: auth.tenant_id,
      display_name: auth.user_id,
      platform_roles: auth.roles.includes('platform_admin') ? ['platform_admin'] : [],
      membership_roles: auth.roles.filter((r) => r !== 'platform_admin'),
      roles: auth.roles,
      identity_source: 'header',
      request_id: auth.request_id,
    }), auth.request_id);
  });

  // -----------------------------------------------------------------------
  // GET /api/v1/iam/roles - Fixed role catalog
  // -----------------------------------------------------------------------
  server.get('/api/v1/iam/roles', async (request) => {
    const auth = requirePermission(request, 'iam:read');
    return ok(iamRoleCatalogResponseSchema.parse(ROLE_CATALOG), auth.request_id);
  });

  // -----------------------------------------------------------------------
  // Tenant CRUD
  // -----------------------------------------------------------------------
  server.get('/api/v1/iam/tenants', {
    schema: { querystring: jsonSchema(iamTenantQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:read');
    const query = iamTenantQuerySchema.parse(request.query);
    const result = await tenantService.list(query);
    return ok(result, auth.request_id);
  });

  server.post('/api/v1/iam/tenants', {
    schema: { body: jsonSchema(iamTenantCreateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const body = iamTenantCreateRequestSchema.parse(request.body);
    const tenant = await tenantService.create(body, auth.user_id, requestIdOf(request));
    return ok(tenant, auth.request_id);
  });

  server.get('/api/v1/iam/tenants/:tenantId', async (request) => {
    const auth = requirePermission(request, 'iam:read');
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await tenantService.get(tenantId);
    return ok(tenant, auth.request_id);
  });

  server.put('/api/v1/iam/tenants/:tenantId', {
    schema: { body: jsonSchema(iamTenantUpdateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { tenantId } = request.params as { tenantId: string };
    const body = iamTenantUpdateRequestSchema.parse(request.body);
    const tenant = await tenantService.update(tenantId, body, auth.user_id, requestIdOf(request));
    return ok(tenant, auth.request_id);
  });

  server.post('/api/v1/iam/tenants/:tenantId/activate', async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await tenantService.activate(tenantId, auth.user_id, requestIdOf(request));
    return ok(tenant, auth.request_id);
  });

  server.post('/api/v1/iam/tenants/:tenantId/disable', async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { tenantId } = request.params as { tenantId: string };
    const tenant = await tenantService.disable(tenantId, auth.user_id, requestIdOf(request));
    return ok(tenant, auth.request_id);
  });

  // -----------------------------------------------------------------------
  // User CRUD
  // -----------------------------------------------------------------------
  server.get('/api/v1/iam/users', {
    schema: { querystring: jsonSchema(iamUserQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:read');
    const query = iamUserQuerySchema.parse(request.query);
    const result = await userService.list(query);
    return ok(result, auth.request_id);
  });

  server.post('/api/v1/iam/users', {
    schema: { body: jsonSchema(iamUserCreateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const body = iamUserCreateRequestSchema.parse(request.body);
    const user = await userService.create(body, auth.user_id, requestIdOf(request));
    return ok(user, auth.request_id);
  });

  server.get('/api/v1/iam/users/:userId', async (request) => {
    const auth = requirePermission(request, 'iam:read');
    const { userId } = request.params as { userId: string };
    const user = await userService.get(userId);
    return ok(user, auth.request_id);
  });

  server.put('/api/v1/iam/users/:userId', {
    schema: { body: jsonSchema(iamUserUpdateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { userId } = request.params as { userId: string };
    const body = iamUserUpdateRequestSchema.parse(request.body);

    // If platform_roles is being changed, use the special method
    if (body.platform_roles !== undefined) {
      const user = await userService.updatePlatformRoles(
        userId,
        body.platform_roles,
        body.expected_revision,
        auth.user_id,
        requestIdOf(request),
      );
      return ok(user, auth.request_id);
    }

    const user = await userService.update(userId, body, auth.user_id, requestIdOf(request));
    return ok(user, auth.request_id);
  });

  server.post('/api/v1/iam/users/:userId/activate', async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { userId } = request.params as { userId: string };
    const user = await userService.activate(userId, auth.user_id, requestIdOf(request));
    return ok(user, auth.request_id);
  });

  server.post('/api/v1/iam/users/:userId/disable', async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { userId } = request.params as { userId: string };
    const user = await userService.disable(userId, auth.user_id, requestIdOf(request));
    return ok(user, auth.request_id);
  });

  // -----------------------------------------------------------------------
  // Membership CRUD
  // -----------------------------------------------------------------------
  server.get('/api/v1/iam/memberships', {
    schema: { querystring: jsonSchema(iamMembershipQuerySchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:read');
    const query = iamMembershipQuerySchema.parse(request.query);
    const result = await membershipService.list(query);
    return ok(result, auth.request_id);
  });

  server.post('/api/v1/iam/memberships', {
    schema: { body: jsonSchema(iamMembershipCreateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const body = iamMembershipCreateRequestSchema.parse(request.body);
    const membership = await membershipService.create(body, auth.user_id, requestIdOf(request));
    return ok(membership, auth.request_id);
  });

  server.get('/api/v1/iam/memberships/:tenantId/:userId', async (request) => {
    const auth = requirePermission(request, 'iam:read');
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    const membership = await membershipService.get(tenantId, userId);
    return ok(membership, auth.request_id);
  });

  server.put('/api/v1/iam/memberships/:tenantId/:userId', {
    schema: { body: jsonSchema(iamMembershipUpdateRequestSchema) },
  }, async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    const body = iamMembershipUpdateRequestSchema.parse(request.body);
    const membership = await membershipService.updateRoles(tenantId, userId, body, auth.user_id, requestIdOf(request));
    return ok(membership, auth.request_id);
  });

  server.post('/api/v1/iam/memberships/:tenantId/:userId/activate', async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    const membership = await membershipService.activate(tenantId, userId, auth.user_id, requestIdOf(request));
    return ok(membership, auth.request_id);
  });

  server.post('/api/v1/iam/memberships/:tenantId/:userId/disable', async (request) => {
    const auth = requirePermission(request, 'iam:write');
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    const membership = await membershipService.disable(tenantId, userId, auth.user_id, requestIdOf(request));
    return ok(membership, auth.request_id);
  });
}

// Map IAM errors to HTTP status codes
export function mapIamError(error: unknown): { statusCode: number; code: string; message: string } | undefined {
  if (error instanceof IamServiceError || error instanceof IamRepositoryError) {
    const code = error.code;
    let statusCode = 400;
    if (code.endsWith('_NOT_FOUND')) statusCode = 404;
    else if (code.endsWith('_CONFLICT') || code.endsWith('_REVISION_CONFLICT')) statusCode = 409;
    else if (code.endsWith('_DISABLED') || code.endsWith('_REQUIRED') || code === 'IAM_LAST_PLATFORM_ADMIN_REQUIRED') statusCode = 403;
    else if (code.endsWith('_SCOPE_INVALID') || code.endsWith('_NOT_ALLOWED')) statusCode = 422;
    return { statusCode, code, message: error.message };
  }
  return undefined;
}
