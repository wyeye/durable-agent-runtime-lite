import pino, { type Logger, type LoggerOptions } from 'pino';

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
