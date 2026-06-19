import { z } from 'zod';

export const toolRiskLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export const riskLevelSchema = toolRiskLevelSchema;
export const toolInvokeModeSchema = z.enum(['preview', 'commit']);
export const toolPolicyDecisionSchema = z.enum(['allow', 'deny', 'require_human_confirm']);
export const tenantRuntimePolicyStatusSchema = z.enum([
  'draft',
  'validated',
  'published',
  'deprecated',
  'disabled',
]);
export const tenantPolicyOperationSchema = z.enum(['invoke', 'preview', 'commit']);
export const tenantPolicyDecisionValueSchema = z.enum(['allow', 'deny']);
export const tenantAdmissionStatusSchema = z.enum([
  'reserved',
  'active',
  'released',
  'rejected',
  'orphaned',
  'reconciled',
]);
export const tenantPolicySnapshotDerivationTypeSchema = z.enum([
  'root',
  'flow_agent_child',
  'workflow_handoff',
  'nested_handoff',
]);
export const specStatusSchema = z.enum([
  'draft',
  'validated',
  'published',
  'gray',
  'deprecated',
  'disabled',
]);
export const specStatusTransitionSchema = z.object({
  from: specStatusSchema,
  to: specStatusSchema,
});
export const registryResourceTypeSchema = z.enum(['flow', 'route', 'tool', 'agent', 'prompt', 'tenant_runtime_policy', 'model_policy']);
export const capabilityReleaseActionSchema = z.enum(['publish', 'gray', 'rollback', 'disable', 'deprecate']);
export const modelPolicyStatusSchema = specStatusSchema;
export const modelGatewayProtocolSchema = z.enum(['dar_generate', 'openai_chat_completions']);
export const modelCapabilitySchema = z.enum(['text', 'tools', 'json_schema', 'streaming', 'usage', 'tool_choice']);
export const modelToolChoiceModeSchema = z.enum(['auto', 'none', 'required']);
export const modelResponseFormatSchema = z.enum(['text', 'json_object', 'json_schema']);
export const modelCallStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'replayed',
]);
export const modelCallAttemptStatusSchema = z.enum(['started', 'succeeded', 'failed', 'skipped']);
export const flowStepTypeSchema = z.enum(['activity', 'tool', 'agent', 'human_task', 'condition']);
export const piResultStatusSchema = z.enum([
  'final',
  'need_tool',
  'need_user',
  'handoff_to_workflow',
  'failed',
]);
export const agentExecutionModeSchema = z.enum(['answer_only', 'plan_only', 'mediated_tool_call']);
export const agentRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_tool',
  'waiting_human',
  'waiting_user',
  'handing_off',
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
]);
export const agentStepStatusSchema = z.enum([
  'segment_created',
  'waiting_tool',
  'waiting_human',
  'waiting_user',
  'tool_resolved',
  'handoff_started',
  'handoff_completed',
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
]);
export const piSegmentStatusSchema = z.enum([
  'completed',
  'tool_requested',
  'user_input_required',
  'handoff_requested',
  'stopped_by_budget',
  'failed',
  'cancelled',
]);

export const jsonObjectSchema = z.record(z.string(), z.unknown());
const decisionSummarySchema = z.string().max(2000);

export const grayPolicySchema = z.object({
  tenant_allowlist: z.array(z.string()).default([]),
  user_allowlist: z.array(z.string()).default([]),
});

export const registryValidationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  path: z.string().optional(),
  severity: z.enum(['error', 'warning']),
});

export const registryDependencyNodeSchema = z.object({
  resource_type: registryResourceTypeSchema,
  resource_id: z.string().min(1),
  version: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  status: specStatusSchema.optional(),
});

export const registryDependencyEdgeSchema = z.object({
  from: registryDependencyNodeSchema,
  to: registryDependencyNodeSchema,
  relation: z.string().min(1),
});

export const registryValidationResultSchema = z.object({
  valid: z.boolean(),
  can_publish: z.boolean(),
  errors: z.array(registryValidationIssueSchema),
  warnings: z.array(registryValidationIssueSchema),
  dependency_graph: z.object({
    nodes: z.array(registryDependencyNodeSchema),
    edges: z.array(registryDependencyEdgeSchema),
  }),
});

export const runtimeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: jsonObjectSchema.optional(),
});

export const tenantPolicyToolRuleSchema = z.object({
  tool_name: z.string().min(1),
  versions: z.array(z.string().min(1)).optional(),
  allowed_operations: z.array(tenantPolicyOperationSchema).min(1),
  max_risk_level: toolRiskLevelSchema.optional(),
  reason_code: z.string().min(1).optional(),
});

export const tenantPolicyModelRuleSchema = z.object({
  model_id: z.string().min(1),
  provider: z.string().min(1).optional(),
  reason_code: z.string().min(1).optional(),
});

export const tenantPolicyHandoffRuleSchema = z.object({
  flow_id: z.string().min(1),
  versions: z.array(z.number().int().positive()).optional(),
  execution_plan_refs: z.array(z.string().min(1)).optional(),
  reason_code: z.string().min(1).optional(),
});

export const tenantRuntimeBudgetCapSchema = z.object({
  max_segments: z.number().int().positive().optional(),
  max_model_turns: z.number().int().positive().optional(),
  max_tool_calls: z.number().int().nonnegative().optional(),
  max_handoffs: z.number().int().nonnegative().optional(),
  max_input_tokens: z.number().int().nonnegative().optional(),
  max_output_tokens: z.number().int().nonnegative().optional(),
  max_total_tokens: z.number().int().positive().optional(),
  max_duration_ms: z.number().int().positive().optional(),
  max_context_bytes: z.number().int().positive().optional(),
  max_cost: z.number().nonnegative().optional(),
});

export const tenantRuntimePolicySchema = z.object({
  tenant_id: z.string().min(1),
  version: z.number().int().positive(),
  status: tenantRuntimePolicyStatusSchema,
  allowed_tools: z.array(tenantPolicyToolRuleSchema).default([]),
  denied_tools: z.array(tenantPolicyToolRuleSchema).default([]),
  allowed_models: z.array(tenantPolicyModelRuleSchema).default([]),
  denied_models: z.array(tenantPolicyModelRuleSchema).default([]),
  allowed_handoffs: z.array(tenantPolicyHandoffRuleSchema).default([]),
  denied_handoffs: z.array(tenantPolicyHandoffRuleSchema).default([]),
  budget_cap: tenantRuntimeBudgetCapSchema.default({}),
  max_concurrent_agent_runs: z.number().int().positive(),
  revision: z.number().int().positive().default(1),
  created_by: z.string().min(1).optional(),
  updated_by: z.string().min(1).optional(),
  published_by: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  published_at: z.string().datetime().optional(),
});

export const tenantRuntimePolicySnapshotSchema = z.object({
  snapshot_id: z.string().min(1),
  snapshot_ref: z.string().min(1),
  tenant_id: z.string().min(1),
  root_snapshot_ref: z.string().min(1),
  parent_snapshot_ref: z.string().min(1).optional(),
  derivation_type: tenantPolicySnapshotDerivationTypeSchema,
  lineage_depth: z.number().int().nonnegative(),
  source_policy_version: z.number().int().positive(),
  source_policy_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  execution_plan_ref: z.string().min(1),
  execution_plan_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  execution_plan_type: z.enum(['flow', 'agent']),
  resolved_allowed_tools: z.array(tenantPolicyToolRuleSchema).default([]),
  resolved_denied_tools: z.array(tenantPolicyToolRuleSchema).default([]),
  resolved_allowed_models: z.array(tenantPolicyModelRuleSchema).default([]),
  resolved_allowed_handoffs: z.array(tenantPolicyHandoffRuleSchema).default([]),
  resolved_budget: z.lazy(() => agentBudgetSchema),
  max_concurrent_agent_runs: z.number().int().positive(),
  snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  created_at: z.string().datetime(),
});

export const tenantPolicyDecisionSchema = z.object({
  decision: tenantPolicyDecisionValueSchema,
  reason_code: z.string().min(1),
  reason_summary: z.string().min(1),
  snapshot_ref: z.string().min(1).optional(),
  snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  matched_rules: z.array(jsonObjectSchema).default([]),
  effective_budget: z.lazy(() => agentBudgetSchema).optional(),
  effective_allowed_tools: z.array(tenantPolicyToolRuleSchema).default([]),
  effective_allowed_models: z.array(tenantPolicyModelRuleSchema).default([]),
  effective_allowed_handoffs: z.array(tenantPolicyHandoffRuleSchema).default([]),
});

