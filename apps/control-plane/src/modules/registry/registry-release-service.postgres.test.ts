import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentSpec, FlowSpec, PromptDefinition, RouteSpec, ToolManifest } from '@dar/contracts';
import {
  AgentSpecRepository,
  closeDb,
  createDb,
  FlowDefinitionRepository,
  FlowExecutionPlanRepository,
  PromptDefinitionRepository,
  RouteConfigRepository,
  ToolManifestRepository,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import { RegistryReleaseService } from './registry-release-service.js';
import { RegistryValidationService } from './registry-validation-service.js';

const runPostgres = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres('RegistryReleaseService with PostgreSQL', () => {
  it('publishes transactionally, publishes Flow+Route atomically, writes release history, and rolls back without mutating target content', async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string });
    const tenantId = `tenant_${randomUUID()}`;
    const operatorId = 'operator_release_test';
    const flowId = `flow_${randomUUID()}`;
    const routeId = `route_${randomUUID()}`;
    const promptId = `prompt_${randomUUID()}`;
    const agentId = `agent_${randomUUID()}`;
    const toolName = `tool.${randomUUID()}`;

    try {
      const flows = new FlowDefinitionRepository(db);
      const routes = new RouteConfigRepository(db);
      const tools = new ToolManifestRepository(db);
      const agents = new AgentSpecRepository(db);
      const prompts = new PromptDefinitionRepository(db);
      const validation = new RegistryValidationService({ flows, routes, tools, agents, prompts });
      const releaseService = new RegistryReleaseService(db, { flows, routes, tools, agents, prompts }, validation);

      const prompt: PromptDefinition = {
        prompt_id: promptId,
        version: 1,
        name: 'Release prompt',
        content: 'hello',
        variables: [],
        status: 'published',
      };
      const tool: ToolManifest = {
        tool_name: toolName,
        version: '1.0.0',
        risk_level: 'L1',
        side_effect: false,
        adapter: { type: 'mock' },
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        required_permissions: [],
        status: 'published',
      };
      const agent: AgentSpec = {
        agent_id: agentId,
        version: 1,
        prompt_ref: `${promptId}@1`,
        model_policy: 'mock',
        allowed_tools: [`${toolName}@1.0.0`],
        max_steps: 4,
        max_tokens: 1000,
        status: 'published',
      };

      await upsertPromptDefinition(db, prompt, { tenantId, status: 'published', createdBy: operatorId });
      await new ToolManifestRepository(db).upsert(tool, { tenantId, status: 'published', createdBy: operatorId });
      await upsertAgentSpec(db, agent, { tenantId, status: 'published', createdBy: operatorId });

      const flowV1: FlowSpec = {
        flow_id: flowId,
        version: 1,
        status: 'draft',
        runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
        steps: [
          { id: 'tool', type: 'tool', tool: toolName, tool_version: '1.0.0', input: { query: '${input.text}' } },
          { id: 'agent', type: 'agent', agent_id: agentId, input: { agent_version: 1 } },
        ],
      };
      await flows.createDraft(flowV1, { tenantId, operatorId });
      const release = await releaseService.publish('flow', flowId, 1, { tenantId, operatorId, releaseNote: 'publish v1' });
      expect(release.action).toBe('publish');
      expect((await flows.getByIdAndVersion(flowId, 1, { tenantId }))?.status).toBe('published');
      const plan = await new FlowExecutionPlanRepository(db).getLatestForFlow(flowId, 1, { tenantId });
      expect(plan).toMatchObject({
        flow_id: flowId,
        flow_version: 1,
        tools: [{ tool_name: toolName, tool_version: '1.0.0', risk_level: 'L1' }],
        agents: [{ agent_id: agentId, agent_version: 1, prompt_id: promptId, prompt_version: 1 }],
      });

      await flows.cloneVersion(flowId, 1, { tenantId, operatorId });
      await releaseService.publish('flow', flowId, 2, { tenantId, operatorId, releaseNote: 'publish v2' });
      const beforeRollbackSpec = (await flows.getByIdAndVersion(flowId, 1, { tenantId }))?.spec;
      await releaseService.rollback('flow', flowId, 1, { tenantId, operatorId, releaseNote: 'rollback v1' });
      expect((await flows.getByIdAndVersion(flowId, 1, { tenantId }))?.spec).toEqual(beforeRollbackSpec);
      expect((await flows.getByIdAndVersion(flowId, 2, { tenantId }))?.status).toBe('deprecated');
      expect(await flows.listReleaseHistory(flowId, { tenantId })).toHaveLength(3);

      const flowRoute: RouteSpec = {
        route_id: routeId,
        flow_id: flowId,
        version: 1,
        status: 'draft',
        route: { keywords: ['joint-release'], examples: [], negative_examples: [], supported_channels: [], role_constraints: [], priority: 50, confidence_threshold: 0.7, ambiguous_threshold: 0.5 },
      };
      await routes.createDraft(flowRoute, { tenantId, operatorId });
      await releaseService.publishFlowWithRoute(flowId, 1, routeId, 1, { tenantId, operatorId, releaseNote: 'joint publish' });
      expect((await routes.getByIdAndVersion(routeId, 1, { tenantId }))?.status).toBe('published');

      await flows.cloneVersion(flowId, 1, { tenantId, operatorId });
      await releaseService.publish('flow', flowId, 3, { tenantId, operatorId, releaseNote: 'publish fallback v3' });
      await releaseService.setGray('flow', flowId, 1, {
        tenantId,
        operatorId,
        tenantAllowlist: [tenantId],
        userAllowlist: ['user_1'],
      });
      expect((await flows.selectVersionForRequest(flowId, { tenantId, userId: 'user_1' }))?.status).toBe('gray');
    } finally {
      await closeDb(db);
    }
  });
});
