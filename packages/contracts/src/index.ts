import { z } from 'zod';

export const toolRiskLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export const riskLevelSchema = toolRiskLevelSchema;
export const toolInvokeModeSchema = z.enum(['preview', 'commit']);
export const toolPolicyDecisionSchema = z.enum(['allow', 'deny', 'require_human_confirm']);
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
export const registryResourceTypeSchema = z.enum(['flow', 'route', 'tool', 'agent', 'prompt']);
export const capabilityReleaseActionSchema = z.enum(['publish', 'gray', 'rollback', 'disable', 'deprecate']);
export const flowStepTypeSchema = z.enum(['activity', 'tool', 'agent', 'human_task', 'condition']);
export const piResultStatusSchema = z.enum([
  'final',
  'need_tool',
  'need_user',
  'handoff_to_workflow',
  'failed',
]);

export const jsonObjectSchema = z.record(z.string(), z.unknown());

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

export const paginationRequestSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().min(1).optional(),
  sort_by: z.string().min(1).optional(),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
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
  allowed_tools: z.array(z.string()).default([]),
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
  status: taskRunStatusSchema,
  error_code: z.string().min(1).optional(),
  error_message: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const toolInvokeRequestSchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1).default('1.0.0'),
  tenant_id: z.string().min(1),
  user_context: jsonObjectSchema.default({}),
  task_context: jsonObjectSchema.default({}),
  arguments: jsonObjectSchema.default({}),
  idempotency_key: z.string().min(1),
  risk_level: riskLevelSchema.optional(),
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
  tool_version: z.string().min(1).default('1.0.0'),
  tenant_id: z.string().min(1),
  user_context: jsonObjectSchema.default({}),
  task_context: jsonObjectSchema.default({}),
  arguments: jsonObjectSchema.default({}),
  idempotency_key: z.string().min(1),
  risk_level: toolRiskLevelSchema.optional(),
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
  tool_version: z.string().min(1).default('1.0.0'),
  tenant_id: z.string().min(1),
  user_context: jsonObjectSchema.default({}),
  task_context: jsonObjectSchema.default({}),
  arguments: jsonObjectSchema.default({}),
  idempotency_key: z.string().min(1),
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
  status: humanTaskStatusSchema,
  assignee: z.string().optional(),
  candidate_groups: z.array(z.string()).default([]),
  payload: jsonObjectSchema.default({}),
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
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
  assignee: z.string().optional(),
  candidate_groups: z.array(z.string()).default([]),
  payload: jsonObjectSchema.default({}),
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

export const humanTaskListResponseSchema = z.object({
  human_tasks: z.array(humanTaskSchema),
});

export const humanTaskGetResponseSchema = z.object({
  human_task: humanTaskSchema,
});

export const auditEventSchema = z.object({
  event_id: z.string().min(1),
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
  flow_spec_snapshot: flowSpecSchema.optional(),
  agent_id: z.string().optional(),
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
  agent_id: z.string().min(1),
  input: jsonObjectSchema.default({}),
  allowed_tools: z.array(z.string()).default([]),
  max_steps: z.number().int().positive().default(6),
  request_id: z.string().optional(),
});

export const proposedToolCallSchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1).default('1.0.0'),
  arguments: jsonObjectSchema.default({}),
  risk_level: riskLevelSchema.optional(),
});

export const agentRunResultSchema = z.object({
  status: piResultStatusSchema,
  final_answer: z.string().optional(),
  proposed_tool_calls: z.array(proposedToolCallSchema).default([]),
  handoff_workflow: z.string().optional(),
  usage: jsonObjectSchema.default({}),
  error: runtimeErrorSchema.optional(),
});

export type ToolRiskLevel = z.infer<typeof toolRiskLevelSchema>;
export type RiskLevel = ToolRiskLevel;
export type ToolInvokeMode = z.infer<typeof toolInvokeModeSchema>;
export type ToolPolicyDecision = z.infer<typeof toolPolicyDecisionSchema>;
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
export type WorkflowStartRequest = z.infer<typeof workflowStartRequestSchema>;
export type WorkflowStartResponse = z.infer<typeof workflowStartResponseSchema>;