export const tenantAgentAdmissionSchema = z.object({
  admission_id: z.string().min(1),
  tenant_id: z.string().min(1),
  task_run_id: z.string().min(1),
  agent_run_id: z.string().min(1).optional(),
  workflow_id: z.string().min(1).optional(),
  workflow_run_id: z.string().min(1).optional(),
  policy_snapshot_ref: z.string().min(1),
  status: tenantAdmissionStatusSchema,
  acquired_at: z.string().datetime(),
  activated_at: z.string().datetime().optional(),
  released_at: z.string().datetime().optional(),
  updated_at: z.string().datetime(),
  release_reason: z.string().min(1).optional(),
  revision: z.number().int().positive().default(1),
});

const safeModelStringSchema = z.string().min(1).refine((value) => {
  if (/api[_-]?key|authorization|bearer\s+|secret|password|token|cookie/iu.test(value)) {
    return false;
  }
  return !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}, 'Model policy fields must not contain credentials or gateway URLs');

export const modelTargetSchema = z.object({
  target_id: safeModelStringSchema,
  gateway_profile: safeModelStringSchema,
  provider_hint: safeModelStringSchema.optional(),
  model_id: safeModelStringSchema,
  priority: z.number().int().nonnegative(),
  enabled: z.boolean().default(true),
  capabilities: z.array(modelCapabilitySchema).min(1),
  timeout_ms: z.number().int().positive().optional(),
  max_retries: z.number().int().nonnegative().max(10).optional(),
  input_cost_per_million: z.number().nonnegative().optional(),
  output_cost_per_million: z.number().nonnegative().optional(),
});

export const modelRetryPolicySchema = z.object({
  max_attempts_per_target: z.number().int().positive().max(10).default(2),
  retryable_status_codes: z.array(z.number().int().min(100).max(599)).default([408, 429, 500, 502, 503, 504]),
  retry_on_timeout: z.boolean().default(true),
  retry_on_network_error: z.boolean().default(true),
  backoff_ms: z.number().int().nonnegative().default(250),
  max_backoff_ms: z.number().int().nonnegative().default(2_000),
});

export const modelFallbackPolicySchema = z.object({
  enabled: z.boolean().default(false),
  ordered_target_ids: z.array(z.string().min(1)).default([]),
  eligible_error_classes: z.array(z.string().min(1)).default(['rate_limit', 'timeout', 'network', 'upstream_5xx']),
  stop_on_auth_error: z.boolean().default(true),
  stop_on_validation_error: z.boolean().default(true),
  stop_on_policy_denial: z.boolean().default(true),
});

export const modelRequestPolicySchema = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  top_p: z.number().min(0).max(1).default(1),
  max_output_tokens: z.number().int().positive().default(1000),
  tool_choice_mode: modelToolChoiceModeSchema.default('auto'),
  response_format: modelResponseFormatSchema.default('text'),
  allow_parallel_tool_calls: z.boolean().default(false),
});

export const modelPolicySchema = z.object({
  model_policy_id: z.string().min(1),
  version: z.number().int().positive(),
  status: modelPolicyStatusSchema,
  protocol: modelGatewayProtocolSchema,
  targets: z.array(modelTargetSchema).min(1),
  retry_policy: modelRetryPolicySchema.default(() => modelRetryPolicySchema.parse({})),
  fallback_policy: modelFallbackPolicySchema.default(() => modelFallbackPolicySchema.parse({})),
  request_policy: modelRequestPolicySchema.default(() => modelRequestPolicySchema.parse({})),
  revision: z.number().int().positive().default(1),
  created_by: z.string().min(1).optional(),
  updated_by: z.string().min(1).optional(),
  published_by: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  published_at: z.string().datetime().optional(),
});

export const resolvedModelPolicySchema = z.object({
  model_policy_id: z.string().min(1),
  model_policy_version: z.number().int().positive(),
  model_policy_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  protocol: modelGatewayProtocolSchema,
  resolved_targets: z.array(modelTargetSchema).min(1),
  retry_policy: modelRetryPolicySchema,
  fallback_policy: modelFallbackPolicySchema,
  request_policy: modelRequestPolicySchema,
});

export const modelPolicyRefSchema = z.object({
  model_policy_id: z.string().min(1),
  model_policy_version: z.number().int().positive(),
  model_policy_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});

export const modelUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
  estimated_input_cost: z.number().nonnegative().optional(),
  estimated_output_cost: z.number().nonnegative().optional(),
  estimated_total_cost: z.number().nonnegative().optional(),
  currency: z.string().min(1).optional(),
});

export const modelGatewayContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: jsonObjectSchema.default({}),
  }),
]);

export const modelGatewayMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(modelGatewayContentBlockSchema)]).default(''),
  tool_call_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

export const modelGatewayToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: jsonObjectSchema.default({}),
});

export const modelGatewayRequestSchema = z.object({
  model_request_key: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(modelGatewayMessageSchema),
  tools: z.array(modelGatewayToolDefinitionSchema).default([]),
  tool_choice: modelToolChoiceModeSchema.default('auto'),
  response_format: modelResponseFormatSchema.default('text'),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  parallel_tool_calls: z.boolean().optional(),
  request_id: z.string().optional(),
  task_run_id: z.string().optional(),
  agent_run_id: z.string().optional(),
});

export const modelGatewayResponseSchema = z.object({
  response_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  message: z.object({
    role: z.literal('assistant'),
    content: z.array(modelGatewayContentBlockSchema).default([]),
  }),
  finish_reason: z.enum(['stop', 'tool_call', 'length', 'error']).default('stop'),
  usage: modelUsageSchema.optional(),
});

export const modelCallRecordSchema = z.object({
  model_call_id: z.string().min(1),
  model_request_key: z.string().min(1),
  tenant_id: z.string().min(1),
  user_id: z.string().min(1).optional(),
  task_run_id: z.string().min(1).optional(),
  workflow_id: z.string().min(1).optional(),
  workflow_run_id: z.string().min(1).optional(),
  agent_run_id: z.string().min(1).optional(),
  segment_index: z.number().int().nonnegative().optional(),
  model_turn_index: z.number().int().nonnegative().optional(),
  model_policy_id: z.string().min(1),
  model_policy_version: z.number().int().positive(),
  model_policy_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  target_id: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
  protocol: modelGatewayProtocolSchema,
  attempt_count: z.number().int().nonnegative().default(0),
  fallback_index: z.number().int().nonnegative().default(0),
  status: modelCallStatusSchema,
  finish_reason: z.string().optional(),
  response_id: z.string().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  estimated_cost: z.number().nonnegative().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  error_class: z.string().optional(),
  error_code: z.string().optional(),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  response_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  safe_response_json: jsonObjectSchema.optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const modelCallAttemptSchema = z.object({
  attempt_id: z.string().min(1),
  model_call_id: z.string().min(1),
  attempt_index: z.number().int().nonnegative(),
  target_id: z.string().min(1),
  provider: z.string().min(1).optional(),
  model_id: z.string().min(1),
  status: modelCallAttemptStatusSchema,
  http_status: z.number().int().min(100).max(599).optional(),
  error_class: z.string().optional(),
  error_code: z.string().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  response_id: z.string().optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
});

export const tenantPolicyCreateDraftRequestSchema = z.object({
  policy: tenantRuntimePolicySchema.omit({
    revision: true,
    created_at: true,
    updated_at: true,
    published_at: true,
  }).extend({
    status: z.literal('draft').default('draft'),
  }),
});

export const tenantPolicyUpdateDraftRequestSchema = z.object({
  policy: tenantRuntimePolicySchema.partial().omit({
    tenant_id: true,
    version: true,
    revision: true,
    created_at: true,
    updated_at: true,
    published_at: true,
  }),
  expected_revision: z.number().int().positive(),
});

export const tenantPolicyValidateResponseSchema = z.object({
  validation: registryValidationResultSchema,
});

export const tenantPolicyPublishRequestSchema = z.object({
  release_note: z.string().min(1),
  expected_revision: z.number().int().positive().optional(),
  metadata_json: jsonObjectSchema.default({}),
});

export const tenantPolicyRollbackRequestSchema = z.object({
  target_version: z.number().int().positive(),
  release_note: z.string().min(1),
  metadata_json: jsonObjectSchema.default({}),
});

export const tenantAdmissionResultSchema = z.object({
  admission: tenantAgentAdmissionSchema,
  accepted: z.boolean(),
  reason_code: z.string().min(1).optional(),
  active_count: z.number().int().nonnegative(),
  max_concurrent_agent_runs: z.number().int().positive(),
});

export const paginationRequestSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
  sort_by: z.string().min(1).optional(),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

export const tenantPolicyQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  status: tenantRuntimePolicyStatusSchema.optional(),
});

