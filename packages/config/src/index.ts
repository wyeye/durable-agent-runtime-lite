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
const optionalStringSchema = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalPortSchema = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(1).max(65_535).optional(),
);
const portSchema = (defaultValue: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65_535).default(defaultValue));
const positiveIntSchema = (defaultValue: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(defaultValue));
const booleanEnvSchema = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === '') {
      return undefined;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === '') {
        return undefined;
      }
      if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
        return false;
      }
    }
    return value;
  }, z.boolean().default(defaultValue));

export const runtimeConfigSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  APP_ENV: stringSchema('local'),
  APP_VERSION: stringSchema('0.8.0'),
  BUILD_SHA: stringSchema('unknown'),
  BUILD_TIME: stringSchema('unknown'),
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
  MODEL_GATEWAY_MODEL: stringSchema('dar-local-model'),
  MODEL_GATEWAY_PROFILE_ID: stringSchema('local-dev'),
  MODEL_GATEWAY_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['disabled', 'mock', 'openai_compatible']).default('disabled'),
  ),
  MODEL_GATEWAY_PROTOCOL: z.preprocess(
    emptyToUndefined,
    z.enum(['dar_generate', 'openai_chat_completions']).default('dar_generate'),
  ),
  MODEL_GATEWAY_TIMEOUT_MS: positiveIntSchema(30_000),
  MODEL_GATEWAY_MAX_RETRIES: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(5).default(1),
  ),
  MODEL_GATEWAY_MAX_RESPONSE_BYTES: positiveIntSchema(1_000_000),
  MODEL_CALL_LEDGER_MAX_RESPONSE_BYTES: positiveIntSchema(1_048_576),
  MODEL_GATEWAY_ALLOW_INSECURE_HTTP: booleanEnvSchema(true),
  MODEL_GATEWAY_IDEMPOTENCY_HEADER: stringSchema('Idempotency-Key'),
  MODEL_GATEWAY_USER_AGENT: stringSchema('durable-agent-runtime-lite/runtime-worker'),
  PI_AGENT_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['disabled', 'deterministic', 'model_gateway']).default('disabled'),
  ),
  PI_CONTEXT_MAX_BYTES: positiveIntSchema(262_144),
  PI_SEGMENT_TIMEOUT_MS: positiveIntSchema(120_000),
  PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW: positiveIntSchema(20),
  TOOL_GATEWAY_BASE_URL: optionalUrlSchema,
  TOOL_GATEWAY_URL: optionalUrlSchema,
  RUNTIME_API_URL: optionalUrlSchema,
  RUNTIME_API_AUTH_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['header', 'disabled']).default('disabled'),
  ),
  JWT_ISSUER: urlSchema('http://localhost:3000'),
  JWT_AUDIENCE: stringSchema('durable-agent-runtime-lite'),
  DEFAULT_LOCALE: z.preprocess(emptyToUndefined, z.enum(['zh-CN']).default('zh-CN')),
  LOG_LOCALE: z.preprocess(emptyToUndefined, z.enum(['zh-CN']).default('zh-CN')),
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
  RUNTIME_API_ROUTE_SOURCE: z.preprocess(
    emptyToUndefined,
    z.enum(['db', 'memory']).default('memory'),
  ),
  TOOL_GATEWAY_REGISTRY_SOURCE: z.preprocess(
    emptyToUndefined,
    z.enum(['db', 'memory']).default('memory'),
  ),
  TOOL_GATEWAY_AUTH_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['service_token', 'disabled']).default('disabled'),
  ),
  TENANT_RUNTIME_POLICY_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['required', 'optional']).default('optional'),
  ),
  TENANT_POLICY_CACHE_TTL_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().nonnegative().default(5_000),
  ),
  TENANT_ADMISSION_RECONCILE_ENABLED: booleanEnvSchema(false),
  TENANT_ADMISSION_STALE_AFTER_MS: positiveIntSchema(300_000),
  TENANT_ADMISSION_MAX_RECONCILE_BATCH: positiveIntSchema(50),
  EVALUATION_WORKER_ENABLED: booleanEnvSchema(false),
  EVALUATION_TASK_QUEUE: stringSchema('evaluation-worker-main'),
  EVALUATION_MAX_CONCURRENT_RUNS: positiveIntSchema(1),
  EVALUATION_MAX_CONCURRENT_CASES: positiveIntSchema(2),
  EVALUATION_CASE_TIMEOUT_MS: positiveIntSchema(120_000),
  EVALUATION_GATE_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['disabled', 'advisory', 'required']).default('advisory'),
  ),
  EVALUATION_OUTPUT_MAX_BYTES: positiveIntSchema(1_000_000),
  EVALUATION_EVIDENCE_MAX_BYTES: positiveIntSchema(2_000_000),
  EVALUATION_REGEX_TIMEOUT_MS: positiveIntSchema(250),
  SEED_EVALUATION_DATASETS: booleanEnvSchema(false),
  TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED: booleanEnvSchema(false),
  TOOL_GATEWAY_RUNTIME_WORKER_TOKEN: optionalStringSchema,
  TOOL_GATEWAY_CONTROL_PLANE_TOKEN: optionalStringSchema,
  RUNTIME_WORKER_TOOL_GATEWAY_TOKEN: optionalStringSchema,
  CONTROL_PLANE_TOOL_GATEWAY_TOKEN: optionalStringSchema,
  CONTROL_PLANE_AUTH_MODE: z.preprocess(
    emptyToUndefined,
    z.enum(['header', 'disabled']).default('header'),
  ),
  CONTROL_PLANE_SWAGGER_ENABLED: booleanEnvSchema(true),
  CONTROL_PLANE_STATIC_ENABLED: booleanEnvSchema(false),
});

export type AppName = z.infer<typeof appNameSchema>;
type RuntimeConfigOutput = z.infer<typeof runtimeConfigSchema>;
export type RuntimeConfig = Omit<RuntimeConfigOutput, 'DEFAULT_LOCALE' | 'LOG_LOCALE'> &
  Partial<Pick<RuntimeConfigOutput, 'DEFAULT_LOCALE' | 'LOG_LOCALE'>>;

export interface BuildInfo {
  service: AppName;
  version: string;
  build_sha: string;
  build_time: string;
}

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

export function getRuntimeApiUrl(config: RuntimeConfig): string {
  return config.RUNTIME_API_URL ?? 'http://localhost:3001';
}

export function getBuildInfo(service: AppName, config: RuntimeConfig): BuildInfo {
  return {
    service,
    version: config.APP_VERSION,
    build_sha: config.BUILD_SHA,
    build_time: config.BUILD_TIME,
  };
}
