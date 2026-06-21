import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RuntimeConfig } from '@dar/config';
import { errorResponse, requestLocale } from '@dar/i18n';
import type { AuthContext, ControlPlanePermission } from '@dar/security';
import {
  AuthError,
  hasControlPlanePermission,
  requireAuthContext,
} from '@dar/security';
import { createRequestId } from '../modules/task/task-id.js';

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

export function runtimeAuthPlugin(server: FastifyInstance, options: { config: RuntimeConfig }): void {
  validateRuntimeAuthConfig(options.config);
  server.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) {
      return;
    }
    if (options.config.RUNTIME_API_AUTH_MODE === 'disabled') {
      return;
    }
    try {
      request.authContext = requireAuthContext(request.headers, {
        authMode: options.config.RUNTIME_API_AUTH_MODE,
        nodeEnv: options.config.NODE_ENV,
        requireRoles: true,
        testIdentity: {
          tenant_id: 'default',
          user_id: 'dev_runtime_api',
          roles: ['platform_admin'],
          request_id: headerValue(request, 'x-request-id') ?? createRequestId(),
        },
      });
      request.authContext.request_id ??= createRequestId();
    } catch (error) {
      if (error instanceof AuthError) {
        await sendAuthError(reply, error, request);
        return;
      }
      throw error;
    }
  });
}

export function authOf(request: FastifyRequest): AuthContext {
  if (!request.authContext) {
    request.authContext = requireAuthContext(request.headers, {
      authMode: 'header',
      nodeEnv: 'production',
    });
  }
  return request.authContext;
}

export function readAuth(request: FastifyRequest): AuthContext {
  return authOf(request);
}

export function requireWriteAuth(request: FastifyRequest): AuthContext | undefined {
  const auth = request.authContext;
  if (!auth) {
    return undefined;
  }
  if (auth.roles.includes('auditor') && !hasAnyWriteRole(auth)) {
    throw new AuthError('FORBIDDEN', 'Auditor role cannot perform runtime write operations');
  }
  return auth;
}

export function requireDecisionAuth(request: FastifyRequest): AuthContext | undefined {
  const auth = request.authContext;
  if (!auth) {
    return undefined;
  }
  if (!hasRuntimePermission(auth, 'human_task:decide')) {
    throw new AuthError('FORBIDDEN', 'Permission denied', {
      permission: 'human_task:decide',
      roles: auth.roles,
    });
  }
  return auth;
}

export function withAuthBody<T extends Record<string, unknown>>(
  request: FastifyRequest,
  body: unknown,
  auth: AuthContext | undefined,
): T & { tenant_id?: string; user_id?: string; request_id: string } {
  const input = objectValue(body);
  if (!auth) {
    return {
      ...input,
      request_id: stringValue(input.request_id) ?? createRequestId(),
    } as T & { tenant_id?: string; user_id?: string; request_id: string };
  }
  assertIdentityMatches(input, auth, 'body');
  return {
    ...input,
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
    request_id: requestId(input, auth),
  } as T & { tenant_id: string; user_id: string; request_id: string };
}

export function withAuthQuery<T extends Record<string, unknown>>(
  query: unknown,
  auth: AuthContext | undefined,
): T & { tenant_id?: string; user_id?: string } {
  const input = objectValue(query);
  if (!auth) {
    return input as T & { tenant_id?: string; user_id?: string };
  }
  assertIdentityMatches(input, auth, 'query');
  return {
    ...input,
    tenant_id: auth.tenant_id,
    user_id: auth.user_id,
  } as T & { tenant_id: string; user_id: string };
}

export function validateRuntimeAuthConfig(config: RuntimeConfig): void {
  const production = config.NODE_ENV === 'production' || config.APP_ENV === 'production';
  if (production && config.RUNTIME_API_AUTH_MODE !== 'header') {
    throw new AuthError('UNAUTHORIZED', 'RUNTIME_API_AUTH_MODE=header is required in production');
  }
}

function hasRuntimePermission(auth: AuthContext, permission: ControlPlanePermission): boolean {
  return auth.roles.includes('platform_admin')
    || auth.roles.includes('capability_operator')
    || hasControlPlanePermission(auth, permission);
}

function hasAnyWriteRole(auth: AuthContext): boolean {
  return auth.roles.includes('platform_admin') || auth.roles.includes('capability_operator');
}

function assertIdentityMatches(input: Record<string, unknown>, auth: AuthContext, source: 'body' | 'query'): void {
  const tenantId = stringValue(input.tenant_id);
  const userId = stringValue(input.user_id);
  if (tenantId && tenantId !== auth.tenant_id) {
    throw new AuthError('FORBIDDEN', `${source} tenant_id does not match authenticated tenant`);
  }
  if (userId && userId !== auth.user_id) {
    throw new AuthError('FORBIDDEN', `${source} user_id does not match authenticated user`);
  }
  if (tenantId === 'default' && auth.tenant_id !== 'default') {
    throw new AuthError('FORBIDDEN', `${source} tenant_id default fallback is not allowed`);
  }
}

function requestId(input: Record<string, unknown>, auth: AuthContext): string {
  return stringValue(input.request_id) ?? auth.request_id ?? createRequestId();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function sendAuthError(reply: FastifyReply, error: AuthError, request?: FastifyRequest): Promise<void> {
  const traceId = request ? headerValue(request, 'x-request-id') : undefined;
  reply.code(error.code === 'UNAUTHORIZED' ? 401 : 403).send(errorResponse({
    code: error.code,
    ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
  }, {
    ...(request ? { locale: requestLocale(request) } : {}),
    ...(traceId ? { traceId } : {}),
  }));
}