export const tenantPolicySnapshotQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  execution_plan_ref: z.string().min(1).optional(),
  source_policy_version: z.coerce.number().int().positive().optional(),
  derivation_type: tenantPolicySnapshotDerivationTypeSchema.optional(),
  root_snapshot_ref: z.string().min(1).optional(),
  parent_snapshot_ref: z.string().min(1).optional(),
  created_from: z.string().datetime().optional(),
  created_to: z.string().datetime().optional(),
});

export const tenantAgentAdmissionQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  status: tenantAdmissionStatusSchema.optional(),
  task_run_id: z.string().min(1).optional(),
  agent_run_id: z.string().min(1).optional(),
  workflow_id: z.string().min(1).optional(),
  acquired_from: z.string().datetime().optional(),
  acquired_to: z.string().datetime().optional(),
});

export const paginatedResponseSchema = <TItem extends z.ZodType>(itemSchema: TItem) =>
  z.object({
    items: z.array(itemSchema),
    page: z.number().int().positive(),
    page_size: z.number().int().positive(),
    total: z.number().int().nonnegative().optional(),
    next_cursor: z.string().optional(),
  });

export const registryListRequestSchema = paginationRequestSchema.extend({
  status: specStatusSchema.optional(),
  resource_id: z.string().min(1).optional(),
  keyword: z.string().min(1).optional(),
  created_by: z.string().min(1).optional(),
  updated_by: z.string().min(1).optional(),
});

export const createDraftRequestSchema = z.object({
  spec: z.unknown(),
});

export const updateDraftRequestSchema = z.object({
  spec: z.unknown(),
  expected_revision: z.number().int().positive(),
});

export const cloneVersionRequestSchema = z.object({
  version: z.number().int().positive().optional(),
});

export const validateResourceRequestSchema = z.object({
  include_warnings: z.boolean().default(true),
});

export const publishResourceRequestSchema = z.object({
  release_note: z.string().min(1),
  metadata_json: jsonObjectSchema.default({}),
});

export const grayResourceRequestSchema = publishResourceRequestSchema.extend({
  tenant_allowlist: z.array(z.string().min(1)).default([]),
  user_allowlist: z.array(z.string().min(1)).default([]),
});

export const rollbackResourceRequestSchema = z.object({
  target_version: z.number().int().positive(),
  release_note: z.string().min(1),
  metadata_json: jsonObjectSchema.default({}),
});

export const deprecateResourceRequestSchema = publishResourceRequestSchema;
export const disableResourceRequestSchema = publishResourceRequestSchema;

export const releaseListRequestSchema = paginationRequestSchema.extend({
  resource_type: registryResourceTypeSchema.optional(),
  resource_id: z.string().min(1).optional(),
  action: capabilityReleaseActionSchema.optional(),
  operator_id: z.string().min(1).optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
});

export const operationAuditQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  task_run_id: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  event_type: z.string().min(1).optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
});

export const modelPolicyQuerySchema = paginationRequestSchema.extend({
  model_policy_id: z.string().min(1).optional(),
  status: modelPolicyStatusSchema.optional(),
});

export const modelPolicyCreateDraftRequestSchema = z.object({
  policy: modelPolicySchema.extend({ status: z.literal('draft').default('draft') }),
});

export const modelPolicyUpdateDraftRequestSchema = z.object({
  policy: modelPolicySchema.partial().omit({
    model_policy_id: true,
    version: true,
    revision: true,
    created_at: true,
    updated_at: true,
    published_at: true,
  }),
  expected_revision: z.number().int().positive(),
});

export const modelPolicyValidateResponseSchema = z.object({ validation: registryValidationResultSchema });
export const modelPolicyPublishRequestSchema = publishResourceRequestSchema.extend({
  expected_revision: z.number().int().positive().optional(),
});
export const modelPolicyRollbackRequestSchema = rollbackResourceRequestSchema;
export const modelConnectionTestRequestSchema = z.object({ request_id: z.string().min(1).optional() });
export const modelConnectionTestResponseSchema = z.object({
  reachable: z.boolean(),
  model: z.string().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  capabilities: z.array(modelCapabilitySchema).default([]),
  safe_error_code: z.string().optional(),
});

export const modelCallQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  task_run_id: z.string().min(1).optional(),
  agent_run_id: z.string().min(1).optional(),
  model_policy_id: z.string().min(1).optional(),
  model_id: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  status: modelCallStatusSchema.optional(),
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
});

export const capabilityReleaseSchema = z.object({
  release_id: z.string().min(1),
  tenant_id: z.string().min(1).default('default'),
  resource_type: registryResourceTypeSchema,
  resource_id: z.string().min(1),
  resource_version: z.number().int().positive(),
  action: capabilityReleaseActionSchema,
  previous_version: z.number().int().positive().optional(),
  target_status: specStatusSchema,
  operator_id: z.string().min(1),
  validation_result: registryValidationResultSchema.optional(),
  release_note: z.string().optional(),
  metadata_json: jsonObjectSchema.default({}),
  created_at: z.string().datetime().optional(),
});

const allowedSpecStatusTransitions = {
  draft: ['validated', 'disabled'],
  validated: ['draft', 'published', 'disabled'],
  published: ['gray', 'deprecated', 'disabled'],
  gray: ['published', 'deprecated', 'disabled'],
  deprecated: [],
  disabled: [],
} as const satisfies Record<z.infer<typeof specStatusSchema>, readonly z.infer<typeof specStatusSchema>[]>;

export function validateSpecStatusTransition(input: z.infer<typeof specStatusTransitionSchema>):
  | { ok: true }
  | { ok: false; error: z.infer<typeof runtimeErrorSchema> } {
  const transition = specStatusTransitionSchema.parse(input);
  const allowedTargets = allowedSpecStatusTransitions[transition.from] as readonly z.infer<typeof specStatusSchema>[];

  if (allowedTargets.includes(transition.to)) {
    return { ok: true };
  }

  return {
    ok: false,
    error: {
      code: 'INVALID_SPEC_STATUS_TRANSITION',
      message: `Cannot transition registry resource from ${transition.from} to ${transition.to}`,
      details: {
        from: transition.from,
        to: transition.to,
        allowed_targets: [...allowedTargets],
      },
    },
  };
}

export const tenantContextSchema = z.object({
  tenant_id: z.string().min(1),
  org_id: z.string().optional(),
});

export const userContextSchema = z.object({
  user_id: z.string().min(1),
  roles: z.array(z.string()).default([]),
  groups: z.array(z.string()).default([]),
});

export const runtimeContextSchema = z.object({
  request_id: z.string().min(1),
  tenant: tenantContextSchema,
  user: userContextSchema,
  session_id: z.string().optional(),
  trace_id: z.string().optional(),
  channel: z.string().optional(),
  task_run_id: z.string().optional(),
  workflow_id: z.string().optional(),
});

export const requestContextSchema = z.object({
  request_id: z.string().min(1),
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  session_id: z.string().optional(),
  trace_id: z.string().optional(),
  channel: z.string().optional(),
  roles: z.array(z.string()).default([]),
});

export const standardSuccessResponseSchema = z.object({
  success: z.literal(true),
  data: z.unknown(),
  error: z.null(),
  trace_id: z.string().optional(),
});

export const standardErrorResponseSchema = z.object({
  success: z.literal(false),
  data: z.null(),
  error: runtimeErrorSchema,
  trace_id: z.string().optional(),
});

export const standardResponseSchema = z.union([
  standardSuccessResponseSchema,
  standardErrorResponseSchema,
]);

export const standardApiResponseSchema = standardResponseSchema;

export const flowRuntimeSchema = z.object({
  workflow_type: z.enum(['ConfigDrivenWorkflow', 'GenericAgentWorkflow']),
  task_queue: z.string().min(1),
});

export const flowStepSchema = z.object({
  id: z.string().min(1),
  type: flowStepTypeSchema,
  name: z.string().optional(),
  activity: z.string().optional(),
  tool: z.string().optional(),
  tool_version: z.string().optional(),
  agent_id: z.string().optional(),
  prompt_ref: z.string().optional(),
  mode: z.string().optional(),
  when: z.string().optional(),
  input: jsonObjectSchema.optional(),
  output_ref: z.string().optional(),
  risk_level: riskLevelSchema.optional(),
  on_failure: jsonObjectSchema.optional(),
});

export const flowSpecSchema = z.object({
  flow_id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: specStatusSchema.optional(),
  sha256: z.string().optional(),
  runtime: flowRuntimeSchema,
  input_schema: jsonObjectSchema.optional(),
  output_schema: jsonObjectSchema.optional(),
  steps: z.array(flowStepSchema).min(1),
  metadata: jsonObjectSchema.optional(),
});

