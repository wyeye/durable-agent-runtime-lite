import { ZodError } from 'zod';
import { localizeError, type LocalizedErrorShape } from './errors.js';
import { resolveLocale, type SupportedLocale } from './locale.js';
import { translate, type SafeTranslationParams } from './translator.js';
import { localizeZodIssues } from './zod.js';

export interface StandardLocalizedSuccess<TData = unknown> {
  success: true;
  data: TData;
  error: null;
  message_key?: string;
  message?: string;
  locale?: SupportedLocale;
  trace_id?: string;
}

export interface StandardLocalizedError {
  success: false;
  data: null;
  error: LocalizedErrorShape;
  trace_id?: string;
}

export function successResponse<TData>(
  data: TData,
  options: {
    traceId?: string;
    locale?: unknown;
    messageKey?: string;
    params?: SafeTranslationParams;
  } = {},
): StandardLocalizedSuccess<TData> {
  const locale = options.messageKey ? resolveLocale(options.locale) : undefined;
  const response: StandardLocalizedSuccess<TData> = {
    success: true,
    data,
    error: null,
    ...(options.traceId ? { trace_id: options.traceId } : {}),
  };
  if (options.messageKey && locale) {
    response.message_key = options.messageKey;
    response.message = translate(options.messageKey, options.params, locale);
    response.locale = locale;
  }
  return response;
}

export function errorResponse(
  input: {
    code: string;
    messageKey?: string;
    params?: SafeTranslationParams;
    details?: Record<string, unknown>;
  },
  options: { traceId?: string; locale?: unknown } = {},
): StandardLocalizedError {
  return {
    success: false,
    data: null,
    error: localizeError({ ...input, locale: options.locale }),
    ...(options.traceId ? { trace_id: options.traceId } : {}),
  };
}

export function zodErrorResponse(
  error: ZodError,
  options: { traceId?: string; locale?: unknown } = {},
): StandardLocalizedError {
  const locale = resolveLocale(options.locale);
  return errorResponse({
    code: 'VALIDATION_FAILED',
    messageKey: 'errors.validationFailed',
    details: { issues: localizeZodIssues(error.issues, locale) },
  }, { ...options, locale });
}
