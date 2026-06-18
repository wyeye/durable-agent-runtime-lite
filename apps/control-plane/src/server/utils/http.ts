import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType, toJSONSchema } from 'zod';
import type {
  RuntimeError,
  StandardErrorResponse,
  StandardSuccessResponse,
} from '@dar/contracts';
import { RegistryRepositoryError } from '@dar/db';
import { AuthError } from '@dar/security';

export class ControlPlaneHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ControlPlaneHttpError';
  }
}

export function ok<T>(data: T, requestId?: string): StandardSuccessResponse<T> {
  return requestId
    ? { success: true, data, error: null, trace_id: requestId }
    : { success: true, data, error: null };
}

export function fail(error: RuntimeError, requestId?: string): StandardErrorResponse {
  return requestId
    ? { success: false, data: null, error, trace_id: requestId }
    : { success: false, data: null, error };
}

export function requestIdOf(request: FastifyRequest): string | undefined {
  const header = request.headers['x-request-id'];
  if (Array.isArray(header)) {
    return header[0];
  }
  if (typeof header === 'string') {
    return header;
  }
  const body = request.body;
  if (body && typeof body === 'object' && 'request_id' in body) {
    const requestId = (body as { request_id?: unknown }).request_id;
    return typeof requestId === 'string' ? requestId : undefined;
  }
  return undefined;
}

export function jsonSchema(schema: ZodType): unknown {
  return stripJsonSchemaMeta(toJSONSchema(schema, { io: 'input' }));
}

export function mapError(error: unknown): { statusCode: number; body: StandardErrorResponse } {
  const requestId = undefined;
  if (error instanceof ControlPlaneHttpError) {
    return {
      statusCode: error.statusCode,
      body: fail({ code: error.code, message: error.message, details: scrubDetails(error.details) }, requestId),
    };
  }

  if (error instanceof AuthError) {
    return {
      statusCode: error.code === 'UNAUTHORIZED' ? 401 : 403,
      body: fail({ code: error.code, message: error.message, details: scrubDetails(error.details) }, requestId),
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: fail({
        code: 'BAD_REQUEST',
        message: 'Request validation failed',
        details: { issues: error.issues },
      }, requestId),
    };
  }

  if (error instanceof RegistryRepositoryError) {
    return {
      statusCode: statusForRegistryError(error.code),
      body: fail({
        code: error.code,
        message: error.message,
        details: scrubDetails(error.details),
      }, requestId),
    };
  }

  if (error instanceof Error && /validation failed|can_publish=false|dependency/i.test(error.message)) {
    return {
      statusCode: 422,
      body: fail({ code: 'REGISTRY_VALIDATION_FAILED', message: 'Registry validation failed' }, requestId),
    };
  }

  return {
    statusCode: 500,
    body: fail({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' }, requestId),
  };
}

export function installErrorHandler(reply: FastifyReply, request: FastifyRequest, error: unknown): StandardErrorResponse {
  const mapped = mapError(error);
  const body = mapped.body.trace_id
    ? mapped.body
    : { ...mapped.body, trace_id: requestIdOf(request) };
  reply.code(mapped.statusCode);
  return body;
}

function statusForRegistryError(code: string): number {
  if (code === 'REGISTRY_VERSION_NOT_FOUND' || code === 'REGISTRY_RESOURCE_NOT_FOUND') {
    return 404;
  }
  if (
    code === 'REGISTRY_OPTIMISTIC_LOCK_CONFLICT' ||
    code === 'REGISTRY_VERSION_IMMUTABLE' ||
    code === 'REGISTRY_VERSION_ALREADY_EXISTS' ||
    code === 'INVALID_SPEC_STATUS_TRANSITION' ||
    code === 'REGISTRY_ROLLBACK_TARGET_NOT_PUBLISHED'
  ) {
    return 409;
  }
  return 400;
}

function scrubDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(([key]) => !/sql|stack|password|secret|token|connection/i.test(key)),
  );
}

function stripJsonSchemaMeta(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripJsonSchemaMeta);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '$schema')
        .map(([key, nested]) => [key, stripJsonSchemaMeta(nested)]),
    );
  }
  return value;
}
