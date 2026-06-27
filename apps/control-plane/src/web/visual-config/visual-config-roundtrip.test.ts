import { describe, expect, it } from 'vitest';
import type {
  AgentSpec,
  EvaluationCase,
  EvaluationDataset,
  EvaluationGatePolicy,
  FlowSpec,
  ModelPolicy,
  PromptDefinition,
  RouteSpec,
  TenantRuntimePolicy,
  ToolManifest,
} from '@dar/contracts';
import {
  evaluationCaseSchema,
  evaluationDatasetSchema,
  evaluationGatePolicySchema,
} from '@dar/contracts';
import { canonicalize, stripServerManagedFields } from './canonicalize.js';
import {
  createDefaultEvaluationCase,
  evaluationCaseAdapter,
  evaluationDatasetAdapter,
  evaluationGatePolicyAdapter,
  registryVisualAdapters,
} from './registry.js';

describe('visual config adapter round-trip', () => {
  it.each([
    ['flow', flowFixture()],
    ['route', routeFixture()],
    ['tool', toolFixture()],
    ['tool', httpReadonlyToolFixture()],
    ['agent', agentFixture()],
    ['model_policy', modelPolicyFixture()],
    ['prompt', promptFixture()],
    ['tenant_runtime_policy', tenantRuntimePolicyFixture()],
  ] as const)('round-trips registry %s without dropping contract fields', (resourceType, fixture) => {
    const adapter = registryVisualAdapters[resourceType];
    const parsed = adapter.schema.parse(fixture);
    const roundTrip = adapter.schema.parse(adapter.formToSpec(adapter.specToForm(parsed)));
    expect(canonicalize(stripServerManagedFields(roundTrip))).toEqual(canonicalize(stripServerManagedFields(parsed)));
  });

  it('round-trips evaluationDataset', () => {
    const fixture: EvaluationDataset = evaluationDatasetSchema.parse({
      ...evaluationDatasetAdapter.createDefault(),
      dataset_id: 'dataset_roundtrip',
      dataset_hash: 'a'.repeat(64),
      created_at: new Date(0).toISOString(),
    });
    const roundTrip = evaluationDatasetAdapter.schema.parse(evaluationDatasetAdapter.formToSpec(evaluationDatasetAdapter.specToForm(fixture)));
    expect(canonicalize(stripServerManagedFields(roundTrip))).toEqual(canonicalize(stripServerManagedFields(fixture)));
  });

  it('round-trips evaluationCase', () => {
    const fixture: EvaluationCase = evaluationCaseSchema.parse({
      ...createDefaultEvaluationCase('dataset_roundtrip', 1),
      expected_tool_calls: [{
        tool_name: 'tool.name',
        min_calls: 1,
        max_calls: 2,
        argument_match_mode: 'subset',
        expected_arguments: { query: 'hello' },
        expected_argument_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
      final_assertions: [{ type: 'contains', value: 'hello' }],
      policy_assertions: [{ type: 'non_empty' }],
      latency_budget_ms: 1000,
    });
    const roundTrip = evaluationCaseAdapter.schema.parse(evaluationCaseAdapter.formToSpec(evaluationCaseAdapter.specToForm(fixture)));
    expect(canonicalize(stripServerManagedFields(roundTrip))).toEqual(canonicalize(stripServerManagedFields(fixture)));
  });

  it('round-trips evaluationGatePolicy', () => {
    const fixture: EvaluationGatePolicy = evaluationGatePolicySchema.parse({
      ...evaluationGatePolicyAdapter.createDefault(),
      gate_policy_id: 'gate_roundtrip',
      required_dataset_refs: [{ dataset_id: 'dataset_roundtrip', version: 1, dataset_hash: 'b'.repeat(64) }],
      gate_policy_hash: 'c'.repeat(64),
      created_at: new Date(0).toISOString(),
    });
    const roundTrip = evaluationGatePolicyAdapter.schema.parse(evaluationGatePolicyAdapter.formToSpec(evaluationGatePolicyAdapter.specToForm(fixture)));
    expect(canonicalize(stripServerManagedFields(roundTrip))).toEqual(canonicalize(stripServerManagedFields(fixture)));
  });
});

function flowFixture(): FlowSpec {
  return {
    flow_id: 'flow_roundtrip',
    version: 1,
    name: 'Roundtrip Flow',
    description: 'visual form fixture',
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], oneOf: [{ type: 'object' }] },
    output_schema: { type: 'object', additionalProperties: true },
    steps: [
      { id: 'normalize', type: 'activity', activity: 'input.normalize', input: { text: '${text}' }, output_ref: 'normalized' },
      { id: 'call_tool', type: 'tool', tool: 'tool.roundtrip', tool_version: '1.0.0', mode: 'preview', risk_level: 'L1', input: { query: '${normalized.text}' }, on_failure: { target: 'fallback' } },
      { id: 'agent', type: 'agent', agent_id: 'agent_roundtrip', input: { agent_version: 1 } },
      { id: 'condition', type: 'condition', when: 'target:agent' },
    ],
    metadata: { owner: 'platform', nested: { keep: true } },
  };
}

function routeFixture(): RouteSpec {
  return {
    route_id: 'route_roundtrip',
    flow_id: 'flow_roundtrip',
    version: 1,
    route: {
      priority: 80,
      keywords: ['roundtrip'],
      examples: ['run roundtrip'],
      negative_examples: ['ignore'],
      supported_channels: ['api'],
      tenant_constraints: [],
      role_constraints: ['operator'],
      confidence_threshold: 0.8,
      ambiguous_threshold: 0.4,
      fallback_agent_ref: 'agent_roundtrip@1',
    },
  };
}

