import type { FastifyInstance } from 'fastify';
import { installErrorHandler } from '../utils/http.js';

export async function errorHandlerPlugin(server: FastifyInstance): Promise<void> {
  server.setErrorHandler((error, request, reply) => {
    const err = error instanceof Error ? error as Error & { statusCode?: number; code?: string } : undefined;
    request.log.error(
      {
        request_id: request.headers['x-request-id'],
        tenant_id: request.authContext?.tenant_id,
        user_id: request.authContext?.user_id,
        method: request.method,
        path: request.url,
        status_code: err?.statusCode,
        error_code: err?.code,
      },
      'control-plane request failed',
    );
    return installErrorHandler(reply, request, error);
  });
}