export const routeConfigSchema = z.object({
  priority: z.number().int().min(0).max(100).default(50),
  keywords: z.array(z.string()).default([]),
  examples: z.array(z.string()).default([]),
  negative_examples: z.array(z.string()).default([]),
  supported_channels: z.array(z.string()).default([]),
  role_constraints: z.array(z.string()).default([]),
  confidence_threshold: z.number().min(0).max(1).default(0.7),
  ambiguous_threshold: z.number().min(0).max(1).default(0.5),
});

export const routeSpecSchema = z.object({
  route_id: z.string().optional(),
  flow_id: z.string().min(1),
  version: z.number().int().positive(),
  status: specStatusSchema.optional(),
  route: routeConfigSchema,
  sha256: z.string().optional(),
});

export const candidateFlowSchema = z.object({
  flow_id: z.string().min(1),
  version: z.number().int().positive(),
  score: z.number().min(0).max(1),
  reason: z.string().optional(),
});

export const routeDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('matched'),
    flow_id: z.string().min(1),
    flow_version: z.number().int().positive(),
    confidence: z.number().min(0).max(1),
    slots: jsonObjectSchema.default({}),
  }),
  z.object({
    decision: z.literal('need_clarify'),
    question: z.string().min(1),
    candidates: z.array(candidateFlowSchema).default([]),
  }),
  z.object({
    decision: z.literal('agent_fallback'),
    agent_id: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    decision: z.literal('reject'),
    reason: z.string().min(1),
  }),
]);

export const routeResultSchema = z.object({
  route_decision: routeDecisionSchema,
  candidates: z.array(candidateFlowSchema).default([]),
});

export const agentSpecSchema = z.object({
  agent_id: z.string().min(1),
  version: z.number().int().positive(),
  prompt_ref: z.string().min(1),
  model_policy: z.string().min(1),
  model_policy_ref: modelPolicyRefSchema.optional(),
  allowed_tools: z.array(z.string()).default([]),
  allowed_handoffs: z.array(z.string().min(1)).default([]),
  max_steps: z.number().int().positive().default(6),
  max_tokens: z.number().int().positive().default(12_000),
  output_schema: z.string().optional(),
  status: specStatusSchema.optional(),
  sha256: z.string().optional(),
});

export const promptDefinitionSchema = z.object({
  prompt_id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  content: z.string().min(1),
  variables: z.array(z.string()).default([]),
  status: specStatusSchema.optional(),
  sha256: z.string().optional(),
});

export const toolAdapterSchema = z.object({
  type: z.enum(['http', 'mcp', 'mock', 'internal-api', 'db']),
  endpoint_ref: z.string().optional(),
  config: jsonObjectSchema.optional(),
});

export const toolManifestSchema = z.object({
  tool_name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  risk_level: riskLevelSchema,
  side_effect: z.boolean().default(false),
  adapter: toolAdapterSchema,
  input_schema: jsonObjectSchema.optional(),
  output_schema: jsonObjectSchema.optional(),
  required_permissions: z.array(z.string()).default([]),
  status: specStatusSchema.optional(),
  sha256: z.string().optional(),
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const flowExecutionPlanToolSchema = z.object({
  step_id: z.string().min(1).optional(),
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tool_sha256: sha256Schema,
  risk_level: riskLevelSchema,
});

export const flowExecutionPlanAgentSchema = z.object({
  step_id: z.string().min(1),
  agent_id: z.string().min(1),
  agent_version: z.number().int().positive(),
  agent_sha256: sha256Schema,
  prompt_id: z.string().min(1),
  prompt_version: z.number().int().positive(),
  prompt_sha256: sha256Schema,
  model_policy: z.string().min(1),
  model_policy_id: z.string().min(1),
  model_policy_version: z.number().int().positive(),
  model_policy_hash: sha256Schema,
  resolved_model_policy: resolvedModelPolicySchema,
  allowed_tools: z.array(z.string().min(1)),
  agent_execution_plan_ref: z.string().min(1).optional(),
  allowed_handoffs: z.array(z.string().min(1)).default([]),
  budget: z.object({
    max_steps: z.number().int().positive(),
    max_tokens: z.number().int().positive(),
  }),
});

export const flowExecutionPlanSchema = z.object({
  execution_plan_id: z.string().min(1),
  execution_plan_ref: z.string().min(1),
  tenant_id: z.string().min(1).default('default'),
  flow_id: z.string().min(1),
  flow_version: z.number().int().positive(),
  flow_sha256: sha256Schema,
  flow_spec: flowSpecSchema,
  agents: z.array(flowExecutionPlanAgentSchema),
  tools: z.array(flowExecutionPlanToolSchema),
  allowed_tools: z.array(z.string().min(1)),
  budget: z.object({
    max_steps: z.number().int().nonnegative(),
    max_tokens: z.number().int().nonnegative(),
  }),
  generated_at: z.string().datetime(),
  execution_plan_hash: sha256Schema,
});

export const taskRunStatusSchema = z.enum([
  'created',
  'routing',
  'queued',
  'running',
  'waiting_human',
  'completed',
  'failed',
  'failed_to_start',
  'cancelled',
]);

export const taskRunSchema = z.object({
  task_run_id: z.string().min(1),
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  route_type: z.enum(['matched', 'agent_fallback', 'manual', 'unknown']),
  flow_id: z.string().optional(),
  flow_version: z.number().int().positive().optional(),
  workflow_id: z.string().optional(),
  execution_plan_ref: z.string().optional(),
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  tenant_policy_hash: sha256Schema.optional(),
  tenant_admission_id: z.string().min(1).optional(),
  status: taskRunStatusSchema,
  error_code: z.string().min(1).optional(),
  error_message: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const toolInvokeRequestSchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tool_sha256: sha256Schema.optional(),
  tenant_id: z.string().min(1),
  user_context: jsonObjectSchema.default({}),
  task_context: jsonObjectSchema.default({}),
  arguments: jsonObjectSchema.default({}),
  idempotency_key: z.string().min(1),
  risk_level: riskLevelSchema.optional(),
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  tenant_policy_hash: sha256Schema.optional(),
  execution_plan_ref: z.string().min(1).optional(),
  execution_plan_hash: sha256Schema.optional(),
  request_id: z.string().min(1).optional(),
});

export const policyEvaluationResultSchema = z.object({
  decision: toolPolicyDecisionSchema,
  risk_level: toolRiskLevelSchema,
  reason: z.string().min(1),
  requires_human_confirm: z.boolean().default(false),
  error: runtimeErrorSchema.optional(),
});

export const toolInvokeResponseSchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  status: z.enum(['allowed', 'denied', 'needs_confirmation', 'failed', 'succeeded', 'replayed']),
  result: z.unknown().optional(),
  error: runtimeErrorSchema.optional(),
  audit_event_id: z.string().optional(),
  idempotency_key: z.string().optional(),
  tool_call_id: z.string().optional(),
  policy: policyEvaluationResultSchema.optional(),
});

export const toolPreviewRequestSchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tool_sha256: sha256Schema.optional(),
  tenant_id: z.string().min(1),
  user_context: jsonObjectSchema.default({}),
  task_context: jsonObjectSchema.default({}),
  arguments: jsonObjectSchema.default({}),
  idempotency_key: z.string().min(1),
  risk_level: toolRiskLevelSchema.optional(),
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  tenant_policy_hash: sha256Schema.optional(),
  execution_plan_ref: z.string().min(1).optional(),
  execution_plan_hash: sha256Schema.optional(),
  request_id: z.string().min(1).optional(),
});

export const toolPreviewResponseSchema = z.object({
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  mode: z.literal('preview'),
  status: z.enum(['allowed', 'pending_confirmation', 'denied']),
  policy: policyEvaluationResultSchema,
  preview: z.unknown().optional(),
  error: runtimeErrorSchema.optional(),
  audit_event_id: z.string().optional(),
  idempotency_key: z.string().optional(),
});

export const toolCommitRequestSchema = z.object({
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tool_sha256: sha256Schema.optional(),
  tenant_id: z.string().min(1),
  user_context: jsonObjectSchema.default({}),
  task_context: jsonObjectSchema.default({}),
  arguments: jsonObjectSchema.default({}),
  idempotency_key: z.string().min(1),
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  tenant_policy_hash: sha256Schema.optional(),
  execution_plan_ref: z.string().min(1).optional(),
  execution_plan_hash: sha256Schema.optional(),
  request_id: z.string().min(1).optional(),
});

export const toolCommitResponseSchema = z.object({
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  mode: z.literal('commit'),
  status: z.enum(['committed', 'denied', 'failed', 'replayed']),
  result: z.unknown().optional(),
  error: runtimeErrorSchema.optional(),
  audit_event_id: z.string().optional(),
  idempotency_key: z.string().optional(),
});

