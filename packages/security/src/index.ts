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

export const serviceIdSchema = z.enum(['runtime-worker', 'control-plane']);
export type ServiceId = z.infer<typeof serviceIdSchema>;

export const servicePermissionSchema = z.enum([
  'tool_manifest:read',
  'tool:invoke',
  'tool:preview',
  'tool:commit',
  'audit:read',
  'tool_call:read',
  'idempotency:debug',
]);
export type ServicePermission = z.infer<typeof servicePermissionSchema>;

export const serviceIdentitySchema = z.object({
  service_id: serviceIdSchema,
  request_id: z.string().optional(),
  tenant_id: z.string().optional(),
  user_id: z.string().optional(),
});
export type ServiceIdentity = z.infer<typeof serviceIdentitySchema>;

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

export class ServiceAuthError extends Error {
  constructor(
    readonly code: 'UNAUTHORIZED' | 'FORBIDDEN',
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServiceAuthError';
  }
}

export interface StaticServiceTokenVerifierOptions {
  authMode: 'service_token' | 'disabled';
  nodeEnv?: string;
  tokens: Partial<Record<ServiceId, string | undefined>>;
  minimumTokenLength?: number;
}

export class StaticServiceTokenVerifier {
  constructor(private readonly options: StaticServiceTokenVerifierOptions) {}

  validateConfiguration(): void {
    assertServiceTokenConfiguration(this.options);
  }

  verify(
    headers: Record<string, string | string[] | undefined>,
    permission: ServicePermission,
  ): ServiceIdentity {
    const production = this.options.nodeEnv === 'production';
    if (this.options.authMode === 'disabled') {
      if (production) {
        throw new ServiceAuthError('UNAUTHORIZED', 'TOOL_GATEWAY_AUTH_MODE=disabled is not allowed in production');
      }
      return serviceIdentitySchema.parse({
        service_id: headerValue(headers, 'x-service-id') ?? 'runtime-worker',
        request_id: headerValue(headers, 'x-request-id'),
        tenant_id: headerValue(headers, 'x-tenant-id'),
        user_id: headerValue(headers, 'x-user-id'),
      });
    }
    if (production) {
      this.validateConfiguration();
    }

    const serviceIdValue = headerValue(headers, 'x-service-id');
    const parsedServiceId = serviceIdSchema.safeParse(serviceIdValue);
    if (!parsedServiceId.success) {
      throw new ServiceAuthError('UNAUTHORIZED', 'Missing or invalid service identity');
    }

    const token = bearerToken(headerValue(headers, 'authorization'));
    if (!token) {
      throw new ServiceAuthError('UNAUTHORIZED', 'Missing service bearer token');
    }

    const expectedToken = this.options.tokens[parsedServiceId.data];
    if (!expectedToken || !constantTimeEqual(token, expectedToken)) {
      throw new ServiceAuthError('UNAUTHORIZED', 'Invalid service bearer token');
    }

    if (!serviceHasPermission(parsedServiceId.data, permission)) {
      throw new ServiceAuthError('FORBIDDEN', 'Service is not allowed to perform this operation', {
        service_id: parsedServiceId.data,
        permission,
      });
    }

    return serviceIdentitySchema.parse({
      service_id: parsedServiceId.data,
      request_id: headerValue(headers, 'x-request-id'),
      tenant_id: headerValue(headers, 'x-tenant-id'),
      user_id: headerValue(headers, 'x-user-id'),
    });
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
    requireRoles?: boolean;
  },
): AuthContext {
  const isProduction = options.nodeEnv === 'production';
  if (options.authMode === 'disabled') {
    if (isProduction) {
      throw new AuthError('UNAUTHORIZED', 'Header authentication is required in production');
    }
    if (options.testIdentity) {
      return authContextSchema.parse(options.testIdentity);
    }
  }

  const parsed = parseOptionalAuthContext(headers);
  if (!parsed) {
    throw new AuthError('UNAUTHORIZED', 'Missing identity headers');
  }
  if (options.requireRoles && parsed.roles.length === 0) {
    throw new AuthError('UNAUTHORIZED', 'Missing identity roles header');
  }
  return parsed;
}

export function servicePermissionsForService(serviceId: ServiceId): ServicePermission[] {
  switch (serviceId) {
    case 'runtime-worker':
      return ['tool_manifest:read', 'tool:invoke', 'tool:preview', 'tool:commit'];
    case 'control-plane':
      return ['tool_manifest:read', 'audit:read', 'tool_call:read', 'idempotency:debug'];
  }
}

export function serviceHasPermission(serviceId: ServiceId, permission: ServicePermission): boolean {
  return servicePermissionsForService(serviceId).includes(permission);
}

export function buildServiceIdentityHeaders(input: {
  serviceId: ServiceId;
  token?: string;
  requestId?: string;
  tenantId?: string;
  userId?: string;
}): Record<string, string> {
  return {
    'x-service-id': input.serviceId,
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    ...(input.requestId ? { 'x-request-id': input.requestId } : {}),
    ...(input.tenantId ? { 'x-tenant-id': input.tenantId } : {}),
    ...(input.userId ? { 'x-user-id': input.userId } : {}),
  };
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

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? '');
  return match?.[1];
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const maxLength = Math.max(actual.length, expected.length);
  let diff = actual.length ^ expected.length;
  for (let index = 0; index < maxLength; index += 1) {
    const actualCode = index < actual.length ? actual.charCodeAt(index) : 0;
    const expectedCode = index < expected.length ? expected.charCodeAt(index) : 0;
    diff |= actualCode ^ expectedCode;
  }
  return diff === 0;
}

export const MINIMUM_SERVICE_TOKEN_LENGTH = 24;

const PLACEHOLDER_SERVICE_TOKEN_PATTERNS = [
  /^replace-with-runtime-worker-service-token$/u,
  /^replace-with-control-plane-service-token$/u,
  /^local-dev-/u,
];

export function isPlaceholderServiceToken(token: string | undefined): boolean {
  return Boolean(token && PLACEHOLDER_SERVICE_TOKEN_PATTERNS.some((pattern) => pattern.test(token)));
}

export function assertServiceTokenConfiguration(options: StaticServiceTokenVerifierOptions): void {
  if (options.authMode === 'disabled') {
    if (options.nodeEnv === 'production') {
      throw new ServiceAuthError('UNAUTHORIZED', 'TOOL_GATEWAY_AUTH_MODE=disabled is not allowed in production');
    }
    return;
  }

  const minimumLength = options.minimumTokenLength ?? MINIMUM_SERVICE_TOKEN_LENGTH;
  const runtimeWorkerToken = options.tokens['runtime-worker'];
  const controlPlaneToken = options.tokens['control-plane'];
  if (!runtimeWorkerToken || !controlPlaneToken) {
    throw new ServiceAuthError('UNAUTHORIZED', 'Tool Gateway service tokens are required');
  }
  if (runtimeWorkerToken.length < minimumLength || controlPlaneToken.length < minimumLength) {
    throw new ServiceAuthError('UNAUTHORIZED', 'Tool Gateway service tokens do not meet minimum length');
  }
  if (isPlaceholderServiceToken(runtimeWorkerToken) || isPlaceholderServiceToken(controlPlaneToken)) {
    throw new ServiceAuthError('UNAUTHORIZED', 'Tool Gateway service tokens must not use placeholder values');
  }
  if (constantTimeEqual(runtimeWorkerToken, controlPlaneToken)) {
    throw new ServiceAuthError('UNAUTHORIZED', 'Tool Gateway service tokens must be distinct');
  }
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
