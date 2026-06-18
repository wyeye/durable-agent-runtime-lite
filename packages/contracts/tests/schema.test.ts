import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  agentRunRequestSchema,
  agentRunResultSchema,
  agentBudgetSchema,
  agentExecutionPlanSchema,
  agentRunRecordSchema,
  agentStepRecordSchema,
  capabilityReleaseResponseSchema,
  cloneVersionRequestSchema,
  createDraftRequestSchema,
  dashboardSummaryResponseSchema,
  flowExecutionPlanSchema,
  flowSpecSchema,
  grayResourceRequestSchema,
  humanTaskCreateRequestSchema,
  humanTaskDecisionRequestSchema,
  humanTaskDecisionResponseSchema,
  humanTaskRespondRequestSchema,
  humanTaskGetRequestSchema,
  humanTaskGetResponseSchema,
  humanTaskListRequestSchema,
  humanTaskListResponseSchema,
  operationAuditQuerySchema,
  paginationRequestSchema,
  promptDefinitionSchema,
  policyEvaluationResultSchema,
  publishResourceRequestSchema,
  registryListRequestSchema,
  releaseListRequestSchema,
  rollbackResourceRequestSchema,
  routeSpecSchema,
  runtimeContextSchema,
  standardApiResponseSchema,
  standardErrorResponseSchema,
  taskRunQuerySchema,
  toolCallQuerySchema,
  toolCallLogSchema,
  toolCommitRequestSchema,
  toolCommitResponseSchema,
  toolManifestSchema,
  updateDraftRequestSchema,
  validateResourceRequestSchema,
  validateResourceResponseSchema,
  validateSpecStatusTransition,
  toolPreviewRequestSchema,
  toolPreviewResponseSchema,
  piSegmentResultSchema,
  proposedToolCallSchema,
  resolvedAgentPlanSchema,
  workflowStartRequestSchema,
} from '../src/index.js';

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')) as T;
}