export const humanTaskStatusSchema = z.enum([
  'created',
  'assigned',
  'pending',
  'approved',
  'resolved',
  'rejected',
  'cancelled',
  'expired',
]);

export const humanTaskSchema = z.object({
  human_task_id: z.string().min(1),
  tenant_id: z.string().min(1),
  task_run_id: z.string().min(1),
  workflow_id: z.string().optional(),
  kind: z.enum(['approval', 'user_input']).default('approval'),
  status: humanTaskStatusSchema,
  assignee: z.string().optional(),
  candidate_groups: z.array(z.string()).default([]),
  payload: jsonObjectSchema.default({}),
  requested_schema: jsonObjectSchema.optional(),
  response: jsonObjectSchema.optional(),
  responded_by: z.string().optional(),
  responded_at: z.string().datetime().optional(),
  response_idempotency_key: z.string().optional(),
  decision: jsonObjectSchema.optional(),
  decided_by: z.string().optional(),
  decided_at: z.string().datetime().optional(),
  decision_reason: z.string().optional(),
  created_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
});

export const humanTaskCreateRequestSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  task_run_id: z.string().min(1),
  workflow_id: z.string().optional(),
  kind: z.enum(['approval', 'user_input']).default('approval'),
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
  assignee: z.string().optional(),
  candidate_groups: z.array(z.string()).default([]),
  payload: jsonObjectSchema.default({}),
  requested_schema: jsonObjectSchema.optional(),
  request_id: z.string().min(1).optional(),
});

export const humanTaskDecisionRequestSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  decision_reason: z.string().optional(),
  payload: jsonObjectSchema.default({}),
  request_id: z.string().min(1).optional(),
});

export const humanTaskListRequestSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  task_run_id: z.string().min(1).optional(),
  status: humanTaskStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
});

export const humanTaskGetRequestSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
});

export const humanTaskDecisionResponseSchema = z.object({
  human_task: humanTaskSchema,
  audit_event_id: z.string().optional(),
});

export const humanTaskRespondRequestSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  response: jsonObjectSchema.default({}),
  response_idempotency_key: z.string().min(1),
  request_id: z.string().min(1).optional(),
});

export const humanTaskRespondResponseSchema = z.object({
  human_task: humanTaskSchema,
  audit_event_id: z.string().optional(),
  idempotent_replay: z.boolean().default(false),
});

export const humanTaskListResponseSchema = z.object({
  human_tasks: z.array(humanTaskSchema),
});

export const humanTaskGetResponseSchema = z.object({
  human_task: humanTaskSchema,
});

export const auditEventSchema = z.object({
  event_id: z.string().min(1),
  event_key: z.string().min(1).optional(),
  tenant_id: z.string().min(1),
  actor_id: z.string().optional(),
  action: z.string().min(1),
  target_type: z.string().min(1),
  target_id: z.string().min(1),
  result: z.enum(['allowed', 'denied', 'failed', 'succeeded', 'pending']),
  reason: z.string().optional(),
  occurred_at: z.string().datetime(),
  trace_id: z.string().optional(),
  payload: jsonObjectSchema.default({}),
});

export const idempotencyRecordStatusSchema = z.enum(['created', 'succeeded', 'failed']);

export const idempotencyRecordSchema = z.object({
  idempotency_key: z.string().min(1),
  tenant_id: z.string().min(1),
  target_type: z.string().min(1),
  target_id: z.string().min(1),
  request_hash: z.string().min(1),
  response_json: z.unknown().optional(),
  status: idempotencyRecordStatusSchema,
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const toolCallLogStatusSchema = z.enum([
  'previewed',
  'pending_confirmation',
  'approved',
  'rejected',
  'committed',
  'denied',
  'failed',
]);

export const toolCallLogSchema = z.object({
  tool_call_id: z.string().min(1),
  task_run_id: z.string().optional(),
  workflow_id: z.string().optional(),
  tenant_id: z.string().min(1),
  user_id: z.string().optional(),
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  risk_level: toolRiskLevelSchema,
  policy_decision: toolPolicyDecisionSchema,
  status: toolCallLogStatusSchema,
  mode: toolInvokeModeSchema.optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  idempotency_key: z.string().optional(),
  input_hash: z.string().optional(),
  output_hash: z.string().optional(),
  error_code: z.string().optional(),
  adapter_type: z.string().optional(),
  preview_json: z.unknown().optional(),
  result_json: z.unknown().optional(),
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  policy_decision_code: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const toolCallQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  task_run_id: z.string().min(1).optional(),
  tool_name: z.string().min(1).optional(),
  status: toolCallLogStatusSchema.optional(),
});

export const taskInputSchema = z
  .object({
    text: z.string().min(1).optional(),
    action_id: z.string().min(1).optional(),
    payload: jsonObjectSchema.default({}),
  })
  .passthrough();

export const runTaskRequestSchema = z.object({
  request_id: z.string().min(1).optional(),
  tenant_id: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  trace_id: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  roles: z.array(z.string()).default([]),
  input: taskInputSchema.default({ payload: {} }),
});

export const routerPreviewRequestSchema = runTaskRequestSchema;
export const routerPreviewResponseSchema = routeResultSchema;

export const workflowStartRequestSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  task_run_id: z.string().min(1),
  workflow_type: z.enum(['ConfigDrivenWorkflow', 'GenericAgentWorkflow']),
  workflow_id: z.string().min(1),
  flow_id: z.string().optional(),
  flow_version: z.number().int().positive().optional(),
  flow_snapshot_ref: z.string().optional(),
  execution_plan_ref: z.string().optional(),
  agent_execution_plan_ref: z.string().optional(),
  flow_sha256: z.string().optional(),
  flow_spec_snapshot: flowSpecSchema.optional(),
  agent_id: z.string().optional(),
  execution_mode: agentExecutionModeSchema.optional(),
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  tenant_policy_hash: sha256Schema.optional(),
  tenant_admission_id: z.string().min(1).optional(),
  input: taskInputSchema.default({ payload: {} }),
  request_id: z.string().min(1),
  trace_id: z.string().optional(),
});

export const workflowStartResponseSchema = z.object({
  workflow_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  task_run_id: z.string().min(1),
  started: z.boolean(),
  mode: z.enum(['temporal', 'mock']),
});

export const runTaskResponseSchema = z.object({
  task_run_id: z.string().min(1),
  workflow_id: z.string().min(1),
  status: taskRunStatusSchema,
  route_decision: routeDecisionSchema,
  workflow_start: workflowStartResponseSchema.optional(),
  flow_id: z.string().min(1).optional(),
  flow_version: z.number().int().positive().optional(),
  agent_id: z.string().min(1).optional(),
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  tenant_policy_hash: sha256Schema.optional(),
  tenant_admission_id: z.string().min(1).optional(),
});

export const taskRunQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  status: taskRunStatusSchema.optional(),
  flow_id: z.string().min(1).optional(),
  workflow_id: z.string().min(1).optional(),
});

export const humanTaskQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  status: humanTaskStatusSchema.optional(),
  task_run_id: z.string().min(1).optional(),
});

export const validateResourceResponseSchema = z.object({
  validation: registryValidationResultSchema,
});

export const capabilityReleaseResponseSchema = z.object({
  release: capabilityReleaseSchema,
});

export const dashboardSummaryResponseSchema = z.object({
  registry_counts: z.object({
    flows_published: z.number().int().nonnegative(),
    routes_published: z.number().int().nonnegative(),
    tools_published: z.number().int().nonnegative(),
    agents_published: z.number().int().nonnegative(),
    prompts_published: z.number().int().nonnegative(),
  }),
  pending_human_task_count: z.number().int().nonnegative(),
  running_task_count: z.number().int().nonnegative(),
  waiting_human_task_count: z.number().int().nonnegative(),
  failed_task_count: z.number().int().nonnegative(),
  recent_releases: z.array(capabilityReleaseSchema),
  recent_failed_tasks: z.array(taskRunSchema),
});

export const agentRunRequestSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  task_run_id: z.string().min(1),
  workflow_id: z.string().optional(),
  agent_execution_plan_ref: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  agent_version: z.number().int().positive().optional(),
  prompt_ref: z.string().min(1).optional(),
  model_policy: z.string().min(1).optional(),
  input: jsonObjectSchema.default({}),
  execution_mode: agentExecutionModeSchema.default('mediated_tool_call'),
  allowed_tools: z.array(z.string()).default([]),
  max_steps: z.number().int().positive().default(6),
  max_tokens: z.number().int().positive().default(12_000),
  request_id: z.string().optional(),
});

export const proposedToolCallSchema = z.object({
  call_id: z.string().min(1),
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tool_sha256: sha256Schema,
  arguments: jsonObjectSchema.default({}),
  reason_summary: decisionSummarySchema.optional(),
  risk_level: riskLevelSchema,
  requires_confirmation: z.boolean().default(false),
  source_order: z.number().int().nonnegative(),
});

