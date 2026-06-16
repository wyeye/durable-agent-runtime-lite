import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { FlowSpec } from '@dar/contracts';
import { loadFlowSpecByRefActivity } from '../src/activities/index.js';
import { executeFlowSpec } from '../src/interpreter/flow-interpreter.js';

const flow: FlowSpec = {
  flow_id: 'sample_flow',
  version: 1,
  runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
  steps: [
    { id: 'input_normalize', type: 'activity', activity: 'input.normalize' },
    { id: 'knowledge_search', type: 'tool', tool: 'knowledge.search' },
    { id: 'agent_plan', type: 'agent', agent_id: 'sample_agent' },
    { id: 'record_write', type: 'tool', tool: 'record.write.mock' },
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
        runAgent: async () => ({ status: 'final', final_answer: 'ok', proposed_tool_calls: [], usage: {} }),
        createHumanTask: async () => ({ human_task_id: 'human_1', status: 'created', signal_name: 'resolveHumanTask' }),
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

  it('keeps workflow modules free of direct activity and Pi implementations', async () => {
    const configWorkflowSource = await readFile(new URL('../src/workflows/config-driven-workflow.ts', import.meta.url), 'utf8');
    const genericWorkflowSource = await readFile(new URL('../src/workflows/generic-agent-workflow.ts', import.meta.url), 'utf8');

    expect(configWorkflowSource).not.toContain('../activities/index.js');
    expect(genericWorkflowSource).not.toContain('../pi/pi-runner.js');
  });
});