describe('contracts schemas', () => {
  it('validates registry lifecycle statuses and transitions', () => {
    expect(validateSpecStatusTransition({ from: 'draft', to: 'validated' })).toEqual({ ok: true });
    expect(validateSpecStatusTransition({ from: 'validated', to: 'draft' })).toEqual({ ok: true });
    expect(validateSpecStatusTransition({ from: 'validated', to: 'published' })).toEqual({ ok: true });
    expect(validateSpecStatusTransition({ from: 'published', to: 'gray' })).toEqual({ ok: true });
    expect(validateSpecStatusTransition({ from: 'gray', to: 'published' })).toEqual({ ok: true });
    expect(validateSpecStatusTransition({ from: 'published', to: 'deprecated' })).toEqual({ ok: true });
    expect(validateSpecStatusTransition({ from: 'gray', to: 'deprecated' })).toEqual({ ok: true });
    expect(validateSpecStatusTransition({ from: 'published', to: 'draft' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_SPEC_STATUS_TRANSITION' },
    });
    expect(() => flowSpecSchema.parse({
      flow_id: 'archived_flow',
      version: 1,
      status: 'archived',
      runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
      steps: [{ id: 'one', type: 'activity', activity: 'noop' }],
    })).toThrow();
  });

  it('validates core MVP specs and runtime DTOs', () => {
    expect(flowSpecSchema.parse({
      flow_id: 'sample_flow',
      version: 1,
      runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
      steps: [{ id: 'normalize', type: 'activity', activity: 'input.normalize' }],
    }).flow_id).toBe('sample_flow');

    expect(routeSpecSchema.parse({
      flow_id: 'sample_flow',
      version: 1,
      route: { keywords: ['mvp'] },
    }).route.priority).toBe(50);

    expect(toolManifestSchema.parse({
      tool_name: 'knowledge.search',
      version: '1.0.0',
      risk_level: 'L1',
      side_effect: false,
      adapter: { type: 'mock' },
    }).tool_name).toBe('knowledge.search');

    expect(promptDefinitionSchema.parse({
      prompt_id: 'sample_prompt',
      version: 1,
      name: 'Sample',
      content: 'hello',
    }).variables).toEqual([]);

    expect(runtimeContextSchema.parse({
      request_id: 'req_1',
      tenant: { tenant_id: 'tenant_1' },
      user: { user_id: 'user_1' },
    }).user.roles).toEqual([]);

    expect(workflowStartRequestSchema.parse({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_type: 'GenericAgentWorkflow',
      workflow_id: 'wf_1',
      agent_id: 'sample_agent',
      input: { text: 'hello' },
      request_id: 'req_1',
    }).workflow_type).toBe('GenericAgentWorkflow');

    expect(agentRunRequestSchema.parse({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      agent_id: 'sample_agent',
      allowed_tools: [],
    }).allowed_tools).toEqual([]);

    expect(agentRunResultSchema.parse({ status: 'final', final_answer: 'ok' }).status).toBe('final');
  });

  it('validates checked-in MVP examples', async () => {
    expect(flowSpecSchema.parse(await readJson('examples/flows/sample-flow.json')).flow_id).toBe('sample_flow');
    expect(routeSpecSchema.parse(await readJson('examples/routes/sample-route.json')).flow_id).toBe('sample_flow');
    expect(agentRunResultSchema.parse({ status: 'final', final_answer: 'example' }).status).toBe('final');
    expect(toolManifestSchema.parse(await readJson('examples/tools/knowledge-search-tool.json')).tool_name).toBe('knowledge.search');
    expect(toolManifestSchema.parse(await readJson('examples/tools/record-write-mock-tool.json')).risk_level).toBe('L3');
  });

  it('validates L3 tool governance DTOs', () => {
    expect(policyEvaluationResultSchema.parse({
      decision: 'require_human_confirm',
      risk_level: 'L3',
      reason: 'side_effect_requires_human_confirm',
      requires_human_confirm: true,
    }).decision).toBe('require_human_confirm');

    expect(toolPreviewRequestSchema.parse({
      tool_name: 'record.write.mock',
      tool_version: '1.0.0',
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_1', workflow_id: 'wf_1' },
      arguments: { record: { title: 'demo' } },
      idempotency_key: 'task_1:record.write.mock:preview',
    }).tool_name).toBe('record.write.mock');

    expect(toolPreviewResponseSchema.parse({
      tool_call_id: 'tool_call_1',
      tool_name: 'record.write.mock',
      tool_version: '1.0.0',
      mode: 'preview',
      status: 'pending_confirmation',
      policy: {
        decision: 'require_human_confirm',
        risk_level: 'L3',
        reason: 'side_effect_requires_human_confirm',
        requires_human_confirm: true,
      },
      preview: { planned: true },
      audit_event_id: 'audit_1',
      idempotency_key: 'task_1:record.write.mock:preview',
    }).status).toBe('pending_confirmation');

    expect(toolCommitRequestSchema.parse({
      tool_call_id: 'tool_call_1',
      tool_name: 'record.write.mock',
      tool_version: '1.0.0',
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_1' },
      arguments: { record: { title: 'demo' } },
      idempotency_key: 'task_1:record.write.mock:commit',
    }).tool_version).toBe('1.0.0');

    expect(() => toolCommitRequestSchema.parse({
      tool_call_id: 'tool_call_1',
      tool_name: 'record.write.mock',
      tenant_id: 'tenant_1',
      arguments: { record: { title: 'demo' } },
      idempotency_key: 'task_1:record.write.mock:commit',
    })).toThrow();

    expect(toolCommitResponseSchema.parse({
      tool_call_id: 'tool_call_1',
      tool_name: 'record.write.mock',
      tool_version: '1.0.0',
      mode: 'commit',
      status: 'committed',
      result: { written: true },
      audit_event_id: 'audit_2',
      idempotency_key: 'task_1:record.write.mock:commit',
    }).status).toBe('committed');

    const humanTask = {
      human_task_id: 'human_1',
      tenant_id: 'tenant_1',
      task_run_id: 'task_1',
      workflow_id: 'wf_1',
      status: 'approved',
      candidate_groups: [],
      payload: { tool_call_id: 'tool_call_1' },
      decision: { approved: true },
      decided_by: 'user_1',
      decided_at: '2025-01-01T00:00:00.000Z',
      decision_reason: 'looks good',
    };

    expect(humanTaskCreateRequestSchema.parse({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_id: 'wf_1',
      tool_call_id: 'tool_call_1',
      payload: { preview: true },
    }).candidate_groups).toEqual([]);
    expect(humanTaskListRequestSchema.parse({ tenant_id: 'tenant_1', user_id: 'user_1' })).toEqual({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      page: 1,
      page_size: 20,
    });
    expect(humanTaskGetRequestSchema.parse({ tenant_id: 'tenant_1', user_id: 'user_1' }).tenant_id).toBe('tenant_1');
    expect(humanTaskDecisionRequestSchema.parse({ tenant_id: 'tenant_1', user_id: 'approver_1' }).payload).toEqual({});
    expect(humanTaskDecisionResponseSchema.parse({ human_task: humanTask }).human_task.status).toBe('approved');
    expect(humanTaskListResponseSchema.parse({ human_tasks: [humanTask] }).human_tasks).toHaveLength(1);
    expect(humanTaskGetResponseSchema.parse({ human_task: humanTask }).human_task.human_task_id).toBe('human_1');

    expect(toolCallLogSchema.parse({
      tool_call_id: 'tool_call_1',
      task_run_id: 'task_1',
      workflow_id: 'wf_1',
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      tool_name: 'record.write.mock',
      tool_version: '1.0.0',
      risk_level: 'L3',
      policy_decision: 'require_human_confirm',
      status: 'pending_confirmation',
      mode: 'preview',
      idempotency_key: 'task_1:record.write.mock:preview',
    }).risk_level).toBe('L3');
  });

  it('validates immutable FlowExecutionPlan schema', () => {
    const flowSpec = {
      flow_id: 'flow_1',
      version: 1,
      runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
      steps: [
        { id: 'search', type: 'tool', tool: 'knowledge.search', tool_version: '1.0.0' },
        { id: 'agent', type: 'agent', agent_id: 'agent_1', input: { agent_version: 2 } },
      ],
    };
    const hash = 'a'.repeat(64);
    const plan = flowExecutionPlanSchema.parse({
      execution_plan_id: 'plan_1',
      execution_plan_ref: 'db://flow-execution-plan/plan_1',
      tenant_id: 'tenant_1',
      flow_id: 'flow_1',
      flow_version: 1,
      flow_sha256: hash,
      flow_spec: flowSpec,
      agents: [
        {
          step_id: 'agent',
          agent_id: 'agent_1',
          agent_version: 2,
          agent_sha256: hash,
          prompt_id: 'prompt_1',
          prompt_version: 3,
          prompt_sha256: hash,
          model_policy: 'mock',
          allowed_tools: ['knowledge.search'],
          budget: { max_steps: 4, max_tokens: 1000 },
        },
      ],
      tools: [
        {
          step_id: 'search',
          tool_name: 'knowledge.search',
          tool_version: '1.0.0',
          tool_sha256: hash,
          risk_level: 'L1',
        },
      ],
      allowed_tools: ['knowledge.search'],
      budget: { max_steps: 4, max_tokens: 1000 },
      generated_at: '2026-01-01T00:00:00.000Z',
      execution_plan_hash: hash,
    });

    expect(plan.agents[0]?.prompt_version).toBe(3);
    expect(plan.tools[0]?.tool_sha256).toBe(hash);
    expect(() => flowExecutionPlanSchema.parse({ ...plan, flow_sha256: 'not-a-sha' })).toThrow();
  });

  it('validates Pi agent runtime DTOs without hidden reasoning fields', () => {
    const hash = 'b'.repeat(64);
    const budget = agentBudgetSchema.parse({ max_segments: 3, max_model_turns: 6, max_tool_calls: 2, max_total_tokens: 1000 });
    const allowedTool = {
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      tool_sha256: hash,
      description: 'Search knowledge',
      risk_level: 'L1',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    };
    const plan = resolvedAgentPlanSchema.parse({
      agent_id: 'agent_1',
      agent_version: 1,
      agent_sha256: hash,
      prompt_id: 'prompt_1',
      prompt_version: 1,
      prompt_sha256: hash,
      system_prompt: 'Answer with tools when useful.',
      model_policy: 'deterministic:readonly_tool',
      allowed_tools: [allowedTool],
      allowed_handoffs: ['db://flow-execution-plan/child'],
      budget,
    });
    const executionPlan = agentExecutionPlanSchema.parse({
      execution_plan_id: 'agent_plan_1',
      execution_plan_ref: 'db://agent-execution-plan/agent_plan_1',
      tenant_id: 'tenant_1',
      agent_id: 'agent_1',
      agent_version: 1,
      agent_sha256: hash,
      prompt_id: 'prompt_1',
      prompt_version: 1,
      prompt_sha256: hash,
      model_policy: 'deterministic:readonly_tool',
      allowed_tools: [allowedTool],
      allowed_handoffs: ['db://flow-execution-plan/child'],
      budget,
      plan,
      generated_at: '2026-01-01T00:00:00.000Z',
      execution_plan_hash: hash,
    });
    expect(JSON.stringify(executionPlan)).not.toMatch(/api[_-]?key|authorization|chain_of_thought|hidden_reasoning|internal_reasoning/i);

    expect(proposedToolCallSchema.parse({
      call_id: 'call_1',
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      tool_sha256: hash,
      arguments: { query: 'durable runtime' },
      risk_level: 'L1',
      requires_confirmation: false,
      source_order: 0,
    }).arguments).toEqual({ query: 'durable runtime' });
    expect(() => proposedToolCallSchema.parse({
      call_id: 'call_1',
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      tool_sha256: hash,
      arguments: 'not-object',
      risk_level: 'L1',
      source_order: 0,
    })).toThrow();
    expect(() => proposedToolCallSchema.parse({
      call_id: 'call_1',
      tool_name: 'knowledge.search',
      tool_version: '1.0.0',
      tool_sha256: hash,
      arguments: {},
      reason_summary: 'x'.repeat(2001),
      risk_level: 'L1',
      source_order: 0,
    })).toThrow();

    expect(piSegmentResultSchema.parse({
      status: 'tool_requested',
      proposed_tool_calls: [{
        call_id: 'call_1',
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        tool_sha256: hash,
        arguments: { query: 'durable runtime' },
        risk_level: 'L1',
        requires_confirmation: false,
        source_order: 0,
      }],
      context_snapshot_ref: {
        snapshot_id: 'snapshot_1',
        schema_version: 'pi-context/v1',
        snapshot_hash: hash,
        message_count: 3,
        byte_size: 400,
      },
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      model_turn_count: 1,
    }).status).toBe('tool_requested');

    expect(agentRunRecordSchema.parse({
      agent_run_id: 'agent_run_1',
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      task_run_id: 'task_1',
      workflow_id: 'wf_1',
      execution_plan_ref: executionPlan.execution_plan_ref,
      execution_plan_hash: hash,
      agent_id: 'agent_1',
      agent_version: 1,
      prompt_id: 'prompt_1',
      prompt_version: 1,
      model: 'deterministic:readonly_tool',
      execution_mode: 'mediated_tool_call',
      status: 'running',
    }).current_segment_index).toBe(0);

    expect(agentStepRecordSchema.parse({
      agent_step_id: 'step_1',
      agent_run_id: 'agent_run_1',
      segment_index: 0,
      stable_step_key: 'agent_run_1:0',
      segment_status: 'tool_requested',
      decision_summary: 'Need a read-only lookup.',
      proposed_tool_calls: [{
        call_id: 'call_1',
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        tool_sha256: hash,
        arguments: { query: 'durable runtime' },
        risk_level: 'L1',
        source_order: 0,
      }],
    }).segment_status).toBe('tool_requested');

    expect(humanTaskRespondRequestSchema.parse({
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      response_idempotency_key: 'response_1',
      response: { answer: 'yes' },
    }).response).toEqual({ answer: 'yes' });
  });

  it('validates control-plane management API DTOs', () => {
    expect(paginationRequestSchema.parse({ page: '2', page_size: '10' })).toMatchObject({
      page: 2,
      page_size: 10,
      sort_order: 'desc',
    });
    expect(registryListRequestSchema.parse({ status: 'published', keyword: 'flow' }).page).toBe(1);
    expect(createDraftRequestSchema.parse({ spec: { prompt_id: 'prompt_1' } }).spec).toMatchObject({
      prompt_id: 'prompt_1',
    });
    expect(updateDraftRequestSchema.parse({
      spec: { prompt_id: 'prompt_1' },
      expected_revision: 3,
    }).expected_revision).toBe(3);
    expect(() => updateDraftRequestSchema.parse({ spec: {} })).toThrow();
    expect(cloneVersionRequestSchema.parse({ version: 2 }).version).toBe(2);
    expect(validateResourceRequestSchema.parse({})).toEqual({ include_warnings: true });

    const validation = {
      valid: true,
      can_publish: true,
      errors: [],
      warnings: [],
      dependency_graph: { nodes: [], edges: [] },
    };
    expect(validateResourceResponseSchema.parse({ validation }).validation.can_publish).toBe(true);
    expect(publishResourceRequestSchema.parse({ release_note: 'publish v1' }).metadata_json).toEqual({});
    expect(grayResourceRequestSchema.parse({
      release_note: 'gray v2',
      tenant_allowlist: ['tenant_1'],
    }).tenant_allowlist).toEqual(['tenant_1']);
    expect(rollbackResourceRequestSchema.parse({
      target_version: 1,
      release_note: 'rollback v1',
    }).target_version).toBe(1);

    const release = {
      release_id: 'release_1',
      tenant_id: 'tenant_1',
      resource_type: 'flow',
      resource_id: 'flow_1',
      resource_version: 1,
      action: 'publish',
      target_status: 'published',
      operator_id: 'operator_1',
      validation_result: validation,
      metadata_json: {},
    };
    expect(capabilityReleaseResponseSchema.parse({ release }).release.action).toBe('publish');
    expect(releaseListRequestSchema.parse({
      resource_type: 'flow',
      page: 1,
      page_size: 20,
    }).resource_type).toBe('flow');
  });

  it('validates operation query and standard API response DTOs', () => {
    expect(operationAuditQuerySchema.parse({
      tenant_id: 'tenant_1',
      event_type: 'tool.invoke',
      page_size: '5',
    }).page_size).toBe(5);
    expect(toolCallQuerySchema.parse({ tenant_id: 'tenant_1', status: 'committed' }).status).toBe('committed');
    expect(taskRunQuerySchema.parse({ tenant_id: 'tenant_1', status: 'running' }).status).toBe('running');
    expect(dashboardSummaryResponseSchema.parse({
      registry_counts: {
        flows_published: 1,
        routes_published: 1,
        tools_published: 1,
        agents_published: 1,
        prompts_published: 1,
      },
      pending_human_task_count: 0,
      running_task_count: 0,
      waiting_human_task_count: 0,
      failed_task_count: 0,
      recent_releases: [],
      recent_failed_tasks: [],
    }).registry_counts.flows_published).toBe(1);
    expect(standardErrorResponseSchema.parse({
      success: false,
      data: null,
      error: { code: 'FORBIDDEN', message: 'Permission denied' },
      trace_id: 'req_1',
    }).error.code).toBe('FORBIDDEN');
    expect(standardApiResponseSchema.parse({
      success: true,
      data: { ok: true },
      error: null,
    }).success).toBe(true);
  });
});
