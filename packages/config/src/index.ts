import { z } from 'zod';

export const appNameSchema = z.enum([
  'control-plane',
  'runtime-api',
  'runtime-worker',
  'tool-gateway',
  'mock-server',
]);

function emptyToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

const stringSchema = (defaultValue: string) =>
  z.preprocess(emptyToUndefined, z.string().min(1).default(defaultValue));
const urlSchema = (defaultValue: string) =>
  z.preprocess(emptyToUndefined, z.string().url().default(defaultValue));
const optionalUrlSchema = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalPortSchema = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(1).max(65_535).optional(),
);
const portSchema = (defaultValue: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65_535).default(defaultValue));

export const runtimeConfigSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  APP_ENV: stringSchema('local'),
  APP_VERSION: stringSchema('0.1.5'),
  HOST: stringSchema('0.0.0.0'),
  PORT: optionalPortSchema,
  DATABASE_URL: urlSchema(
    'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
  ),
  VALKEY_URL: urlSchema('redis://localhost:16380'),
  TEMPORAL_ADDRESS: stringSchema('localhost:7233'),
  TEMPORAL_NAMESPACE: stringSchema('default'),
  MODEL_GATEWAY_BASE_URL: urlSchema('http://localhost:4100'),
  MODEL_GATEWAY_API_KEY: stringSchema('dev-only-placeholder'),
  TOOL_GATEWAY_BASE_URL: optionalUrlSchema,
  TOOL_GATEWAY_URL: optionalUrlSchema,
  RUNTIME_API_URL: optionalUrlSchema,
  JWT_ISSUER: urlSchema('http://localhost:3000'),
  JWT_AUDIENCE: stringSchema('durable-agent-runtime-lite'),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrlSchema,
  CONTROL_PLANE_PORT: portSchema(3000),
  RUNTIME_API_PORT: portSchema(3001),
  RUNTIME_WORKER_PORT: portSchema(3002),
  TOOL_GATEWAY_PORT: portSchema(3003),
  RUNTIME_WORKER_MODE: z.preprocess(emptyToUndefined, z.enum(['mock', 'temporal']).default('mock')),
  RUNTIME_API_WORKFLOW_STARTER: z.preprocess(
    emptyToUndefined,
    z.enum(['mock', 'temporal']).default('mock'),
  ),
  RUNTIME_API_ROUTE_SOURCE: z.preprocess(emptyToUndefined, z.enum(['db', 'memory']).default('memory')),
  TOOL_GATEWAY_REGISTRY_SOURCE: z.preprocess(emptyToUndefined, z.enum(['db', 'memory']).default('memory')),
});

export type AppName = z.infer<typeof appNameSchema>;
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return runtimeConfigSchema.parse(env);
}

export function getAppPort(app: AppName, config: RuntimeConfig): number {
  if (config.PORT) {
    return config.PORT;
  }

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

export function getToolGatewayUrl(config: RuntimeConfig): string {
  return config.TOOL_GATEWAY_BASE_URL ?? config.TOOL_GATEWAY_URL ?? 'http://localhost:3003';
}
