import type { FastifyInstance } from 'fastify';
import type { RuntimeConfig } from '@dar/config';
import { iamResolvedIdentitySchema } from '@dar/contracts';
import { AuthError, type IdentityDirectory } from '@dar/security';
import { z } from 'zod';
import { jsonSchema, ok, requestIdOf } from '../utils/http.js';

const localDevLoginRequestSchema = z.object({
  user_id: z.string().trim().min(1),
  tenant_id: z.string().trim().min(1),
  password: z.string().min(1),
});

export interface LocalDevAuthRoutesOptions {
  config: RuntimeConfig;
  identityDirectory: IdentityDirectory;
}

export async function localDevAuthRoutes(
  server: FastifyInstance,
  options: LocalDevAuthRoutesOptions,
): Promise<void> {
  const { config, identityDirectory } = options;

  server.post('/api/v1/auth/dev-login', {
    schema: { body: jsonSchema(localDevLoginRequestSchema) },
  }, async (request) => {
    const body = localDevLoginRequestSchema.parse(request.body);
    if (!config.CONTROL_PLANE_LOCAL_DEV_PASSWORD || body.password !== config.CONTROL_PLANE_LOCAL_DEV_PASSWORD) {
      throw new AuthError('UNAUTHORIZED', 'Invalid local development login credentials');
    }

    const resolved = await identityDirectory.resolve({
      user_id: body.user_id,
      tenant_id: body.tenant_id,
      request_id: requestIdOf(request),
    });
    return ok(iamResolvedIdentitySchema.parse(resolved), requestIdOf(request));
  });
}
