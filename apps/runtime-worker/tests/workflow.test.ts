import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { FlowSpec, HumanTask } from '@dar/contracts';
import { loadFlowSpecByRefActivity } from '../src/activities/index.js';
import { executeFlowSpec, resolveToolArguments } from '../src/interpreter/flow-interpreter.js';

const flow: FlowSpec = {
  flow_id: 'sample_flow',
  version: 1,
  runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
  steps: [
    { id: 'input_normalize', type: 'activity', activity: 'input.normalize' },
    { id: 'knowledge_search', type: 'tool', tool: 'knowledge.search' },
    { id: 'agent_plan', type: 'agent', agent_id: 'sample_agent' },
    { id: 'record_write', type: 'tool', tool: 'record.write.mock', risk_level: 'L1' },
  ],
};

describe('runtime-worker flow interpreter', () => {
  it('runs sample flow through activity/tool/agent/tool steps', async () => {
    const result = await executeFlowSpec(
      flow,
      {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        task_run_id: 'task_1',
        workflow_id: 'wf_1',
        request_id: 'req_1',
      },
      { text: 'hello' },
      {
        normalizeInput: async (input) => ({ normalized: true, input }),
        invokeTool: async (_context, toolName) => ({
          tool_name: toolName,
          tool_version: '1.0.0',
          status: 'succeeded',
          result: { toolName },
        }),
        previewTool: async (_context, toolName) => ({
          tool_call_id: 'tool_call_unused',
          tool_name: toolName,
          tool_version: '1.0.0',
          mode: 'preview',
          status: 'allowed',
          policy: {
            decision: 'allow',
            risk_level: 'L1',
            reason: 'test',
            requires_human_confirm: false,
          },
        }),
        commitTool: async (_context, toolCallId, toolName) => ({
          tool_call_id: toolCallId,
          tool_name: toolName,
          tool_version: '1.0.0',
          mode: 'commit',
          status: 'committed',
        }),
        runAgent: async () => ({ status: 'final', final_answer: 'ok', proposed_tool_calls: [], usage: {} }),
        createHumanTask: async () => humanTask({ status: 'pending' }),
        waitForHumanTaskDecision: async () => humanTask({ status: 'approved' }),
      },
    );

    expect(result.status).toBe('completed');
    expect(result.steps.knowledge_search).toMatchObject({ tool_name: 'knowledge.search' });
    expect(result.steps.record_write).toMatchObject({ tool_name: 'record.write.mock' });
  });

  it('loads sample FlowSpec by snapshot ref through Activity', async () => {
    const loaded = await loadFlowSpecByRefActivity('sample_flow@1');
    expect(loaded.flow_id).toBe('sample_flow');
    expect(loaded.version).toBe(1);
  });

  it('does not load sample FlowSpec ref in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      await expect(loadFlowSpecByRefActivity('sample_flow@1')).rejects.toThrow(
        'Unknown flow snapshot ref: sample_flow@1',
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it('resolves tool step arguments from workflow input, previous step result, state, and literals', async () => {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const mappedFlow: FlowSpec = {
      flow_id: 'mapped_flow',
      version: 1,
      runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
      steps: [
        {
          id: 'retrieve_context',
          type: 'tool',
          tool: 'knowledge.search',
          input: { query: '${input.query}', source: 'literal' },
        },
        {
          id: 'record_write',
          type: 'tool',
          tool: 'record.write.mock',
          input: {
            record: '${state.steps.retrieve_context.result}',
            state_snapshot: '${state}',
          },
        },
      ],
    };

    await executeFlowSpec(
      mappedFlow,
      {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        task_run_id: 'task_1',
        workflow_id: 'wf_1',
        request_id: 'req_1',
      },
      { query: 'db-backed query' },
      {
        normalizeInput: async (input) => ({ normalized: true, input }),
        invokeTool: async (_context, toolName, args) => {
          calls.push({ toolName, args });
          return {
            tool_name: toolName,
            tool_version: '1.0.0',
            status: 'succeeded',
            result: { toolName, args },
          };
        },
        previewTool: async (_context, toolName) => ({
          tool_call_id: 'tool_call_unused',
          tool_name: toolName,
          tool_version: '1.0.0',
          mode: 'preview',
          status: 'allowed',
          policy: {
            decision: 'allow',
            risk_level: 'L1',
            reason: 'test',
            requires_human_confirm: false,
          },
        }),
        commitTool: async (_context, toolCallId, toolName) => ({
          tool_call_id: toolCallId,
          tool_name: toolName,
          tool_version: '1.0.0',
          mode: 'commit',
          status: 'committed',
        }),
        runAgent: async () => ({ status: 'final', final_answer: 'ok', proposed_tool_calls: [], usage: {} }),
        createHumanTask: async () => humanTask({ status: 'pending' }),
        waitForHumanTaskDecision: async () => humanTask({ status: 'approved' }),
      },
    );

    expect(calls[0]).toEqual({
      toolName: 'knowledge.search',
      args: { query: 'db-backed query', source: 'literal' },
    });
    expect(calls[1]?.toolName).toBe('record.write.mock');
    expect(calls[1]?.args.record).toMatchObject({
      tool_name: 'knowledge.search',
      result: { toolName: 'knowledge.search' },
    });
    expect(calls[1]?.args.state_snapshot).toMatchObject({
      input: { query: 'db-backed query' },
      retrieve_context: { tool_name: 'knowledge.search' },
    });
  });

  it('supports expression resolver directly for previous step result paths', () => {
    const args = resolveToolArguments(
      { query: '${input.query}', record: '${state.steps.retrieve_context.result}', fixed: 'literal' },
      { steps: { retrieve_context: { result: { items: ['doc_1'] } } } },
      { query: 'hello' },
    );

    expect(args).toEqual({ query: 'hello', record: { items: ['doc_1'] }, fixed: 'literal' });
  });

  it('enters pending confirmation for L3 tool steps before commit', async () => {
    let humanTaskInput: unknown;
    const result = await executeFlowSpec(
      l3Flow,
      context(),
      { query: 'db-backed query' },
      {
        normalizeInput: async (input) => ({ normalized: true, input }),
        invokeTool: async () => {
          throw new Error('L3 flow should not directly invoke');
        },
        previewTool: async (_context, toolName, args) => ({
          tool_call_id: 'tool_call_l3_1',
          tool_name: toolName,
          tool_version: '1.0.0',
          mode: 'preview',
          status: 'pending_confirmation',
          preview: { args },
          policy: {
            decision: 'require_human_confirm',
            risk_level: 'L3',
            reason: 'side_effect_requires_human_confirm',
            requires_human_confirm: true,
          },
        }),
        commitTool: async () => {
          throw new Error('pending decision should not commit');
        },
        runAgent: async () => ({ status: 'final', final_answer: 'ok', proposed_tool_calls: [], usage: {} }),
        createHumanTask: async (_context, input) => {
          humanTaskInput = input;
          return humanTask({ status: 'pending' });
        },
        waitForHumanTaskDecision: async () => humanTask({ status: 'pending' }),
      },
    );

    expect(result.status).toBe('waiting_human');
    expect(result.steps.record_write).toMatchObject({
      status: 'pending_confirmation',
      preview: { tool_call_id: 'tool_call_l3_1' },
    });
    expect(humanTaskInput).toMatchObject({
      tool_call_id: 'tool_call_l3_1',
      tool_name: 'record.write.mock',
    });
  });

  it('commits L3 tool steps after approval', async () => {
    const calls: string[] = [];
    const result = await executeFlowSpec(
      l3Flow,
      context(),
      { query: 'db-backed query' },
      {
        normalizeInput: async (input) => ({ normalized: true, input }),
        invokeTool: async () => {
          throw new Error('L3 flow should not directly invoke');
        },
        previewTool: async (_context, toolName) => {
          calls.push('preview');
          return {
            tool_call_id: 'tool_call_l3_1',
            tool_name: toolName,
            tool_version: '1.0.0',
            mode: 'preview',
            status: 'pending_confirmation',
            policy: {
              decision: 'require_human_confirm',
              risk_level: 'L3',
              reason: 'side_effect_requires_human_confirm',
              requires_human_confirm: true,
            },
          };
        },
        commitTool: async (_context, toolCallId, toolName) => {
          calls.push('commit');
          return {
            tool_call_id: toolCallId,
            tool_name: toolName,
            tool_version: '1.0.0',
            mode: 'commit',
            status: 'committed',
            result: { written: true },
          };
        },
        runAgent: async () => ({ status: 'final', final_answer: 'ok', proposed_tool_calls: [], usage: {} }),
        createHumanTask: async () => humanTask({ status: 'pending' }),
        waitForHumanTaskDecision: async () => humanTask({ status: 'approved' }),
      },
    );

    expect(result.status).toBe('completed');
    expect(calls).toEqual(['preview', 'commit']);
    expect(result.steps.record_write).toMatchObject({
      status: 'committed',
      commit: { status: 'committed', result: { written: true } },
    });
  });

  it('does not commit L3 tool steps after rejection', async () => {
    let committed = false;
    const result = await executeFlowSpec(
      l3Flow,
      context(),
      { query: 'db-backed query' },
      {
        normalizeInput: async (input) => ({ normalized: true, input }),
        invokeTool: async () => {
          throw new Error('L3 flow should not directly invoke');
        },
        previewTool: async (_context, toolName) => ({
          tool_call_id: 'tool_call_l3_1',
          tool_name: toolName,
          tool_version: '1.0.0',
          mode: 'preview',
          status: 'pending_confirmation',
          policy: {
            decision: 'require_human_confirm',
            risk_level: 'L3',
            reason: 'side_effect_requires_human_confirm',
            requires_human_confirm: true,
          },
        }),
        commitTool: async () => {
          committed = true;
          throw new Error('rejected decision should not commit');
        },
        runAgent: async () => ({ status: 'final', final_answer: 'ok', proposed_tool_calls: [], usage: {} }),
        createHumanTask: async () => humanTask({ status: 'pending' }),
        waitForHumanTaskDecision: async () => humanTask({ status: 'rejected' }),
      },
    );

    expect(result.status).toBe('failed');
    expect(result.error_code).toBe('HUMAN_TASK_REJECTED');
    expect(result.error_message).toContain('Human task rejected');
    expect(committed).toBe(false);
    expect(result.steps.record_write).toMatchObject({
      status: 'rejected',
      human_task: { status: 'rejected' },
    });
  });

  it('keeps workflow modules free of direct activity and Pi implementations', async () => {
    const configWorkflowSource = await readFile(new URL('../src/workflows/config-driven-workflow.ts', import.meta.url), 'utf8');
    const genericWorkflowSource = await readFile(new URL('../src/workflows/generic-agent-workflow.ts', import.meta.url), 'utf8');

    expect(configWorkflowSource).not.toContain('../activities/index.js');
    expect(genericWorkflowSource).not.toContain('../pi/pi-runner.js');
    expect(configWorkflowSource).not.toContain('@dar/db');
    expect(genericWorkflowSource).not.toContain('@dar/db');
  });
});

const l3Flow: FlowSpec = {
  flow_id: 'sample_flow',
  version: 1,
  runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
  steps: [
    { id: 'record_write', type: 'tool', tool: 'record.write.mock', risk_level: 'L3' },
  ],
};

function context() {
  return {
    tenant_id: 'tenant_1',
    user_id: 'user_1',
    task_run_id: 'task_1',
    workflow_id: 'wf_1',
    request_id: 'req_1',
  };
}

function humanTask(input: { status: HumanTask['status'] }): HumanTask {
  return {
    human_task_id: 'human_1',
    tenant_id: 'tenant_1',
    task_run_id: 'task_1',
    workflow_id: 'wf_1',
    status: input.status,
    candidate_groups: [],
    payload: { tool_call_id: 'tool_call_l3_1' },
    created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
  };
}
