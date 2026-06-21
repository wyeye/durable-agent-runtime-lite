import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUDIT_MESSAGE_KEYS,
  ERROR_MESSAGE_KEYS,
  LOG_MESSAGE_KEYS,
  zhCNResources,
  translate,
} from '../packages/i18n/src/index.js';

const root = new URL('..', import.meta.url);
const allowWords = new Set([
  'API',
  'HTTP',
  'JSON',
  'ID',
  'URL',
  'SQL',
  'Hash',
  'Prompt',
  'Agent',
  'Tool',
  'Flow',
  'Route',
  'Model',
  'Provider',
  'Temporal',
  'Pi',
  'Ollama',
  'Durable Agent Runtime Lite',
]);

const requiredErrorCodes = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL_ERROR',
  'DEPENDENCY_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'RESOURCE_NOT_FOUND',
  'REVISION_CONFLICT',
  'RESOURCE_IMMUTABLE',
  'VALIDATION_NOT_PASSED',
  'RELEASE_BLOCKED',
  'WORKFLOW_START_FAILED',
  'WORKFLOW_NOT_FOUND',
  'TASK_RUN_NOT_FOUND',
  'AGENT_RUN_NOT_FOUND',
  'HUMAN_TASK_NOT_FOUND',
  'HUMAN_TASK_ALREADY_DECIDED',
  'TENANT_RUNTIME_POLICY_NOT_FOUND',
  'TENANT_AGENT_CONCURRENCY_EXCEEDED',
  'TENANT_POLICY_HASH_MISMATCH',
  'TENANT_POLICY_SNAPSHOT_NOT_FOUND',
  'TOOL_NOT_FOUND',
  'TOOL_DENIED',
  'TOOL_DENIED_BY_TENANT_POLICY',
  'TOOL_HASH_MISMATCH',
  'TOOL_RISK_MISMATCH',
  'TOOL_ARGUMENT_VALIDATION_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'MODEL_GATEWAY_UNAVAILABLE',
  'MODEL_GATEWAY_TIMEOUT',
  'MODEL_RESPONSE_INVALID',
  'MODEL_DENIED_BY_TENANT_POLICY',
  'MODEL_REQUEST_IDEMPOTENCY_CONFLICT',
  'EVALUATION_GATE_REQUIRED',
  'EVALUATION_GATE_NOT_FOUND',
  'EVALUATION_GATE_FAILED',
  'EVALUATION_GATE_STALE',
  'EVALUATION_SUBJECT_HASH_MISMATCH',
  'EVALUATION_DATASET_MISMATCH',
  'EVALUATION_GATE_POLICY_MISMATCH',
  'EVALUATION_OVERRIDE_NOT_ALLOWED',
  'EVALUATION_EVIDENCE_INCOMPLETE',
  'EVALUATION_EVIDENCE_SIZE_LIMIT_EXCEEDED',
  'EVALUATION_CANDIDATE_FIDELITY_MISMATCH',
];

async function main(): Promise<void> {
  const failures: string[] = [];
  const flattened = flatten(zhCNResources);

  if (Object.keys(flattened).length === 0) {
    failures.push('zh-CN resources must not be empty');
  }

  for (const [key, value] of Object.entries(flattened)) {
    if (!value.trim()) {
      failures.push(`empty zh-CN translation: ${key}`);
    }
    if (key.includes(' ')) {
      failures.push(`translation key must be semantic path, not sentence: ${key}`);
    }
  }

  for (const code of requiredErrorCodes) {
    if (!(code in ERROR_MESSAGE_KEYS)) {
      failures.push(`missing error translation key for ${code}`);
      continue;
    }
    const key = ERROR_MESSAGE_KEYS[code as keyof typeof ERROR_MESSAGE_KEYS];
    if (!flattened[key]) {
      failures.push(`error ${code} references missing key ${key}`);
    }
  }

  const sourceFiles = await Promise.all([
    listFiles(new URL('../apps', import.meta.url).pathname),
    listFiles(new URL('../packages', import.meta.url).pathname),
  ]);
  const runtimeErrorCodes = await collectRuntimeErrorCodes(sourceFiles.flat());
  for (const code of runtimeErrorCodes) {
    if (!(code in ERROR_MESSAGE_KEYS)) {
      failures.push(`runtime error code ${code} has no ERROR_MESSAGE_KEYS mapping`);
      continue;
    }
    const key = ERROR_MESSAGE_KEYS[code as keyof typeof ERROR_MESSAGE_KEYS];
    if (!flattened[key]) {
      failures.push(`runtime error code ${code} references missing key ${key}`);
    }
  }

  for (const [eventCode, key] of Object.entries(LOG_MESSAGE_KEYS)) {
    if (!flattened[key]) {
      failures.push(`log event ${eventCode} references missing key ${key}`);
    }
  }

  for (const [eventType, key] of Object.entries(AUDIT_MESSAGE_KEYS)) {
    if (!flattened[key]) {
      failures.push(`audit event ${eventType} references missing key ${key}`);
    }
  }

  for (const key of Object.values(ERROR_MESSAGE_KEYS)) {
    if (translate(key) === key) {
      failures.push(`missing runtime translation for ${key}`);
    }
  }

  const webFiles = await listFiles(new URL('../apps/control-plane/src/web', import.meta.url).pathname);
  for (const file of webFiles.filter((path) => /\.(tsx?|jsx?)$/u.test(path))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?<![A-Za-z])(?:Dashboard|Registry|Release Center|Human Tasks|TaskRuns|AgentRuns|Audit|ToolCalls|Policy Snapshots|Tenant Admissions)(?![A-Za-z])/gu)) {
      failures.push(`visible English UI label "${match[0]}" in ${relative(file)}`);
    }
    for (const match of source.matchAll(/>([A-Z][A-Za-z]+(?:\s+[A-Za-z]+){2,})</gu)) {
      const phrase = match[1] ?? '';
      if (!isAllowedPhrase(phrase)) {
        failures.push(`visible English sentence "${phrase}" in ${relative(file)}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(failures.map((failure) => `- ${failure}`).join('\n'));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    locale: 'zh-CN',
    translation_keys: Object.keys(flattened).length,
    error_codes: requiredErrorCodes.length,
    log_events: Object.keys(LOG_MESSAGE_KEYS).length,
    audit_events: Object.keys(AUDIT_MESSAGE_KEYS).length,
  }, null, 2));
}

function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') {
    return { [prefix]: value };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value).reduce<Record<string, string>>((acc, [key, nested]) => ({
    ...acc,
    ...flatten(nested, prefix ? `${prefix}.${key}` : key),
  }), {});
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return children.flat();
}

async function collectRuntimeErrorCodes(files: string[]): Promise<string[]> {
  const codes = new Set<string>();
  const codePattern =
    /(?:code|error_code)\s*[:=]\s*['"]([A-Z][A-Z0-9_]{2,})['"]|new\s+(?:ControlPlaneHttpError|EvaluationRepositoryError|EvaluationGateError|TenantRuntimePolicyError|AuthError|ServiceAuthError|ModelGatewayError)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/gu;
  for (const file of files.filter((path) => /\.(tsx?|jsx?)$/u.test(path) && !path.includes('/test'))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(codePattern)) {
      codes.add(match[1] ?? match[2] ?? '');
    }
  }
  return [...codes].filter(Boolean).sort();
}

function relative(file: string): string {
  return file.replace(root.pathname, '');
}

function isAllowedPhrase(phrase: string): boolean {
  return allowWords.has(phrase) || /^[A-Z][A-Za-z]+$/u.test(phrase);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
