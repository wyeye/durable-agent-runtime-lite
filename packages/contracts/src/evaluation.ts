import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeJsonSchema = z.record(z.string(), z.unknown());
const boundedTextSchema = z.string().max(16_000);
const optionalBoundedTextSchema = boundedTextSchema.optional();
const riskLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
const modelGatewayProtocolSchema = z.enum(['dar_generate', 'openai_chat_completions']);

const modelCapabilitySchema = z.enum([
  'text',
  'tools',
  'json_schema',
  'streaming',
  'usage',
  'tool_choice',
]);
const modelToolChoiceModeSchema = z.enum(['auto', 'none', 'required']);
const modelResponseFormatSchema = z.enum(['text', 'json_object', 'json_schema']);
const modelTargetSchema = z.object({
  target_id: z.string().min(1),
  gateway_profile: z.string().min(1),
  provider_hint: z.string().min(1).optional(),
  model_id: z.string().min(1),
  priority: z.number().int().nonnegative(),
  enabled: z.boolean().default(true),
  capabilities: z.array(modelCapabilitySchema).min(1),
  timeout_ms: z.number().int().positive().optional(),
  max_retries: z.number().int().nonnegative().max(10).optional(),
  input_cost_per_million: z.number().nonnegative().optional(),
  output_cost_per_million: z.number().nonnegative().optional(),
});
const modelRetryPolicySchema = z.object({
  max_attempts_per_target: z.number().int().positive().max(10).default(2),
  retryable_status_codes: z.array(z.number().int().min(100).max(599)).default([429, 500]),
  retry_on_timeout: z.boolean().default(true),
  retry_on_network_error: z.boolean().default(true),
  backoff_ms: z.number().int().nonnegative().default(250),
  max_backoff_ms: z.number().int().nonnegative().default(2000),
});
const modelFallbackPolicySchema = z.object({
  enabled: z.boolean().default(false),
  ordered_target_ids: z.array(z.string().min(1)).default([]),
  eligible_error_classes: z.array(z.string().min(1)).default([]),
  stop_on_auth_error: z.boolean().default(true),
  stop_on_validation_error: z.boolean().default(true),
  stop_on_policy_denial: z.boolean().default(true),
});
const modelRequestPolicySchema = z.object({
  temperature: z.number().min(0).max(2).default(0),
  top_p: z.number().min(0).max(1).default(1),
  max_output_tokens: z.number().int().positive().default(1000),
  initial_tool_choice_mode: modelToolChoiceModeSchema.default('auto'),
  after_tool_result_tool_choice_mode: modelToolChoiceModeSchema.default('auto'),
  response_format: modelResponseFormatSchema.default('text'),
  allow_parallel_tool_calls: z.boolean().default(false),
});
const resolvedModelPolicySchema = z.object({
  model_policy_id: z.string().min(1),
  model_policy_version: z.number().int().positive(),
  model_policy_hash: sha256Schema,
  protocol: modelGatewayProtocolSchema,
  resolved_targets: z.array(modelTargetSchema).min(1),
  retry_policy: modelRetryPolicySchema,
  fallback_policy: modelFallbackPolicySchema,
  request_policy: modelRequestPolicySchema,
});
const agentBudgetSchema = z.object({
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
const flowExecutionPlanToolSchema = z.object({
  step_id: z.string().min(1).optional(),
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tool_sha256: sha256Schema,
  risk_level: riskLevelSchema,
});
const agentToolPlanEntrySchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tool_sha256: sha256Schema,
  description: z.string().optional(),
  risk_level: riskLevelSchema,
  input_schema: safeJsonSchema.default({}),
});
const resolvedAgentPlanSchema = z.object({
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
  output_schema: safeJsonSchema.optional(),
  budget: agentBudgetSchema,
});

export const evaluationDatasetStatusSchema = z.enum([
  'draft',
  'validated',
  'published',
  'deprecated',
  'disabled',
]);
export const evaluationSubjectTypeSchema = z.enum(['prompt', 'agent', 'model_policy']);
export const evaluationRunStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export const evaluationCaseStatusSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'skipped',
  'system_error',
]);
export const evaluationMetricTypeSchema = z.enum([
  'runtime',
  'tool',
  'final_output',
  'safety',
  'performance',
  'aggregate',
]);
export const evaluationGateModeSchema = z.enum(['disabled', 'advisory', 'required']);
export const evaluationGateDecisionStatusSchema = z.enum([
  'passed',
  'failed',
  'stale',
  'overridden',
  'advisory_failed',
]);
export const evaluationTriggerTypeSchema = z.enum(['manual', 'publish_gate', 'regression', 'ci']);
export const evaluationComparisonSeveritySchema = z.enum([
  'none',
  'low',
  'medium',
  'high',
  'critical',
  'not_comparable',
]);

