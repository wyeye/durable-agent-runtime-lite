import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodType, toJSONSchema } from 'zod';
import {
  errorResponse,
  requestLocale,
  successResponse,
  zodErrorResponse,
} from '@dar/i18n';
import type {
  RuntimeError,
  StandardErrorResponse,
  StandardSuccessResponse,
} from '@dar/contracts';
import { EvaluationGateError, EvaluationRepositoryError, RegistryRepositoryError } from '@dar/db';
import { IamRepositoryError } from '@dar/db';
import { AuthError } from '@dar/security';
import { IamServiceError } from '../services/iam/user-directory-service.js';
import { mapIamError } from '../routes/iam.js';

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
  return successResponse(data, responseOptions(requestId)) as StandardSuccessResponse<T>;
}

export function fail(error: RuntimeError, requestId?: string, locale?: unknown): StandardErrorResponse {
  const input: Parameters<typeof errorResponse>[0] = {
    code: error.code,
    ...(error.message_key ? { messageKey: error.message_key } : {}),
    ...(error.params ? { params: error.params as Record<string, string | number | boolean | null | undefined> } : {}),
    ...(error.details ? { details: error.details } : {}),
  };
  return errorResponse(input, responseOptions(requestId, locale)) as StandardErrorResponse;
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

export function mapError(error: unknown, request?: FastifyRequest): { statusCode: number; body: StandardErrorResponse } {
  const requestId = request ? requestIdOf(request) : undefined;
  const locale = request ? requestLocale(request) : undefined;
  if (error instanceof ControlPlaneHttpError) {
    return {
      statusCode: error.statusCode,
      body: fail({ code: error.code, message: error.message, details: scrubDetails(error.details) }, requestId, locale),
    };
  }

  if (error instanceof AuthError) {
    return {
      statusCode: error.code === 'UNAUTHORIZED' ? 401 : 403,
      body: fail({ code: error.code, message: error.message, details: scrubDetails(error.details) }, requestId, locale),
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      body: zodErrorResponse(error, responseOptions(requestId, locale)) as StandardErrorResponse,
    };
  }

  if (error instanceof RegistryRepositoryError) {
    return {
      statusCode: statusForRegistryError(error.code),
      body: fail({
        code: error.code,
        message: error.message,
        details: scrubDetails(error.details),
      }, requestId, locale),
    };
  }

  if (error instanceof EvaluationGateError) {
    return {
      statusCode: 422,
      body: fail({
        code: error.code,
        message: error.message,
        details: scrubDetails(error.details),
      }, requestId, locale),
    };
  }

  if (error instanceof EvaluationRepositoryError) {
    return {
      statusCode: statusForEvaluationRepositoryError(error.code),
      body: fail({
        code: error.code,
        message: error.message,
        details: scrubDetails(error.details),
      }, requestId, locale),
    };
  }

  if (error instanceof IamServiceError || error instanceof IamRepositoryError) {
    const mapped = mapIamError(error);
    if (mapped) {
      return {
        statusCode: mapped.statusCode,
        body: fail({
          code: mapped.code,
          message: mapped.message,
          details: scrubDetails(error.details),
        }, requestId, locale),
      };
    }
  }

  if (error instanceof Error && /validation failed|can_publish=false|dependency/i.test(error.message)) {
    return {
      statusCode: 422,
      body: fail({ code: 'REGISTRY_VALIDATION_FAILED', message: 'Registry validation failed' }, requestId, locale),
    };
  }

  return {
    statusCode: 500,
    body: fail({ code: 'INTERNAL_ERROR', message: 'Internal server error' }, requestId, locale),
  };
}

export function installErrorHandler(reply: FastifyReply, request: FastifyRequest, error: unknown): StandardErrorResponse {
  const mapped = mapError(error, request);
  const body = mapped.body.trace_id ? mapped.body : { ...mapped.body, trace_id: requestIdOf(request) };
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

function responseOptions(traceId?: string, locale?: unknown): { traceId?: string; locale?: unknown } {
  return {
    ...(traceId ? { traceId } : {}),
    ...(locale ? { locale } : {}),
  };
}

function statusForEvaluationRepositoryError(code: string): number {
  if (code.endsWith('_NOT_FOUND')) {
    return 404;
  }
  if (
    code.endsWith('_REVISION_CONFLICT') ||
    code.endsWith('_IMMUTABLE') ||
    code.endsWith('_NOT_MUTABLE') ||
    code.endsWith('_ROLLBACK_TARGET_INVALID')
  ) {
    return 409;
  }
  if (
    code.endsWith('_NOT_PUBLISHABLE') ||
    code.endsWith('_NOT_VALIDATABLE') ||
    code.endsWith('_EMPTY') ||
    code.endsWith('_MISMATCH') ||
    code.endsWith('_REQUIRED') ||
    code.endsWith('_NOT_PUBLISHED')
  ) {
    return 422;
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
