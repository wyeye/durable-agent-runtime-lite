import { ERROR_MESSAGE_KEYS } from './keys.js';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from './locale.js';
import { translate, type SafeTranslationParams } from './translator.js';

export interface LocalizedErrorShape {
  code: string;
  message_key: string;
  message: string;
  locale: SupportedLocale;
  params?: SafeTranslationParams;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly name = 'AppError';

  constructor(
    readonly code: string,
    readonly messageKey: string,
    readonly httpStatus = 500,
    readonly messageParams: SafeTranslationParams = {},
    readonly retryable = false,
    readonly safeDetails: Record<string, unknown> = {},
  ) {
    super(messageKey);
  }
}

export function messageKeyForErrorCode(code: string): string {
  return ERROR_MESSAGE_KEYS[code as keyof typeof ERROR_MESSAGE_KEYS] ?? 'errors.internalError';
}

export function localizeError(input: {
  code: string;
  messageKey?: string;
  params?: SafeTranslationParams;
  details?: Record<string, unknown>;
  locale?: unknown;
}): LocalizedErrorShape {
  const locale = resolveLocale(input.locale ?? DEFAULT_LOCALE);
  const messageKey = input.messageKey ?? messageKeyForErrorCode(input.code);
  const base = {
    code: input.code,
    message_key: messageKey,
    message: translate(messageKey, input.params, locale),
    locale,
  };
  return {
    ...base,
    ...(input.params && Object.keys(input.params).length > 0 ? { params: input.params } : {}),
    ...(input.details && Object.keys(input.details).length > 0 ? { details: scrubErrorDetails(input.details) } : {}),
  };
}

export function scrubErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !/sql|stack|password|secret|token|connection|authorization|cookie|api[_-]?key/iu.test(key))
      .map(([key, value]) => [key, scrubValue(value)]),
  );
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value && typeof value === 'object') {
    return scrubErrorDetails(value as Record<string, unknown>);
  }
  if (typeof value === 'string' && /password|secret|token|postgres:\/\/|authorization|cookie/iu.test(value)) {
    return '[REDACTED]';
  }
  return value;
}