export const agentRunResultSchema = z.object({
  status: piResultStatusSchema,
  final_answer: z.string().optional(),
  proposed_tool_calls: z.array(proposedToolCallSchema).default([]),
  handoff_workflow: z.string().optional(),
  usage: jsonObjectSchema.default({}),
  error: runtimeErrorSchema.optional(),
});

export const agentBudgetSchema = z.object({
  max_segments: z.number().int().positive().default(8),
  max_model_turns: z.number().int().positive().default(16),
  max_tool_calls: z.number().int().nonnegative().default(8),
  max_input_tokens: z.number().int().nonnegative().default(0),
  max_output_tokens: z.number().int().nonnegative().default(0),
  max_total_tokens: z.number().int().positive().default(12_000),
  max_duration_ms: z.number().int().positive().default(300_000),
  max_handoffs: z.number().int().nonnegative().default(2),
  max_context_bytes: z.number().int().positive().default(262_144),
  max_cost: z.number().nonnegative().optional(),
});

export const agentUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().default(0),
  estimated_cost: z.number().nonnegative().optional(),
});
const emptyAgentUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

export const agentBudgetLedgerSchema = z.object({
  segment_count: z.number().int().nonnegative().default(0),
  model_turn_count: z.number().int().nonnegative().default(0),
  tool_call_count: z.number().int().nonnegative().default(0),
  handoff_count: z.number().int().nonnegative().default(0),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative().default(0),
  estimated_cost: z.number().nonnegative().default(0),
  elapsed_duration_ms: z.number().int().nonnegative().default(0),
  context_bytes: z.number().int().nonnegative().default(0),
});

export const agentToolExecutionOperationSchema = z.enum(['invoke', 'preview', 'commit']);

export const agentToolExecutionIdentitySchema = z.object({
  agent_run_id: z.string().min(1),
  segment_index: z.number().int().nonnegative(),
  call_id: z.string().min(1),
  operation: agentToolExecutionOperationSchema,
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
});

export const agentToolPlanEntrySchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tool_sha256: sha256Schema,
  description: z.string().optional(),
  risk_level: riskLevelSchema,
  input_schema: jsonObjectSchema.default({}),
});

export const resolvedAgentPlanSchema = z.object({
  agent_id: z.string().min(1),
  agent_version: z.number().int().positive(),
  agent_sha256: sha256Schema,
  prompt_id: z.string().min(1),
  prompt_version: z.number().int().positive(),
  prompt_sha256: sha256Schema,
  system_prompt: z.string().min(1),
  model_policy: z.string().min(1),
  model_policy_id: z.string().min(1),
  model_policy_version: z.number().int().positive(),
  model_policy_hash: sha256Schema,
  resolved_model_policy: resolvedModelPolicySchema,
  allowed_tools: z.array(agentToolPlanEntrySchema).default([]),
  allowed_handoffs: z.array(z.string().min(1)).default([]),
  output_schema: jsonObjectSchema.optional(),
  budget: agentBudgetSchema,
});

export const agentExecutionPlanSchema = z.object({
  execution_plan_id: z.string().min(1),
  execution_plan_ref: z.string().min(1),
  tenant_id: z.string().min(1).default('default'),
  agent_id: z.string().min(1),
  agent_version: z.number().int().positive(),
  agent_sha256: sha256Schema,
  prompt_id: z.string().min(1),
  prompt_version: z.number().int().positive(),
  prompt_sha256: sha256Schema,
  model_policy: z.string().min(1),
  model_policy_id: z.string().min(1),
  model_policy_version: z.number().int().positive(),
  model_policy_hash: sha256Schema,
  resolved_model_policy: resolvedModelPolicySchema,
  allowed_tools: z.array(agentToolPlanEntrySchema).default([]),
  allowed_handoffs: z.array(z.string().min(1)).default([]),
  output_schema: jsonObjectSchema.optional(),
  budget: agentBudgetSchema,
  plan: resolvedAgentPlanSchema,
  generated_at: z.string().datetime(),
  execution_plan_hash: sha256Schema,
});

export const piContextSnapshotRefSchema = z.object({
  snapshot_id: z.string().min(1),
  schema_version: z.literal('pi-context/v1'),
  snapshot_hash: sha256Schema,
  message_count: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
});

export const piSegmentRequestSchema = z.object({
  agent_run_id: z.string().min(1),
  execution_plan_ref: z.string().min(1),
  context_snapshot_ref: piContextSnapshotRefSchema.optional(),
  initial_user_input: z.string().optional(),
  resume_reason: z.string().min(1),
  segment_index: z.number().int().nonnegative(),
  budget_remaining: agentBudgetSchema,
  request_context: requestContextSchema,
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  tenant_policy_hash: sha256Schema.optional(),
});

export const effectiveTenantPolicySchema = z.object({
  tenant_id: z.string().min(1),
  snapshot_ref: z.string().min(1),
  snapshot_hash: sha256Schema,
  source_policy_version: z.number().int().positive(),
  source_policy_hash: sha256Schema,
  execution_plan_ref: z.string().min(1),
  execution_plan_hash: sha256Schema,
  execution_plan_type: z.enum(['flow', 'agent']),
  root_snapshot_ref: z.string().min(1),
  parent_snapshot_ref: z.string().min(1).optional(),
  derivation_type: tenantPolicySnapshotDerivationTypeSchema,
  lineage_depth: z.number().int().nonnegative(),
  allowed_tools: z.array(tenantPolicyToolRuleSchema).default([]),
  denied_tools: z.array(tenantPolicyToolRuleSchema).default([]),
  allowed_models: z.array(tenantPolicyModelRuleSchema).default([]),
  allowed_handoffs: z.array(tenantPolicyHandoffRuleSchema).default([]),
  budget: agentBudgetSchema,
  max_concurrent_agent_runs: z.number().int().positive(),
});

export const userInputBoundaryRequestSchema = z.object({
  question: z.string().min(1),
  requested_schema: jsonObjectSchema.default({}),
  reason_summary: decisionSummarySchema.optional(),
});

export const workflowHandoffBoundaryRequestSchema = z.object({
  target_execution_plan_ref: z.string().min(1),
  arguments: jsonObjectSchema.default({}),
  reason_summary: decisionSummarySchema.optional(),
});

export const agentToolResultReferenceSchema = z.object({
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  result_ref: z.string().optional(),
  result_summary: z.string().max(2000).optional(),
  status: z.string().min(1).optional(),
  audit_event_id: z.string().min(1).optional(),
  tool_call_log_id: z.string().min(1).optional(),
  error_code: z.string().min(1).optional(),
  is_error: z.boolean().default(false),
});

export const agentAuthoritativeToolResultSchema = agentToolResultReferenceSchema.extend({
  content: z.array(jsonObjectSchema).default([]),
  details: jsonObjectSchema.default({}),
});

export const piSegmentResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    final_answer_ref: z.string().optional(),
    final_answer: z.string().max(16_000).optional(),
    context_snapshot_ref: piContextSnapshotRefSchema,
    usage: agentUsageSchema,
    model_turn_count: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('tool_requested'),
    proposed_tool_calls: z.array(proposedToolCallSchema).min(1),
    context_snapshot_ref: piContextSnapshotRefSchema,
    usage: agentUsageSchema,
    model_turn_count: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('user_input_required'),
    question: z.string().min(1),
    requested_schema: jsonObjectSchema.default({}),
    context_snapshot_ref: piContextSnapshotRefSchema,
    usage: agentUsageSchema,
    model_turn_count: z.number().int().nonnegative().default(0),
  }),
  z.object({
    status: z.literal('handoff_requested'),
    call_id: z.string().min(1),
    target_execution_plan_ref: z.string().min(1),
    arguments: jsonObjectSchema.default({}),
    context_snapshot_ref: piContextSnapshotRefSchema,
    usage: agentUsageSchema,
    model_turn_count: z.number().int().nonnegative().default(0),
  }),
  z.object({
    status: z.literal('stopped_by_budget'),
    error_code: z.string().min(1).default('AGENT_BUDGET_EXCEEDED'),
    error_message: z.string().min(1),
    context_snapshot_ref: piContextSnapshotRefSchema.optional(),
    usage: agentUsageSchema.default(emptyAgentUsage),
    model_turn_count: z.number().int().nonnegative().default(0),
  }),
  z.object({
    status: z.literal('failed'),
    error_code: z.string().min(1),
    error_message: z.string().min(1),
    context_snapshot_ref: piContextSnapshotRefSchema.optional(),
    usage: agentUsageSchema.default(emptyAgentUsage),
    model_turn_count: z.number().int().nonnegative().default(0),
  }),
  z.object({
    status: z.literal('cancelled'),
    error_code: z.string().min(1).default('AGENT_CANCELLED'),
    error_message: z.string().min(1).default('Agent run was cancelled'),
    context_snapshot_ref: piContextSnapshotRefSchema.optional(),
    usage: agentUsageSchema.default(emptyAgentUsage),
    model_turn_count: z.number().int().nonnegative().default(0),
  }),
]);

