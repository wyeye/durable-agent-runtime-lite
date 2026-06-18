import { z } from 'zod';

export const authContextSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  roles: z.array(z.string()).default([]),
  request_id: z.string().optional(),
  org_id: z.string().optional(),
  session_id: z.string().optional(),
});

export type AuthContext = z.infer<typeof authContextSchema>;

export const controlPlaneRoleSchema = z.enum(['platform_admin', 'capability_operator', 'auditor']);
export type ControlPlaneRole = z.infer<typeof controlPlaneRoleSchema>;

export const controlPlanePermissionSchema = z.enum([
  'registry:read',
  'registry:write',
  'registry:validate',
  'registry:publish',
  'registry:gray',
  'registry:rollback',
  'registry:deprecate',
  'registry:disable',
  'release:read',
  'operations:read',
  'human_task:decide',
]);
export type ControlPlanePermission = z.infer<typeof controlPlanePermissionSchema>;

export class AuthError extends Error {
  constructor(
    readonly code: 'UNAUTHORIZED' | 'FORBIDDEN',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'authorization',
  'api_key',
  'apiKey',
  'secret',
  'credential',
]);

export function parseAuthContext(headers: Record<string, string | string[] | undefined>): AuthContext {
  const value = (name: string): string | undefined => {
    const header = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(header) ? header[0] : header;
  };

  return authContextSchema.parse({
    tenant_id: value('x-tenant-id'),
    user_id: value('x-user-id'),
    roles: parseRoles(value('x-roles') ?? value('x-user-roles')),
    request_id: value('x-request-id'),
    org_id: value('x-org-id'),
    session_id: value('x-session-id'),
  });
}

export function parseOptionalAuthContext(headers: Record<string, string | string[] | undefined>): AuthContext | undefined {
  const value = (name: string): string | undefined => {
    const header = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(header) ? header[0] : header;
  };
  if (!value('x-tenant-id') || !value('x-user-id')) {
    return undefined;
  }
  return parseAuthContext(headers);
}

export function requireAuthContext(
  headers: Record<string, string | string[] | undefined>,
  options: {
    authMode: 'header' | 'disabled';
    nodeEnv?: string;
    testIdentity?: AuthContext;
  },
): AuthContext {
  const isProduction = options.nodeEnv === 'production';
  if (options.authMode === 'disabled') {
    if (isProduction) {
      throw new AuthError('UNAUTHORIZED', 'CONTROL_PLANE_AUTH_MODE=disabled is not allowed in production');
    }
    if (options.testIdentity) {
      return authContextSchema.parse(options.testIdentity);
    }
  }

  const parsed = parseOptionalAuthContext(headers);
  if (!parsed) {
    throw new AuthError('UNAUTHORIZED', 'Missing control-plane identity headers');
  }
  return parsed;
}

export function hasControlPlanePermission(auth: AuthContext, permission: ControlPlanePermission): boolean {
  const rolePermissions = new Set(auth.roles.flatMap((role) => permissionsForRole(role)));
  return rolePermissions.has(permission);
}

export function requireControlPlanePermission(auth: AuthContext, permission: ControlPlanePermission): void {
  if (!hasControlPlanePermission(auth, permission)) {
    throw new AuthError('FORBIDDEN', 'Permission denied', { permission, roles: auth.roles });
  }
}

export function permissionsForRole(role: string): ControlPlanePermission[] {
  const parsed = controlPlaneRoleSchema.safeParse(role);
  if (!parsed.success) {
    return [];
  }
  switch (parsed.data) {
    case 'platform_admin':
      return [...controlPlanePermissionSchema.options];
    case 'capability_operator':
      return [
        'registry:read',
        'registry:write',
        'registry:validate',
        'registry:publish',
        'registry:gray',
        'registry:rollback',
        'release:read',
        'operations:read',
        'human_task:decide',
      ];
    case 'auditor':
      return ['registry:read', 'release:read', 'operations:read'];
  }
}

function parseRoles(value: string | undefined): string[] {
  return value?.split(',').map((role) => role.trim()).filter(Boolean) ?? [];
}

export function maskSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveFields(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEYS.has(key) ? '[REDACTED]' : maskSensitiveFields(entry),
      ]),
    );
  }

  return value;
}
