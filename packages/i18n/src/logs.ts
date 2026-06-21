import { LOG_MESSAGE_KEYS, type LogEventCode } from './keys.js';
import { resolveLocale, type SupportedLocale } from './locale.js';
import { translate, type SafeTranslationParams } from './translator.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type StructuredLogger = Record<LogLevel, (bindings: Record<string, unknown>, message: string) => void>;

export interface LocalizedLogBindings {
  event_code: string;
  message_key: string;
  message: string;
  locale: SupportedLocale;
  params?: SafeTranslationParams;
  [key: string]: unknown;
}

export function messageKeyForLogEvent(eventCode: string): string {
  return LOG_MESSAGE_KEYS[eventCode as LogEventCode] ?? 'logs.dependencyFailed';
}

export function createLocalizedLogBindings(
  eventCode: string,
  params: SafeTranslationParams = {},
  context: Record<string, unknown> = {},
  locale: unknown = process.env.LOG_LOCALE,
): LocalizedLogBindings {
  const resolved = resolveLocale(locale);
  const messageKey = messageKeyForLogEvent(eventCode);
  return {
    ...context,
    event_code: eventCode,
    message_key: messageKey,
    message: translate(messageKey, params, resolved),
    locale: resolved,
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

export function logEvent(
  logger: StructuredLogger,
  level: LogLevel,
  eventCode: string,
  params: SafeTranslationParams = {},
  context: Record<string, unknown> = {},
): void {
  const bindings = createLocalizedLogBindings(eventCode, params, context);
  logger[level](bindings, bindings.message);
}

export function logErrorEvent(
  logger: Pick<StructuredLogger, 'error'>,
  eventCode: string,
  error: unknown,
  params: SafeTranslationParams = {},
  context: Record<string, unknown> = {},
): void {
  const bindings = createLocalizedLogBindings(eventCode, params, context);
  logger.error({
    ...bindings,
    err: error,
  }, bindings.message);
}