export const agentStepRecordSchema = z.object({
  agent_step_id: z.string().min(1),
  agent_run_id: z.string().min(1),
  segment_index: z.number().int().nonnegative(),
  stable_step_key: z.string().min(1),
  segment_status: agentStepStatusSchema,
  decision_summary: decisionSummarySchema.optional(),
  proposed_tool_calls: z.array(proposedToolCallSchema).default([]),
  tool_result_refs: z.array(agentToolResultReferenceSchema).default([]),
  authoritative_tool_result_refs: z.array(agentToolResultReferenceSchema).default([]),
  human_task_ids: z.array(z.string().min(1)).default([]),
  context_snapshot_before: piContextSnapshotRefSchema.optional(),
  context_snapshot_after: piContextSnapshotRefSchema.optional(),
  handoff_refs: z.array(jsonObjectSchema).default([]),
  context_snapshot_ref: piContextSnapshotRefSchema.optional(),
  output_ref: z.string().optional(),
  usage: agentUsageSchema.default(emptyAgentUsage),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const agentRunRecordSchema = z.object({
  agent_run_id: z.string().min(1),
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  task_run_id: z.string().min(1),
  workflow_id: z.string().min(1),
  workflow_run_id: z.string().min(1).optional(),
  parent_workflow_id: z.string().optional(),
  execution_plan_ref: z.string().min(1),
  execution_plan_hash: sha256Schema,
  agent_id: z.string().min(1),
  agent_version: z.number().int().positive(),
  prompt_id: z.string().min(1),
  prompt_version: z.number().int().positive(),
  model: z.string().min(1),
  model_policy_id: z.string().min(1).optional(),
  model_policy_version: z.number().int().positive().optional(),
  model_policy_hash: sha256Schema.optional(),
  selected_model_id: z.string().min(1).optional(),
  selected_provider: z.string().min(1).optional(),
  fallback_count: z.number().int().nonnegative().default(0),
  model_call_count: z.number().int().nonnegative().default(0),
  execution_mode: agentExecutionModeSchema,
  tenant_policy_snapshot_ref: z.string().min(1).optional(),
  tenant_policy_version: z.number().int().positive().optional(),
  tenant_policy_hash: sha256Schema.optional(),
  tenant_admission_id: z.string().min(1).optional(),
  status: agentRunStatusSchema,
  current_segment_index: z.number().int().nonnegative().default(0),
  model_turn_count: z.number().int().nonnegative().default(0),
  tool_call_count: z.number().int().nonnegative().default(0),
  handoff_count: z.number().int().nonnegative().default(0),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative().default(0),
  estimated_cost: z.number().nonnegative().optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const piDurableAgentWorkflowResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled', 'budget_exceeded', 'waiting_user', 'waiting_human']),
  agent_run_id: z.string().min(1),
  final_answer: z.string().max(16_000).optional(),
  context_snapshot_ref: piContextSnapshotRefSchema.optional(),
  usage: agentUsageSchema.default(emptyAgentUsage),
  error: runtimeErrorSchema.optional(),
});

export const agentRunQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  task_run_id: z.string().min(1).optional(),
  agent_id: z.string().min(1).optional(),
  status: agentRunStatusSchema.optional(),
});

export const agentStepQuerySchema = paginationRequestSchema.extend({
  tenant_id: z.string().min(1).optional(),
  agent_run_id: z.string().min(1).optional(),
});