function toolFixture(): ToolManifest {
  return {
    tool_name: 'tool.roundtrip',
    version: '1.0.0',
    description: 'Roundtrip tool',
    risk_level: 'L2',
    side_effect: false,
    adapter: { type: 'mock', endpoint_ref: 'mock/roundtrip', config: { mode: 'safe' } },
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], $ref: '#/advanced' },
    output_schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    required_permissions: ['tool:invoke'],
    evaluation_policy: {
      allowed_in_evaluation: true,
      mode: 'preview_only',
      allowed_tenants: ['default'],
      result_redaction_policy: 'mask_sensitive',
      maximum_calls_per_case: 1,
    },
  };
}

function httpReadonlyToolFixture(): ToolManifest {
  return {
    tool_name: 'company.policy.lookup',
    version: '1.0.0',
    description: 'HTTP readonly roundtrip tool',
    risk_level: 'L1',
    side_effect: false,
    adapter: {
      type: 'http_readonly',
      base_url: 'https://policy.example.com',
      path: '/business-api/v1/policies',
      query_mapping: { keyword: 'keyword' },
      static_query: { locale: 'zh-CN' },
      auth: { type: 'bearer_env', secret_ref: 'env:TOOL_SECRET_BUSINESS_API' },
      timeout_ms: 5000,
      max_response_bytes: 65536,
      retry: { max_attempts: 2, retryable_status_codes: [429, 503], backoff_ms: 100 },
      response_body_path: 'data',
      response_headers_allowlist: ['X-API-Key'],
    },
    input_schema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
    output_schema: { type: 'object', properties: { items: { type: 'array' } }, required: ['items'] },
    required_permissions: ['tool:invoke'],
    evaluation_policy: {
      allowed_in_evaluation: true,
      mode: 'preview_only',
      allowed_tenants: ['default'],
      result_redaction_policy: 'mask_sensitive',
      maximum_calls_per_case: 1,
    },
  };
}

function agentFixture(): AgentSpec {
  return {
    agent_id: 'agent_roundtrip',
    version: 1,
    prompt_ref: 'prompt_roundtrip@1',
    model_policy: 'model_policy_roundtrip@1',
    model_policy_ref: {
      model_policy_id: 'model_policy_roundtrip',
      model_policy_version: 1,
      model_policy_hash: 'd'.repeat(64),
    },
    allowed_tools: ['tool.roundtrip@1.0.0'],
    allowed_handoffs: ['flow_roundtrip@1'],
    max_steps: 6,
    max_tokens: 12000,
    output_schema: 'agent_output_v1',
  };
}

function modelPolicyFixture(): ModelPolicy {
  return {
    model_policy_id: 'model_policy_roundtrip',
    version: 1,
    status: 'draft',
    protocol: 'openai_chat_completions',
    targets: [{
      target_id: 'primary',
      model_ref: {
        model_id: 'model-safe',
        version: 1,
        model_hash: 'a'.repeat(64),
      },
      priority: 0,
      enabled: true,
      timeout_ms: 1000,
      max_retries: 1,
    }],
    retry_policy: { max_attempts_per_target: 2, retryable_status_codes: [429, 500], retry_on_timeout: true, retry_on_network_error: true, backoff_ms: 10, max_backoff_ms: 100 },
    fallback_policy: { enabled: true, ordered_target_ids: ['primary'], eligible_error_classes: ['timeout'], stop_on_auth_error: true, stop_on_validation_error: true, stop_on_policy_denial: true },
    request_policy: { temperature: 0.2, top_p: 1, max_output_tokens: 1000, initial_tool_choice_mode: 'auto', after_tool_result_tool_choice_mode: 'none', response_format: 'text', allow_parallel_tool_calls: false },
    revision: 1,
  };
}

function promptFixture(): PromptDefinition {
  return {
    prompt_id: 'prompt_roundtrip',
    version: 1,
    name: 'Roundtrip Prompt',
    content: 'Hello {{name}}',
    variables: ['name'],
  };
}

function tenantRuntimePolicyFixture(): TenantRuntimePolicy {
  return {
    tenant_id: 'tenant_roundtrip',
    version: 1,
    status: 'draft',
    allowed_tools: [{ tool_name: 'tool.roundtrip', versions: ['1.0.0'], allowed_operations: ['invoke'], max_risk_level: 'L2' }],
    denied_tools: [{ tool_name: 'tool.denied', allowed_operations: ['invoke'], reason_code: 'blocked' }],
    allowed_models: [{ model_id: 'model-safe', provider: 'mock' }],
    denied_models: [{ model_id: 'model-denied', reason_code: 'blocked' }],
    allowed_handoffs: [{ flow_id: 'flow_roundtrip', versions: [1] }],
    denied_handoffs: [{ flow_id: 'flow_denied', reason_code: 'blocked' }],
    budget_cap: { max_segments: 8, max_model_turns: 16, max_tool_calls: 4, max_handoffs: 1, max_input_tokens: 100, max_output_tokens: 200, max_total_tokens: 300, max_duration_ms: 1000, max_context_bytes: 4096, max_cost: 1 },
    max_concurrent_agent_runs: 2,
    revision: 1,
  };
}
