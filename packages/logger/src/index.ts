import pino, { type Logger, type LoggerOptions } from 'pino';
import {
  createLocalizedLogBindings as createI18nLogBindings,
  logErrorEvent as writeLocalizedErrorEvent,
  logEvent as writeLocalizedLogEvent,
  type LogLevel,
  type SafeTranslationParams,
} from '@dar/i18n';

export interface LoggerBindings {
  request_id?: string;
  tenant_id?: string;
  user_id?: string;
  task_run_id?: string;
  workflow_id?: string;
  flow_id?: string;
  flow_version?: number;
  tool_name?: string;
  [key: string]: unknown;
}

const REDACT_PATHS = [
  'password',
  'token',
  'authorization',
  'api_key',
  'apiKey',
  'secret',
  '*.password',
  '*.token',
  '*.authorization',
  '*.api_key',
  '*.apiKey',
  '*.secret',
];

export function createLogger(app: string, bindings: LoggerBindings = {}): Logger {
  const options: LoggerOptions = {
    name: app,
    level: process.env.LOG_LEVEL ?? 'info',
    base: { app },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
  };

  return pino(options).child(bindings);
}

export function childLogger(logger: Logger, bindings: LoggerBindings): Logger {
  return logger.child(bindings);
}

export function createLocalizedLogBindings(
  eventCode: string,
  params: SafeTranslationParams = {},
  context: LoggerBindings = {},
) {
  return createI18nLogBindings(eventCode, params, context);
}

export function logEvent(
  logger: Logger,
  level: LogLevel,
  eventCode: string,
  params: SafeTranslationParams = {},
  context: LoggerBindings = {},
): void {
  writeLocalizedLogEvent(logger, level, eventCode, params, context);
}

export function logErrorEvent(
  logger: Logger,
  eventCode: string,
  error: unknown,
  params: SafeTranslationParams = {},
  context: LoggerBindings = {},
): void {
  writeLocalizedErrorEvent(logger, eventCode, error, params, context);
}
