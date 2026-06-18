import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RuntimeConfig } from '@dar/config';
import type { AuthContext, ControlPlanePermission } from '@dar/security';
import {
  requireAuthContext,
  requireControlPlanePermission,
} from '@dar/security';

declare module 'fastify' {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

export async function authPlugin(server: FastifyInstance, options: { config: RuntimeConfig }): Promise<void> {
  server.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) {
      return;
    }
    request.authContext = requireAuthContext(request.headers, {
      authMode: options.config.CONTROL_PLANE_AUTH_MODE,
      nodeEnv: options.config.NODE_ENV,
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
