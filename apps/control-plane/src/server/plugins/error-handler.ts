import type { FastifyInstance } from 'fastify';
import { logErrorEvent } from '@dar/logger';
import { createLogger } from '@dar/logger';
import { installErrorHandler } from '../utils/http.js';

const logger = createLogger('control-plane');

export async function errorHandlerPlugin(server: FastifyInstance): Promise<void> {
  server.setErrorHandler((error, request, reply) => {
    const err = error instanceof Error ? error as Error & { statusCode?: number; code?: string } : undefined;
    logErrorEvent(
      logger,
      'http.request_completed',
      error,
      { service: 'control-plane' },
      compactBindings({
        request_id: headerString(request.headers['x-request-id']),
        tenant_id: request.authContext?.tenant_id,
        user_id: request.authContext?.user_id,
        method: request.method,
        path: request.url,
        status_code: err?.statusCode,
        error_code: err?.code,
      }),
    );
    return installErrorHandler(reply, request, error);
  });
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function compactBindings(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
