import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RuntimeConfig } from '@dar/config';
import type { AuthContext, ControlPlanePermission, IdentityDirectory } from '@dar/security';
import {
  requireAuthContext,
  requireControlPlanePermission,
  resolvedIdentityToAuthContext,
} from '@dar/security';

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
    resolvedIdentity?: import('@dar/security').ResolvedIdentity;
  }
}

export interface ControlPlaneAuthPluginOptions {
  config: RuntimeConfig;
  identityDirectory?: IdentityDirectory | undefined;
}

export async function authPlugin(server: FastifyInstance, options: ControlPlaneAuthPluginOptions): Promise<void> {
  const { config, identityDirectory } = options;

  server.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) {
      return;
    }

    // DB mode: resolve identity from database
    if (config.IAM_DIRECTORY_MODE === 'db' && identityDirectory) {
      const parsed = requireAuthContext(request.headers, {
        authMode: config.CONTROL_PLANE_AUTH_MODE,
        nodeEnv: config.NODE_ENV,
        testIdentity: {
          tenant_id: 'default',
          user_id: 'dev_control_plane',
          roles: ['platform_admin'],
          request_id: headerValue(request, 'x-request-id'),
        },
      });

      // In DB mode, resolve from directory (ignoring header roles)
      const resolved = await identityDirectory.resolve({
        user_id: parsed.user_id,
        tenant_id: parsed.tenant_id,
        request_id: parsed.request_id,
      });
      request.resolvedIdentity = resolved;
      request.authContext = resolvedIdentityToAuthContext(resolved);
      return;
    }

    // Header mode: existing behavior
    request.authContext = requireAuthContext(request.headers, {
      authMode: config.CONTROL_PLANE_AUTH_MODE,
      nodeEnv: config.NODE_ENV,
      testIdentity: {
        tenant_id: 'default',
        user_id: 'dev_control_plane',
        roles: ['platform_admin'],
        request_id: headerValue(request, 'x-request-id'),
      },
    });
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

export function resolvedIdentityOf(request: FastifyRequest): import('@dar/security').ResolvedIdentity | undefined {
  return request.resolvedIdentity;
}

export function requirePermission(request: FastifyRequest, permission: ControlPlanePermission): AuthContext {
  const auth = authOf(request);
  requireControlPlanePermission(auth, permission);
  return auth;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : undefined;
}
