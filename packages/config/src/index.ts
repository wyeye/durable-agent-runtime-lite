import { z } from 'zod';

export const appNameSchema = z.enum([
  'control-plane',
  'runtime-api',
  'runtime-worker',
  'tool-gateway',
  'mock-server',
]);

const portSchema = z.coerce.number().int().min(1).max(65_535);

export const runtimeConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.string().default('local'),
  APP_VERSION: z.string().default('0.1.5'),
  DATABASE_URL: z.string().url(),
  VALKEY_URL: z.string().url(),
  TEMPORAL_ADDRESS: z.string().min(1),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  MODEL_GATEWAY_BASE_URL: z.string().url(),
  MODEL_GATEWAY_API_KEY: z.string().min(1),
  TOOL_GATEWAY_BASE_URL: z.string().url(),
  JWT_ISSUER: z.string().url(),
  JWT_AUDIENCE: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  CONTROL_PLANE_PORT: portSchema.default(3000),
  RUNTIME_API_PORT: portSchema.default(3001),
  RUNTIME_WORKER_PORT: portSchema.default(3002),
  TOOL_GATEWAY_PORT: portSchema.default(3003),
});

export type AppName = z.infer<typeof appNameSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return runtimeConfigSchema.parse(env);
}

export function getAppPort(app: AppName, config: RuntimeConfig): number {
  switch (app) {
    case 'control-plane':
      return config.CONTROL_PLANE_PORT;
    case 'runtime-api':
      return config.RUNTIME_API_PORT;
    case 'runtime-worker':
      return config.RUNTIME_WORKER_PORT;
    case 'tool-gateway':
      return config.TOOL_GATEWAY_PORT;
    case 'mock-server':
      return 4100;
  }
}
