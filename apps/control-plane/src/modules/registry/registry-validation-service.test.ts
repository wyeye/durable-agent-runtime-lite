import { describe, expect, it } from 'vitest';
import type { AgentSpec, FlowSpec, PromptDefinition, RegistryValidationIssue, RouteSpec, ToolManifest } from '@dar/contracts';
import { RegistryValidationService } from './registry-validation-service.js';

class FakeRepository<T extends object> {
  getLatestVersionCalls = 0;

  constructor(private readonly records: Map<string, { version: number; status: string; spec: T }>) {}

  async getLatestVersion(id: string) {
    this.getLatestVersionCalls += 1;
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${id}@`))
      .map(([, value]) => value)
      .sort((left, right) => right.version - left.version)[0];
  }

  async getByIdAndVersion(id: string, version: number) {
    return this.records.get(`${id}@${version}`);
  }

  async list() {
    return [...this.records.values()];
  }
}

const prompt: PromptDefinition = {
  prompt_id: 'sample_prompt',
  version: 1,
  name: 'Prompt',
  content: 'Hello {{name}}',
  variables: ['name'],
  status: 'published',
};

const knowledgeTool: ToolManifest = {
  tool_name: 'knowledge.search',
  version: '1.0.0',
  risk_level: 'L1',
  side_effect: false,
  adapter: { type: 'mock' },
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  required_permissions: [],
  status: 'published',
};

const l3Tool: ToolManifest = {
  tool_name: 'record.write.mock',
  version: '1.0.0',
  risk_level: 'L3',
  side_effect: true,
  adapter: { type: 'mock' },
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  required_permissions: [],
  status: 'published',
};

const l4Tool: ToolManifest = {
  tool_name: 'secret.rotate',
  version: '1.0.0',
  risk_level: 'L4',
  side_effect: true,
  adapter: { type: 'mock' },
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  required_permissions: [],
  status: 'published',
};

const agent: AgentSpec = {
  agent_id: 'sample_agent',
  version: 1,
  prompt_ref: 'sample_prompt@1',
  model_policy: 'mock',
  allowed_tools: ['knowledge.search@1.0.0', 'record.write.mock@1.0.0'],
  allowed_handoffs: [],
  max_steps: 4,
  max_tokens: 2000,
  status: 'published',
};

function service(overrides: Partial<{
  flows: FakeRepository<FlowSpec>;
  routes: FakeRepository<RouteSpec>;
  tools: FakeRepository<ToolManifest>;
  agents: FakeRepository<AgentSpec>;
  prompts: FakeRepository<PromptDefinition>;
}> = {}) {
  return new RegistryValidationService({
    flows: (overrides.flows ?? new FakeRepository<FlowSpec>(new Map([['sample_flow@1', { version: 1, status: 'published', spec: sampleFlow() }]]))) as never,
    routes: (overrides.routes ?? new FakeRepository<RouteSpec>(new Map())) as never,
    tools: (overrides.tools ?? new FakeRepository<ToolManifest>(new Map([
      ['knowledge.search@1', { version: 1, status: 'published', spec: knowledgeTool }],
      ['record.write.mock@1', { version: 1, status: 'published', spec: l3Tool }],
      ['secret.rotate@1', { version: 1, status: 'published', spec: l4Tool }],
    ]))) as never,
    agents: (overrides.agents ?? new FakeRepository<AgentSpec>(new Map([['sample_agent@1', { version: 1, status: 'published', spec: agent }]]))) as never,
    prompts: (overrides.prompts ?? new FakeRepository<PromptDefinition>(new Map([['sample_prompt@1', { version: 1, status: 'published', spec: prompt }]]))) as never,
  });
}

function sampleFlow(): FlowSpec {
  return {
    flow_id: 'sample_flow',
    version: 1,
    status: 'draft',
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    steps: [
      { id: 'search', type: 'tool', tool: 'knowledge.search', input: { query: '${input.text}' } },
      { id: 'plan', type: 'agent', agent_id: 'sample_agent', input: { agent_version: 1 } },
      { id: 'write', type: 'tool', tool: 'record.write.mock', tool_version: '1.0.0', mode: 'preview_commit', input: { record: '${state.steps.search.result}' } },
    ],
  };
}

describe('RegistryValidationService', () => {
  it('validates Flow dependencies and L3/L4 tool rules', async () => {
    const valid = sampleFlow();
    valid.steps[0] = { id: 'search', type: 'tool', tool: 'knowledge.search', tool_version: '1.0.0', input: { query: '${input.text}' } };
    const tools = new FakeRepository<ToolManifest>(new Map([
      ['knowledge.search@1', { version: 1, status: 'published', spec: knowledgeTool }],
      ['record.write.mock@1', { version: 1, status: 'published', spec: l3Tool }],
      ['secret.rotate@1', { version: 1, status: 'published', spec: l4Tool }],
      ['knowledge.search@2', { version: 2, status: 'published', spec: { ...knowledgeTool, version: '2.0.0' } }],
    ]));
    const result = await service({ tools }).validateFlow(valid);
    expect(result.can_publish).toBe(true);
    expect(tools.getLatestVersionCalls).toBe(0);
    expect(result.dependency_graph.nodes.map((node: { resource_id: string }) => node.resource_id)).toContain('record.write.mock');

    const missingVersion = sampleFlow();
    const missingVersionResult = await service().validateFlow(missingVersion);
    expect(missingVersionResult.errors.map((error: RegistryValidationIssue) => error.code)).toContain('FLOW_TOOL_VERSION_REQUIRED');

    const invalid = valid;
    invalid.steps.push({ id: 'secret', type: 'tool', tool: 'secret.rotate', tool_version: '1.0.0', mode: 'preview_commit' });
    const invalidResult = await service().validateFlow(invalid);
    expect(invalidResult.errors.map((error: RegistryValidationIssue) => error.code)).toContain('FLOW_L4_TOOL_AUTO_EXECUTION_DENIED');
  });

  it('validates Route thresholds and conflict warnings', async () => {
    const routes = new FakeRepository<RouteSpec>(new Map([
      ['existing@1', {
        version: 1,
        status: 'published',
        spec: {
          route_id: 'existing',
          flow_id: 'sample_flow',
          version: 1,
          status: 'published',
          route: { keywords: ['shared'], examples: [], negative_examples: [], supported_channels: [], role_constraints: [], priority: 50, confidence_threshold: 0.7, ambiguous_threshold: 0.5 },
        },
      }],
    ]));
    const route: RouteSpec = {
      route_id: 'new_route',
      flow_id: 'sample_flow',
      version: 1,
      status: 'draft',
      route: { keywords: ['shared'], examples: [], negative_examples: [], supported_channels: [], role_constraints: [], priority: 50, confidence_threshold: 0.2, ambiguous_threshold: 0.5 },
    };
    const result = await service({ routes }).validateRoute(route);
    expect(result.errors.map((error: RegistryValidationIssue) => error.code)).toContain('ROUTE_THRESHOLD_ORDER_INVALID');
    expect(result.warnings.map((warning: RegistryValidationIssue) => warning.code)).toContain('ROUTE_PUBLISHED_CONFLICT_WARNING');
  });

  it('validates Tool L3/L4 and secret constraints', async () => {
    const l3Invalid = { ...l3Tool, side_effect: false };
    const result = await service().validateTool(l3Invalid);
    expect(result.errors.map((error: RegistryValidationIssue) => error.code)).toContain('TOOL_L3_REQUIRES_SIDE_EFFECT');

    const secretResult = await service().validateTool({
      ...knowledgeTool,
      adapter: { type: 'http', config: { api_key: 'sk_test_secret_value' } },
    });
    expect(secretResult.errors.map((error: RegistryValidationIssue) => error.code)).toContain('TOOL_MANIFEST_CONTAINS_SECRET');
  });

  it('validates Agent and Prompt dependencies', async () => {
    const missingPrompt = { ...agent, prompt_ref: 'missing@1' };
    const agentResult = await service().validateAgent(missingPrompt);
    expect(agentResult.errors.map((error: RegistryValidationIssue) => error.code)).toContain('AGENT_PROMPT_NOT_FOUND');

    const invalidToolRef = { ...agent, allowed_tools: ['knowledge.search'] };
    const invalidToolResult = await service().validateAgent(invalidToolRef);
    expect(invalidToolResult.errors.map((error: RegistryValidationIssue) => error.code)).toContain('AGENT_TOOL_REF_INVALID');

    const promptResult = await service().validatePrompt({ ...prompt, variables: ['bad-name'] });
    expect(promptResult.errors.map((error: RegistryValidationIssue) => error.code)).toContain('PROMPT_VARIABLE_INVALID');
  });
});