export const evaluationAssertionSchema = z
  .object({
    type: z.enum(['contains', 'not_contains', 'regex', 'json_schema', 'exact', 'non_empty']),
    value: z.union([boundedTextSchema, safeJsonSchema]).optional(),
    flags: z.string().max(8).optional(),
  })
  .strict()
  .superRefine((assertion, context) => {
    if (assertion.type !== 'non_empty' && assertion.value === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Assertion value is required except for non_empty',
        path: ['value'],
      });
    }
    if (assertion.type === 'regex') {
      if (typeof assertion.value !== 'string') {
        context.addIssue({ code: 'custom', message: 'Regex assertion value must be a string' });
      } else if (assertion.value.length > 512) {
        context.addIssue({ code: 'custom', message: 'Regex assertion is too long' });
      }
    }
  });

export const expectedToolCallSchema = z
  .object({
    tool_name: z.string().min(1),
    order: z.number().int().nonnegative().optional(),
    min_calls: z.number().int().nonnegative().default(1),
    max_calls: z.number().int().nonnegative().default(1),
    argument_match_mode: z.enum(['exact', 'subset', 'schema_only', 'ignore']).default('subset'),
    expected_arguments: safeJsonSchema.default({}),
    expected_argument_schema: safeJsonSchema.optional(),
  })
  .strict()
  .refine((value) => value.max_calls >= value.min_calls, {
    message: 'max_calls must be greater than or equal to min_calls',
    path: ['max_calls'],
  });

export const evaluationGateThresholdsSchema = z
  .object({
    minimum_pass_rate: z.number().min(0).max(1).default(0),
    minimum_weighted_score: z.number().min(0).max(1).default(0),
    minimum_tool_selection_score: z.number().min(0).max(1).default(0),
    maximum_forbidden_tool_calls: z.number().int().nonnegative().default(0),
    maximum_policy_violations: z.number().int().nonnegative().default(0),
    maximum_side_effect_without_approval: z.number().int().nonnegative().default(0),
    maximum_secret_leaks: z.number().int().nonnegative().default(0),
    maximum_hidden_reasoning_leaks: z.number().int().nonnegative().default(0),
    maximum_cross_tenant_violations: z.number().int().nonnegative().default(0),
    maximum_system_error_rate: z.number().min(0).max(1).default(0),
    maximum_latency_ms: z.number().int().positive().optional(),
    maximum_input_tokens: z.number().int().nonnegative().optional(),
    maximum_output_tokens: z.number().int().nonnegative().optional(),
    maximum_total_tokens: z.number().int().nonnegative().optional(),
    maximum_cost: z.number().nonnegative().optional(),
  })
  .strict();

export const evaluationRegressionRulesSchema = z
  .object({
    maximum_score_regression: z.number().min(0).max(1).default(0),
    maximum_pass_rate_regression: z.number().min(0).max(1).default(0),
    maximum_latency_regression_percent: z.number().nonnegative().default(0),
    maximum_token_regression_percent: z.number().nonnegative().default(0),
    maximum_cost_regression_percent: z.number().nonnegative().default(0),
    block_newly_failed_cases: z.boolean().default(true),
    block_safety_regression: z.boolean().default(true),
    block_tool_regression: z.boolean().default(true),
    require_same_dataset: z.boolean().default(true),
  })
  .strict();

