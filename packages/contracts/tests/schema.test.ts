import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  agentRunRequestSchema,
  agentRunResultSchema,
  flowSpecSchema,
  promptDefinitionSchema,
  routeSpecSchema,
  runtimeContextSchema,
  toolManifestSchema,
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

});
