import { z } from 'zod';

export const riskLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']);
export const specStatusSchema = z.enum(['draft', 'published', 'gray', 'disabled', 'archived']);
export const flowStepTypeSchema = z.enum(['activity', 'tool', 'agent', 'human_task', 'condition']);
export const piResultStatusSchema = z.enum([
  'final',
  'need_tool',
  'need_user',
  'handoff_to_workflow',
  'failed',
]);

export const jsonObjectSchema = z.record(z.string(), z.unknown());

export const runtimeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: jsonObjectSchema.optional(),
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
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
});

export const toolInvokeRequestSchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  tenant_id: z.string().min(1),
  user_context: jsonObjectSchema.default({}),
  task_context: jsonObjectSchema.default({}),
  arguments: jsonObjectSchema.default({}),
  idempotency_key: z.string().min(1),
  risk_level: riskLevelSchema.optional(),
  request_id: z.string().min(1).optional(),
});

export const toolInvokeResponseSchema = z.object({
  tool_name: z.string().min(1),
  tool_version: z.string().min(1),
  status: z.enum(['allowed', 'denied', 'needs_confirmation', 'failed', 'succeeded', 'replayed']),
  result: z.unknown().optional(),
  error: runtimeErrorSchema.optional(),
  audit_event_id: z.string().optional(),
  idempotency_key: z.string().optional(),
});

export const humanTaskStatusSchema = z.enum([
  'created',
  'assigned',
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
  created_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
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

export const routerPreviewResponseSchema = z.object({
  route_decision: routeDecisionSchema,
  candidates: z.array(candidateFlowSchema).default([]),
});

export const runTaskResponseSchema = z.object({
  task_run_id: z.string().min(1),
  workflow_id: z.string().min(1),
  status: taskRunStatusSchema,
  route_decision: routeDecisionSchema,
  flow_id: z.string().min(1).optional(),
  flow_version: z.number().int().positive().optional(),
  agent_id: z.string().min(1).optional(),
});

export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type RuntimeError = z.infer<typeof runtimeErrorSchema>;
export type RequestContext = z.infer<typeof requestContextSchema>;
export type FlowSpec = z.infer<typeof flowSpecSchema>;
export type FlowStep = z.infer<typeof flowStepSchema>;
export type RouteSpec = z.infer<typeof routeSpecSchema>;
export type CandidateFlow = z.infer<typeof candidateFlowSchema>;
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export type AgentSpec = z.infer<typeof agentSpecSchema>;
export type ToolManifest = z.infer<typeof toolManifestSchema>;
export type TaskRun = z.infer<typeof taskRunSchema>;
export type ToolInvokeRequest = z.infer<typeof toolInvokeRequestSchema>;
export type ToolInvokeResponse = z.infer<typeof toolInvokeResponseSchema>;
export type HumanTask = z.infer<typeof humanTaskSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;
export type RunTaskRequest = z.infer<typeof runTaskRequestSchema>;
export type RouterPreviewRequest = z.infer<typeof routerPreviewRequestSchema>;
export type RouterPreviewResponse = z.infer<typeof routerPreviewResponseSchema>;
export type RunTaskResponse = z.infer<typeof runTaskResponseSchema>;