export const evaluationCaseSchema = z.object({
  case_id: z.string().min(1),
  dataset_id: z.string().min(1),
  dataset_version: z.number().int().positive(),
  name: z.string().min(1).max(256),
  description: optionalBoundedTextSchema,
  input: safeJsonSchema,
  context_refs: z.array(z.string().min(1)).default([]),
  expected_status: z.string().min(1).optional(),
  expected_tool_calls: z.array(expectedToolCallSchema).default([]),
  forbidden_tools: z.array(z.string().min(1)).default([]),
  final_assertions: z.array(evaluationAssertionSchema).default([]),
  policy_assertions: z.array(evaluationAssertionSchema).default([]),
  latency_budget_ms: z.number().int().positive().optional(),
  input_token_budget: z.number().int().positive().optional(),
  output_token_budget: z.number().int().positive().optional(),
  total_token_budget: z.number().int().positive().optional(),
  cost_budget: z.number().nonnegative().optional(),
  minimum_case_score: z.number().min(0).max(1).optional(),
  weight: z.number().positive().default(1),
  tags: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const evaluationDatasetSchema = z.object({
  dataset_id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1).max(256),
  description: optionalBoundedTextSchema,
  status: evaluationDatasetStatusSchema,
  domain: z.string().min(1).max(128).optional(),
  tags: z.array(z.string().min(1)).default([]),
  default_weight: z.number().positive().default(1),
  revision: z.number().int().positive().default(1),
  dataset_hash: sha256Schema.optional(),
  created_by: z.string().min(1).optional(),
  updated_by: z.string().min(1).optional(),
  published_by: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  published_at: z.string().datetime().optional(),
});

export const evaluationCandidateBundleSchema = z.object({
  primary_subject_type: evaluationSubjectTypeSchema,
  primary_subject_id: z.string().min(1),
  primary_subject_version: z.number().int().positive(),
  primary_subject_hash: sha256Schema,
  agent_id: z.string().min(1),
  agent_version: z.number().int().positive(),
  agent_hash: sha256Schema,
  prompt_id: z.string().min(1),
  prompt_version: z.number().int().positive(),
  prompt_hash: sha256Schema,
  model_policy_id: z.string().min(1),
  model_policy_version: z.number().int().positive(),
  model_policy_hash: sha256Schema,
  agent_execution_plan_ref: z.string().min(1),
  agent_execution_plan_hash: sha256Schema,
  tool_refs: z.array(flowExecutionPlanToolSchema).default([]),
  tenant_policy_snapshot_ref: z.string().min(1),
  tenant_policy_snapshot_hash: sha256Schema,
  evaluation_execution_plan_ref: z.string().min(1).optional(),
  evaluation_execution_plan_hash: sha256Schema.optional(),
});

export const evaluationSubjectSnapshotSchema = z.object({
  subject_snapshot_id: z.string().min(1),
  subject_snapshot_ref: z.string().min(1),
  primary_subject_type: evaluationSubjectTypeSchema,
  primary_subject_id: z.string().min(1),
  primary_subject_version: z.number().int().positive(),
  primary_subject_hash: sha256Schema,
  candidate_bundle: evaluationCandidateBundleSchema,
  candidate_bundle_hash: sha256Schema,
  created_at: z.string().datetime(),
});

export const evaluationExecutionPlanSchema = z.object({
  evaluation_execution_plan_id: z.string().min(1),
  evaluation_execution_plan_ref: z.string().min(1),
  subject_snapshot_ref: z.string().min(1),
  subject_snapshot_hash: sha256Schema,
  tenant_id: z.string().min(1),
  dataset_id: z.string().min(1),
  dataset_version: z.number().int().positive(),
  dataset_hash: sha256Schema,
  candidate_bundle_hash: sha256Schema,
  agent_execution_plan_ref: z.string().min(1),
  agent_execution_plan_hash: sha256Schema,
  resolved_agent_plan: resolvedAgentPlanSchema,
  tools: z.array(flowExecutionPlanToolSchema).default([]),
  tenant_policy_snapshot_ref: z.string().min(1),
  tenant_policy_snapshot_hash: sha256Schema,
  budget: agentBudgetSchema,
  evaluation_mode: z.enum(['deterministic', 'model_gateway']).default('model_gateway'),
  plan_hash: sha256Schema,
  created_at: z.string().datetime(),
});

export const evaluationRunSchema = z.object({
  evaluation_run_id: z.string().min(1),
  tenant_id: z.string().min(1),
  dataset_id: z.string().min(1),
  dataset_version: z.number().int().positive(),
  dataset_hash: sha256Schema,
  subject_snapshot_ref: z.string().min(1),
  subject_snapshot_hash: sha256Schema,
  evaluation_execution_plan_ref: z.string().min(1),
  evaluation_execution_plan_hash: sha256Schema,
  baseline_run_id: z.string().min(1).optional(),
  trigger_type: evaluationTriggerTypeSchema,
  status: evaluationRunStatusSchema,
  total_cases: z.number().int().nonnegative().default(0),
  completed_cases: z.number().int().nonnegative().default(0),
  passed_cases: z.number().int().nonnegative().default(0),
  failed_cases: z.number().int().nonnegative().default(0),
  skipped_cases: z.number().int().nonnegative().default(0),
  aggregate_score: z.number().min(0).max(1).optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  error_code: z.string().min(1).optional(),
  error_message: boundedTextSchema.optional(),
  created_by: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const evaluationMetricResultSchema = z.object({
  metric_name: z.string().min(1),
  metric_type: evaluationMetricTypeSchema,
  score: z.number().min(0).max(1).optional(),
  passed: z.boolean(),
  hard_gate: z.boolean().default(false),
  actual: z.unknown().optional(),
  expected: z.unknown().optional(),
  reason: boundedTextSchema.optional(),
});

export const evaluationCaseResultSchema = z.object({
  evaluation_case_result_id: z.string().min(1),
  evaluation_run_id: z.string().min(1),
  case_id: z.string().min(1),
  status: evaluationCaseStatusSchema,
  score: z.number().min(0).max(1).optional(),
  metric_results: z.array(evaluationMetricResultSchema).default([]),
  actual_status: z.string().min(1).optional(),
  task_run_id: z.string().min(1).optional(),
  agent_run_id: z.string().min(1).optional(),
  model_call_ids: z.array(z.string().min(1)).default([]),
  tool_call_ids: z.array(z.string().min(1)).default([]),
  final_output_ref: z.string().min(1).optional(),
  safe_output: z.unknown().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  estimated_cost: z.number().nonnegative().optional(),
  error_code: z.string().min(1).optional(),
  error_message: boundedTextSchema.optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const evaluationAggregateResultSchema = z.object({
  evaluation_run_id: z.string().min(1),
  total_cases: z.number().int().nonnegative(),
  completed_cases: z.number().int().nonnegative(),
  passed_cases: z.number().int().nonnegative(),
  failed_cases: z.number().int().nonnegative(),
  skipped_cases: z.number().int().nonnegative(),
  weighted_score: z.number().min(0).max(1),
  pass_rate: z.number().min(0).max(1),
  hard_gate_failures: z.array(evaluationMetricResultSchema).default([]),
  metric_summary: safeJsonSchema.default({}),
});

export const evaluationComparisonSchema = z.object({
  comparison_id: z.string().min(1),
  candidate_run_id: z.string().min(1),
  baseline_run_id: z.string().min(1),
  comparable: z.boolean(),
  dataset_id: z.string().min(1).optional(),
  dataset_version: z.number().int().positive().optional(),
  overall_score_delta: z.number().optional(),
  pass_rate_delta: z.number().optional(),
  tool_accuracy_delta: z.number().optional(),
  safety_delta: z.number().optional(),
  latency_delta: z.number().optional(),
  token_delta: z.number().optional(),
  cost_delta: z.number().optional(),
  newly_failed_cases: z.array(z.string().min(1)).default([]),
  newly_passed_cases: z.array(z.string().min(1)).default([]),
  unchanged_failures: z.array(z.string().min(1)).default([]),
  regression_severity: evaluationComparisonSeveritySchema,
  reasons: z.array(z.string().min(1)).default([]),
  created_at: z.string().datetime().optional(),
});

export const evaluationGatePolicySchema = z.object({
  gate_policy_id: z.string().min(1),
  version: z.number().int().positive(),
  status: evaluationDatasetStatusSchema,
  resource_types: z.array(evaluationSubjectTypeSchema).min(1),
  required_dataset_refs: z.array(z.string().min(1)).min(1),
  thresholds: evaluationGateThresholdsSchema.default(() =>
    evaluationGateThresholdsSchema.parse({}),
  ),
  regression_rules: evaluationRegressionRulesSchema.default(() =>
    evaluationRegressionRulesSchema.parse({}),
  ),
  required_case_tags: z.array(z.string().min(1)).default([]),
  allow_override: z.boolean().default(false),
  revision: z.number().int().positive().default(1),
  gate_policy_hash: sha256Schema.optional(),
  created_by: z.string().min(1).optional(),
  updated_by: z.string().min(1).optional(),
  published_by: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
  published_at: z.string().datetime().optional(),
});

export const evaluationGateDecisionSchema = z.object({
  gate_decision_id: z.string().min(1),
  resource_type: evaluationSubjectTypeSchema,
  resource_id: z.string().min(1),
  resource_version: z.number().int().positive(),
  resource_hash: sha256Schema,
  candidate_bundle_hash: sha256Schema,
  gate_policy_id: z.string().min(1),
  gate_policy_version: z.number().int().positive(),
  gate_policy_hash: sha256Schema,
  evaluation_run_ids: z.array(z.string().min(1)).min(1),
  decision: evaluationGateDecisionStatusSchema,
  reasons: z.array(z.string().min(1)).default([]),
  decided_at: z.string().datetime(),
  created_at: z.string().datetime().optional(),
});

export const evaluationGateOverrideSchema = z.object({
  override_id: z.string().min(1),
  gate_decision_id: z.string().min(1),
  resource_type: evaluationSubjectTypeSchema,
  resource_id: z.string().min(1),
  resource_version: z.number().int().positive(),
  resource_hash: sha256Schema,
  operator_id: z.string().min(1),
  reason: z.string().min(12).max(2000),
  expires_at: z.string().datetime().optional(),
  created_at: z.string().datetime().optional(),
});

export const evaluationDatasetQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
  dataset_id: z.string().min(1).optional(),
  status: evaluationDatasetStatusSchema.optional(),
  tag: z.string().min(1).optional(),
});

export const evaluationRunQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
  tenant_id: z.string().min(1).optional(),
  dataset_id: z.string().min(1).optional(),
  status: evaluationRunStatusSchema.optional(),
  trigger_type: evaluationTriggerTypeSchema.optional(),
  resource_id: z.string().min(1).optional(),
});

export const evaluationRunCreateRequestSchema = z.object({
  tenant_id: z.string().min(1).optional(),
  dataset_id: z.string().min(1),
  dataset_version: z.number().int().positive(),
  subject_snapshot_ref: z.string().min(1).optional(),
  evaluation_execution_plan_ref: z.string().min(1).optional(),
  candidate_bundle: evaluationCandidateBundleSchema.optional(),
  baseline_run_id: z.string().min(1).optional(),
  trigger_type: evaluationTriggerTypeSchema.default('manual'),
});

export const evaluationComparisonRequestSchema = z.object({
  candidate_run_id: z.string().min(1),
  baseline_run_id: z.string().min(1),
});

export const evaluationGatePolicyCreateRequestSchema = z.object({
  policy: evaluationGatePolicySchema.omit({
    revision: true,
    gate_policy_hash: true,
    created_at: true,
    updated_at: true,
    published_at: true,
  }),
});

export const evaluationOverrideRequestSchema = z.object({
  gate_decision_id: z.string().min(1),
  resource_hash: sha256Schema,
  reason: z.string().min(12).max(2000),
  scope: z.enum(['single_resource_hash']),
  expires_at: z.string().datetime().optional(),
});

export type EvaluationDatasetStatus = z.infer<typeof evaluationDatasetStatusSchema>;
export type EvaluationSubjectType = z.infer<typeof evaluationSubjectTypeSchema>;
export type EvaluationRunStatus = z.infer<typeof evaluationRunStatusSchema>;
export type EvaluationCaseStatus = z.infer<typeof evaluationCaseStatusSchema>;
export type EvaluationMetricType = z.infer<typeof evaluationMetricTypeSchema>;
export type EvaluationGateMode = z.infer<typeof evaluationGateModeSchema>;
export type EvaluationGateDecisionStatus = z.infer<
  typeof evaluationGateDecisionStatusSchema
>;
export type EvaluationAssertion = z.infer<typeof evaluationAssertionSchema>;
export type ExpectedToolCall = z.infer<typeof expectedToolCallSchema>;
export type EvaluationGateThresholds = z.infer<typeof evaluationGateThresholdsSchema>;
export type EvaluationRegressionRules = z.infer<typeof evaluationRegressionRulesSchema>;
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;
export type EvaluationCandidateBundle = z.infer<typeof evaluationCandidateBundleSchema>;
export type EvaluationSubjectSnapshot = z.infer<typeof evaluationSubjectSnapshotSchema>;
export type EvaluationExecutionPlan = z.infer<typeof evaluationExecutionPlanSchema>;
export type EvaluationRun = z.infer<typeof evaluationRunSchema>;
export type EvaluationCaseResult = z.infer<typeof evaluationCaseResultSchema>;
export type EvaluationMetricResult = z.infer<typeof evaluationMetricResultSchema>;
export type EvaluationAggregateResult = z.infer<typeof evaluationAggregateResultSchema>;
export type EvaluationComparison = z.infer<typeof evaluationComparisonSchema>;
export type EvaluationComparisonSeverity = z.infer<typeof evaluationComparisonSeveritySchema>;
export type EvaluationGatePolicy = z.infer<typeof evaluationGatePolicySchema>;
export type EvaluationGateDecision = z.infer<typeof evaluationGateDecisionSchema>;
export type EvaluationGateOverride = z.infer<typeof evaluationGateOverrideSchema>;
export type EvaluationDatasetQuery = z.infer<typeof evaluationDatasetQuerySchema>;
export type EvaluationRunQuery = z.infer<typeof evaluationRunQuerySchema>;
export type EvaluationRunCreateRequest = z.infer<typeof evaluationRunCreateRequestSchema>;
export type EvaluationComparisonRequest = z.infer<typeof evaluationComparisonRequestSchema>;
export type EvaluationGatePolicyCreateRequest = z.infer<
  typeof evaluationGatePolicyCreateRequestSchema
>;
export type EvaluationOverrideRequest = z.infer<typeof evaluationOverrideRequestSchema>;
