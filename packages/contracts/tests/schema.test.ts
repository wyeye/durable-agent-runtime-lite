import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  agentRunRequestSchema,
  agentRunResultSchema,
  flowSpecSchema,
  humanTaskCreateRequestSchema,
  humanTaskDecisionRequestSchema,
  humanTaskDecisionResponseSchema,
  humanTaskGetRequestSchema,
  humanTaskGetResponseSchema,
  humanTaskListRequestSchema,
  humanTaskListResponseSchema,
  promptDefinitionSchema,
  policyEvaluationResultSchema,
  routeSpecSchema,
  runtimeContextSchema,
  toolCallLogSchema,
  toolCommitRequestSchema,
  toolCommitResponseSchema,
  toolManifestSchema,
  toolPreviewRequestSchema,
  toolPreviewResponseSchema,
  workflowStartRequestSchema,
} from '../src/index.js';

async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')) as T;
}

describe('contracts schemas', () => {
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
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_1' },
      arguments: { record: { title: 'demo' } },
      idempotency_key: 'task_1:record.write.mock:commit',
    }).tool_version).toBe('1.0.0');

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
});