export type ToolRiskLevel = z.infer<typeof toolRiskLevelSchema>;
export type RiskLevel = ToolRiskLevel;
export type ToolInvokeMode = z.infer<typeof toolInvokeModeSchema>;
export type ToolPolicyDecision = z.infer<typeof toolPolicyDecisionSchema>;
export type TenantRuntimePolicyStatus = z.infer<typeof tenantRuntimePolicyStatusSchema>;
export type ModelPolicyStatus = z.infer<typeof modelPolicyStatusSchema>;
export type ModelGatewayProtocol = z.infer<typeof modelGatewayProtocolSchema>;
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type ModelTarget = z.infer<typeof modelTargetSchema>;
export type ModelRetryPolicy = z.infer<typeof modelRetryPolicySchema>;
export type ModelFallbackPolicy = z.infer<typeof modelFallbackPolicySchema>;
export type ModelRequestPolicy = z.infer<typeof modelRequestPolicySchema>;
export type ModelPolicy = z.infer<typeof modelPolicySchema>;
export type ResolvedModelPolicy = z.infer<typeof resolvedModelPolicySchema>;
export type ModelPolicyRef = z.infer<typeof modelPolicyRefSchema>;
export type ModelCallStatus = z.infer<typeof modelCallStatusSchema>;
export type ModelCallAttemptStatus = z.infer<typeof modelCallAttemptStatusSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type ModelGatewayRequest = z.infer<typeof modelGatewayRequestSchema>;
export type ModelGatewayResponse = z.infer<typeof modelGatewayResponseSchema>;
export type ModelGatewayMessage = z.infer<typeof modelGatewayMessageSchema>;
export type ModelGatewayContentBlock = z.infer<typeof modelGatewayContentBlockSchema>;
export type ModelGatewayToolCall = Extract<ModelGatewayContentBlock, { type: 'tool_call' }>;
export type ModelGatewayToolDefinition = z.infer<typeof modelGatewayToolDefinitionSchema>;
export type ModelCallRecord = z.infer<typeof modelCallRecordSchema>;
export type ModelCallAttempt = z.infer<typeof modelCallAttemptSchema>;
export type ModelPolicyQuery = z.infer<typeof modelPolicyQuerySchema>;
export type ModelPolicyCreateDraftRequest = z.infer<typeof modelPolicyCreateDraftRequestSchema>;
export type ModelPolicyUpdateDraftRequest = z.infer<typeof modelPolicyUpdateDraftRequestSchema>;
export type ModelPolicyValidateResponse = z.infer<typeof modelPolicyValidateResponseSchema>;
export type ModelPolicyPublishRequest = z.infer<typeof modelPolicyPublishRequestSchema>;
export type ModelPolicyRollbackRequest = z.infer<typeof modelPolicyRollbackRequestSchema>;
export type ModelConnectionTestRequest = z.infer<typeof modelConnectionTestRequestSchema>;
export type ModelConnectionTestResponse = z.infer<typeof modelConnectionTestResponseSchema>;
export type ModelCallQuery = z.infer<typeof modelCallQuerySchema>;
export type TenantPolicyOperation = z.infer<typeof tenantPolicyOperationSchema>;
export type TenantPolicyDecisionValue = z.infer<typeof tenantPolicyDecisionValueSchema>;
export type TenantAdmissionStatus = z.infer<typeof tenantAdmissionStatusSchema>;
export type TenantPolicySnapshotDerivationType = z.infer<typeof tenantPolicySnapshotDerivationTypeSchema>;
export type TenantPolicyToolRule = z.infer<typeof tenantPolicyToolRuleSchema>;
export type TenantPolicyModelRule = z.infer<typeof tenantPolicyModelRuleSchema>;
export type TenantPolicyHandoffRule = z.infer<typeof tenantPolicyHandoffRuleSchema>;
export type TenantRuntimeBudgetCap = z.infer<typeof tenantRuntimeBudgetCapSchema>;
export type TenantRuntimePolicy = z.infer<typeof tenantRuntimePolicySchema>;
export type TenantRuntimePolicySnapshot = z.infer<typeof tenantRuntimePolicySnapshotSchema>;
export type TenantPolicyDecision = z.infer<typeof tenantPolicyDecisionSchema>;
export type TenantAgentAdmission = z.infer<typeof tenantAgentAdmissionSchema>;
export type TenantPolicyQuery = z.infer<typeof tenantPolicyQuerySchema>;
export type TenantPolicySnapshotQuery = z.infer<typeof tenantPolicySnapshotQuerySchema>;
export type TenantAgentAdmissionQuery = z.infer<typeof tenantAgentAdmissionQuerySchema>;
export type TenantPolicyCreateDraftRequest = z.infer<typeof tenantPolicyCreateDraftRequestSchema>;
export type TenantPolicyUpdateDraftRequest = z.infer<typeof tenantPolicyUpdateDraftRequestSchema>;
export type TenantPolicyValidateResponse = z.infer<typeof tenantPolicyValidateResponseSchema>;
export type TenantPolicyPublishRequest = z.infer<typeof tenantPolicyPublishRequestSchema>;
export type TenantPolicyRollbackRequest = z.infer<typeof tenantPolicyRollbackRequestSchema>;
export type TenantAdmissionResult = z.infer<typeof tenantAdmissionResultSchema>;
export type AgentExecutionMode = z.infer<typeof agentExecutionModeSchema>;
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentStepStatus = z.infer<typeof agentStepStatusSchema>;
export type PiSegmentStatus = z.infer<typeof piSegmentStatusSchema>;
export type SpecStatus = z.infer<typeof specStatusSchema>;
export type SpecStatusTransition = z.infer<typeof specStatusTransitionSchema>;
export type RegistryResourceType = z.infer<typeof registryResourceTypeSchema>;
export type CapabilityReleaseAction = z.infer<typeof capabilityReleaseActionSchema>;
export type GrayPolicy = z.infer<typeof grayPolicySchema>;
export type RegistryValidationIssue = z.infer<typeof registryValidationIssueSchema>;
export type RegistryDependencyNode = z.infer<typeof registryDependencyNodeSchema>;
export type RegistryDependencyEdge = z.infer<typeof registryDependencyEdgeSchema>;
export type RegistryValidationResult = z.infer<typeof registryValidationResultSchema>;
export type CapabilityRelease = z.infer<typeof capabilityReleaseSchema>;
export type PaginationRequest = z.infer<typeof paginationRequestSchema>;
export type PaginatedResponse<TItem> = {
  items: TItem[];
  page: number;
  page_size: number;
  total?: number;
  next_cursor?: string;
};
export type RegistryListRequest = z.infer<typeof registryListRequestSchema>;
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;
export type UpdateDraftRequest = z.infer<typeof updateDraftRequestSchema>;
export type CloneVersionRequest = z.infer<typeof cloneVersionRequestSchema>;
export type ValidateResourceRequest = z.infer<typeof validateResourceRequestSchema>;
export type ValidateResourceResponse = z.infer<typeof validateResourceResponseSchema>;
export type PublishResourceRequest = z.infer<typeof publishResourceRequestSchema>;
export type GrayResourceRequest = z.infer<typeof grayResourceRequestSchema>;
export type RollbackResourceRequest = z.infer<typeof rollbackResourceRequestSchema>;
export type DeprecateResourceRequest = z.infer<typeof deprecateResourceRequestSchema>;
export type DisableResourceRequest = z.infer<typeof disableResourceRequestSchema>;
export type CapabilityReleaseResponse = z.infer<typeof capabilityReleaseResponseSchema>;
export type ReleaseListRequest = z.infer<typeof releaseListRequestSchema>;
export type DashboardSummaryResponse = z.infer<typeof dashboardSummaryResponseSchema>;
export type OperationAuditQuery = z.infer<typeof operationAuditQuerySchema>;
export type ToolCallQuery = z.infer<typeof toolCallQuerySchema>;
export type TaskRunQuery = z.infer<typeof taskRunQuerySchema>;
export type HumanTaskQuery = z.infer<typeof humanTaskQuerySchema>;
export type RuntimeError = z.infer<typeof runtimeErrorSchema>;
export type TenantContext = z.infer<typeof tenantContextSchema>;
export type UserContext = z.infer<typeof userContextSchema>;
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;
export type RequestContext = z.infer<typeof requestContextSchema>;
export type StandardSuccessResponse<TData = unknown> = Omit<z.infer<typeof standardSuccessResponseSchema>, 'data'> & { data: TData };
export type StandardErrorResponse = z.infer<typeof standardErrorResponseSchema>;
export type StandardResponse<TData = unknown> = StandardSuccessResponse<TData> | StandardErrorResponse;
export type StandardApiResponse<TData = unknown> = StandardResponse<TData>;
export type FlowSpec = z.infer<typeof flowSpecSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type RouteSpec = z.infer<typeof routeSpecSchema>;
export type CandidateFlow = z.infer<typeof candidateFlowSchema>;
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export type RouteResult = z.infer<typeof routeResultSchema>;
export type AgentSpec = z.infer<typeof agentSpecSchema>;
export type PromptDefinition = z.infer<typeof promptDefinitionSchema>;
export type ToolManifest = z.infer<typeof toolManifestSchema>;
export type FlowExecutionPlanTool = z.infer<typeof flowExecutionPlanToolSchema>;
export type FlowExecutionPlanAgent = z.infer<typeof flowExecutionPlanAgentSchema>;
export type FlowExecutionPlan = z.infer<typeof flowExecutionPlanSchema>;
export type TaskRun = z.infer<typeof taskRunSchema>;
export type PolicyEvaluationResult = z.infer<typeof policyEvaluationResultSchema>;
export type ToolInvokeRequest = z.infer<typeof toolInvokeRequestSchema>;
export type ToolInvokeResponse = z.infer<typeof toolInvokeResponseSchema>;
export type ToolPreviewRequest = z.infer<typeof toolPreviewRequestSchema>;
export type ToolPreviewResponse = z.infer<typeof toolPreviewResponseSchema>;
export type ToolCommitRequest = z.infer<typeof toolCommitRequestSchema>;
export type ToolCommitResponse = z.infer<typeof toolCommitResponseSchema>;
export type HumanTask = z.infer<typeof humanTaskSchema>;
export type HumanTaskCreateRequest = z.infer<typeof humanTaskCreateRequestSchema>;
export type HumanTaskListRequest = z.infer<typeof humanTaskListRequestSchema>;
export type HumanTaskGetRequest = z.infer<typeof humanTaskGetRequestSchema>;
export type HumanTaskDecisionRequest = z.infer<typeof humanTaskDecisionRequestSchema>;
export type HumanTaskDecisionResponse = z.infer<typeof humanTaskDecisionResponseSchema>;
export type HumanTaskRespondRequest = z.infer<typeof humanTaskRespondRequestSchema>;
export type HumanTaskRespondResponse = z.infer<typeof humanTaskRespondResponseSchema>;
export type HumanTaskListResponse = z.infer<typeof humanTaskListResponseSchema>;
export type HumanTaskGetResponse = z.infer<typeof humanTaskGetResponseSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;
export type ToolCallLogStatus = z.infer<typeof toolCallLogStatusSchema>;
export type ToolCallLog = z.infer<typeof toolCallLogSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type RunTaskRequest = z.infer<typeof runTaskRequestSchema>;
export type RouterPreviewRequest = z.infer<typeof routerPreviewRequestSchema>;
export type RouterPreviewResponse = z.infer<typeof routerPreviewResponseSchema>;
export type RunTaskResponse = z.infer<typeof runTaskResponseSchema>;
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;
export type AgentBudget = z.infer<typeof agentBudgetSchema>;
export type AgentBudgetLedger = z.infer<typeof agentBudgetLedgerSchema>;
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type AgentToolExecutionOperation = z.infer<typeof agentToolExecutionOperationSchema>;
export type AgentToolExecutionIdentity = z.infer<typeof agentToolExecutionIdentitySchema>;
export type AgentToolPlanEntry = z.infer<typeof agentToolPlanEntrySchema>;
export type ProposedToolCall = z.infer<typeof proposedToolCallSchema>;
export type ResolvedAgentPlan = z.infer<typeof resolvedAgentPlanSchema>;
export type AgentExecutionPlan = z.infer<typeof agentExecutionPlanSchema>;
export type PiContextSnapshotRef = z.infer<typeof piContextSnapshotRefSchema>;
export type PiSegmentRequest = z.infer<typeof piSegmentRequestSchema>;
export type EffectiveTenantPolicy = z.infer<typeof effectiveTenantPolicySchema>;
export type PiSegmentResult = z.infer<typeof piSegmentResultSchema>;
export type AgentStepRecord = z.infer<typeof agentStepRecordSchema>;
export type AgentToolResultReference = z.infer<typeof agentToolResultReferenceSchema>;
export type AgentAuthoritativeToolResult = z.infer<typeof agentAuthoritativeToolResultSchema>;
export type UserInputBoundaryRequest = z.infer<typeof userInputBoundaryRequestSchema>;
export type WorkflowHandoffBoundaryRequest = z.infer<typeof workflowHandoffBoundaryRequestSchema>;
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;
export type PiDurableAgentWorkflowResult = z.infer<typeof piDurableAgentWorkflowResultSchema>;
export type AgentRunQuery = z.infer<typeof agentRunQuerySchema>;
export type AgentStepQuery = z.infer<typeof agentStepQuerySchema>;
export type WorkflowStartRequest = z.infer<typeof workflowStartRequestSchema>;
export type WorkflowStartResponse = z.infer<typeof workflowStartResponseSchema>;
