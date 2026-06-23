import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AgentSpec,
  FlowSpec,
  ModelPolicy,
  PromptDefinition,
  RouteSpec,
  ToolManifest,
} from '@dar/contracts';
import {
  AgentSpecRepository,
  closeDb,
  createDb,
  FlowDefinitionRepository,
  FlowExecutionPlanRepository,
  ModelDefinitionRepository,
  ModelGatewayProfileRepository,
  ModelPolicyRepository,
  PromptDefinitionRepository,
  RouteConfigRepository,
  ToolManifestRepository,
  hashModelPolicy,
  type Database,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import type { Kysely } from 'kysely';
import { RegistryReleaseService } from './registry-release-service.js';
import { RegistryValidationService } from './registry-validation-service.js';
import type { PreparedRouteEmbeddingIndex, RouteEmbeddingIndexService } from './route-embedding-index-service.js';

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
    const modelPolicyId = `model_policy_${randomUUID()}`;
    const toolName = `tool.${randomUUID()}`;

    try {
      const flows = new FlowDefinitionRepository(db);
      const routes = new RouteConfigRepository(db);
      const tools = new ToolManifestRepository(db);
      const agents = new AgentSpecRepository(db);
      const prompts = new PromptDefinitionRepository(db);
      const validation = new RegistryValidationService({ flows, routes, tools, agents, prompts });
      const releaseService = new RegistryReleaseService(
        db,
        { flows, routes, tools, agents, prompts },
        validation,
      );
      const profile = await new ModelGatewayProfileRepository(db).createDraft({
        profile_id: `gateway_${randomUUID()}`,
        display_name: 'Release test gateway',
        protocol: 'openai_chat_completions',
        base_url: 'https://model.example.test/v1',
        auth_type: 'none',
        operatorId,
      });
      const publishedProfile = await new ModelGatewayProfileRepository(db).publish(profile.profile_id, {
        operatorId,
      });
      const model = await new ModelDefinitionRepository(db).createDraft({
        operatorId,
        model: {
          model_id: `model_${randomUUID()}`,
          version: 1,
          display_name: 'Release test model',
          gateway_profile_id: publishedProfile.profile_id,
          upstream_model_id: 'mock-upstream',
          provider: 'mock',
          capabilities: ['text', 'tools', 'usage'],
          context_window: 8192,
          max_output_tokens: 1024,
          input_cost_per_million: 0,
          output_cost_per_million: 0,
          currency: 'USD',
          tags: ['test'],
        },
      });
      const publishedModel = await new ModelDefinitionRepository(db).publish(model.model_id, model.version, {
        operatorId,
      });

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
      const modelPolicy: ModelPolicy = {
        model_policy_id: modelPolicyId,
        version: 1,
        status: 'published',
        protocol: 'openai_chat_completions',
        targets: [
          {
            target_id: `${modelPolicyId}_primary`,
            model_ref: {
              model_id: publishedModel.model_id,
              version: publishedModel.version,
              model_hash: publishedModel.model_hash,
            },
            priority: 0,
            enabled: true,
          },
        ],
        retry_policy: {
          max_attempts_per_target: 1,
          retryable_status_codes: [429, 500, 502, 503, 504],
          retry_on_timeout: true,
          retry_on_network_error: true,
          backoff_ms: 10,
          max_backoff_ms: 50,
        },
        fallback_policy: {
          enabled: false,
          ordered_target_ids: [],
          eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'],
          stop_on_auth_error: true,
          stop_on_validation_error: true,
          stop_on_policy_denial: true,
        },
        request_policy: {
          temperature: 0,
          top_p: 1,
          max_output_tokens: 1000,
          initial_tool_choice_mode: 'auto',
          after_tool_result_tool_choice_mode: 'auto',
          response_format: 'text',
          allow_parallel_tool_calls: false,
        },
        revision: 1,
      };
      const agent: AgentSpec = {
        agent_id: agentId,
        version: 1,
        prompt_ref: `${promptId}@1`,
        model_policy: 'mock',
        model_policy_ref: {
          model_policy_id: modelPolicy.model_policy_id,
          model_policy_version: modelPolicy.version,
          model_policy_hash: hashModelPolicy(modelPolicy),
        },
        allowed_tools: [`${toolName}@1.0.0`],
        allowed_handoffs: [],
        max_steps: 4,
        max_tokens: 1000,
        status: 'published',
      };

      await upsertPromptDefinition(db, prompt, {
        tenantId,
        status: 'published',
        createdBy: operatorId,
      });
      await new ToolManifestRepository(db).upsert(tool, {
        tenantId,
        status: 'published',
        createdBy: operatorId,
      });
      const modelPolicies = new ModelPolicyRepository(db);
      await modelPolicies.createDraft(modelPolicy, { tenantId, operatorId });
      await modelPolicies.publish(modelPolicy.model_policy_id, modelPolicy.version, {
        tenantId,
        operatorId,
        releaseNote: 'publish model policy for release test',
      });
      await upsertAgentSpec(db, agent, { tenantId, status: 'published', createdBy: operatorId });

      const flowV1: FlowSpec = {
        flow_id: flowId,
        version: 1,
        status: 'draft',
        runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
        steps: [
          {
            id: 'tool',
            type: 'tool',
            tool: toolName,
            tool_version: '1.0.0',
            input: { query: '${input.text}' },
          },
          { id: 'agent', type: 'agent', agent_id: agentId, input: { agent_version: 1 } },
        ],
      };
      await flows.createDraft(flowV1, { tenantId, operatorId });
      const release = await releaseService.publish('flow', flowId, 1, {
        tenantId,
        operatorId,
        releaseNote: 'publish v1',
      });
      expect(release.action).toBe('publish');
      expect((await flows.getByIdAndVersion(flowId, 1, { tenantId }))?.status).toBe('published');
      const plan = await new FlowExecutionPlanRepository(db).getLatestForFlow(flowId, 1, {
        tenantId,
      });
      expect(plan).toMatchObject({
        flow_id: flowId,
        flow_version: 1,
        tools: [{ tool_name: toolName, tool_version: '1.0.0', risk_level: 'L1' }],
        agents: [{ agent_id: agentId, agent_version: 1, prompt_id: promptId, prompt_version: 1 }],
      });

      await flows.cloneVersion(flowId, 1, { tenantId, operatorId });
      await releaseService.publish('flow', flowId, 2, {
        tenantId,
        operatorId,
        releaseNote: 'publish v2',
      });
      const beforeRollbackSpec = (await flows.getByIdAndVersion(flowId, 1, { tenantId }))?.spec;
      await releaseService.rollback('flow', flowId, 1, {
        tenantId,
        operatorId,
        releaseNote: 'rollback v1',
      });
      expect((await flows.getByIdAndVersion(flowId, 1, { tenantId }))?.spec).toEqual(
        beforeRollbackSpec,
      );
      expect((await flows.getByIdAndVersion(flowId, 2, { tenantId }))?.status).toBe('deprecated');
      expect(await flows.listReleaseHistory(flowId, { tenantId })).toHaveLength(3);

      const flowRoute: RouteSpec = {
        route_id: routeId,
        flow_id: flowId,
        version: 1,
        status: 'draft',
        route: {
          keywords: ['joint-release'],
          examples: [],
          negative_examples: [],
          supported_channels: [],
          role_constraints: [],
          priority: 50,
          confidence_threshold: 0.7,
          ambiguous_threshold: 0.5,
        },
      };
      await routes.createDraft(flowRoute, { tenantId, operatorId });
      await releaseService.publishFlowWithRoute(flowId, 1, routeId, 1, {
        tenantId,
        operatorId,
        releaseNote: 'joint publish',
      });
      expect((await routes.getByIdAndVersion(routeId, 1, { tenantId }))?.status).toBe('published');

      await flows.cloneVersion(flowId, 1, { tenantId, operatorId });
      await releaseService.publish('flow', flowId, 3, {
        tenantId,
        operatorId,
        releaseNote: 'publish fallback v3',
      });
      await releaseService.setGray('flow', flowId, 1, {
        tenantId,
        operatorId,
        tenantAllowlist: [tenantId],
        userAllowlist: ['user_1'],
      });
      expect(
        (await flows.selectVersionForRequest(flowId, { tenantId, userId: 'user_1' }))?.status,
      ).toBe('gray');
    } finally {
      await closeDb(db);
    }
  });

  it('validates before route indexing, replaces index inside publish transaction, and blocks rollback when target index is missing', async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string });
    const tenantId = `tenant_${randomUUID()}`;
    const operatorId = 'operator_route_index_test';
    const flowId = `flow_${randomUUID()}`;
    const routeId = `route_${randomUUID()}`;
    const flows = new FlowDefinitionRepository(db);
    const routes = new RouteConfigRepository(db);
    const tools = new ToolManifestRepository(db);
    const agents = new AgentSpecRepository(db);
    const prompts = new PromptDefinitionRepository(db);
    const validation = new RegistryValidationService({ flows, routes, tools, agents, prompts });

    try {
      await flows.createDraft(simpleFlow(flowId, 1), { tenantId, operatorId });
      await flows.markValidated(flowId, 1, { tenantId, operatorId });
      await flows.publish(flowId, 1, { tenantId, operatorId });

      const invalidIndexService = new FakeRouteEmbeddingIndexService();
      const invalidRelease = new RegistryReleaseService(
        db,
        { flows, routes, tools, agents, prompts },
        validation,
        invalidIndexService as unknown as RouteEmbeddingIndexService,
      );
      await routes.createDraft(simpleRoute(routeId, flowId, 1, {
        keywords: [],
        examples: [],
      }), { tenantId, operatorId });
      await expect(invalidRelease.publish('route', routeId, 1, {
        tenantId,
        operatorId,
        releaseNote: 'invalid route',
      })).rejects.toThrow('Registry validation failed');
      expect(invalidIndexService.calls).toEqual([]);

      await routes.updateDraft(routeId, 1, {
        tenantId,
        operatorId,
        expectedRevision: 1,
        spec: simpleRoute(routeId, flowId, 1, {
          keywords: ['route-index'],
          examples: ['route index example'],
        }),
      });
      const failingIndexService = new FakeRouteEmbeddingIndexService({ prepareError: new Error('embedding gateway unavailable') });
      const failingRelease = new RegistryReleaseService(
        db,
        { flows, routes, tools, agents, prompts },
        validation,
        failingIndexService as unknown as RouteEmbeddingIndexService,
      );
      await expect(failingRelease.publish('route', routeId, 1, {
        tenantId,
        operatorId,
        releaseNote: 'prepare fails',
      })).rejects.toThrow('embedding gateway unavailable');
      expect((await routes.getByIdAndVersion(routeId, 1, { tenantId }))?.status).toBe('draft');
      expect(failingIndexService.calls).toEqual(['prepare']);

      const indexService = new FakeRouteEmbeddingIndexService({ originalDb: db });
      const release = new RegistryReleaseService(
        db,
        { flows, routes, tools, agents, prompts },
        validation,
        indexService as unknown as RouteEmbeddingIndexService,
      );
      await release.publish('route', routeId, 1, {
        tenantId,
        operatorId,
        releaseNote: 'publish with index',
      });
      expect(indexService.calls).toEqual(['prepare', 'replace']);
      expect(indexService.preparedRouteConfigSha256).toMatch(/^[a-f0-9]{64}$/u);
      const routeV1IndexHash = (await routes.getByIdAndVersion(routeId, 1, { tenantId }))?.sha256;
      expect(routeV1IndexHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(indexService.replaceUsedOriginalDb).toBe(false);
      expect(indexService.statusDuringReplace).toBe('published');

      await flows.cloneVersion(flowId, 1, { tenantId, operatorId });
      await flows.markValidated(flowId, 2, { tenantId, operatorId });
      await flows.publish(flowId, 2, { tenantId, operatorId });
      await routes.cloneVersion(routeId, 1, { tenantId, operatorId });
      await release.publish('route', routeId, 2, {
        tenantId,
        operatorId,
        releaseNote: 'publish v2 with index',
      });
      indexService.hasRouteIndexResult = false;
      await expect(release.rollback('route', routeId, 1, {
        tenantId,
        operatorId,
        releaseNote: 'rollback missing index',
      })).rejects.toThrow('ROUTE_EMBEDDING_NOT_READY');
      expect(indexService.checkedRouteConfigSha256).toBe(routeV1IndexHash);
      expect((await routes.getByIdAndVersion(routeId, 2, { tenantId }))?.status).toBe('published');
      expect(indexService.calls.at(-1)).toBe('has');
    } finally {
      await closeDb(db);
    }
  });
});

class FakeRouteEmbeddingIndexService {
  readonly calls: string[] = [];
  preparedRouteConfigSha256: string | undefined;
  checkedRouteConfigSha256: string | undefined;
  hasRouteIndexResult = true;
  replaceUsedOriginalDb: boolean | undefined;
  statusDuringReplace: string | undefined;

  constructor(private readonly options: { prepareError?: Error; originalDb?: Kysely<Database> } = {}) {}

  async prepare(route: RouteSpec, routeConfigSha256: string): Promise<PreparedRouteEmbeddingIndex> {
    this.calls.push('prepare');
    this.preparedRouteConfigSha256 = routeConfigSha256;
    if (this.options.prepareError) {
      throw this.options.prepareError;
    }
    return {
      routeId: route.route_id ?? `${route.flow_id}@${route.version}`,
      flowVersion: route.version,
      routeConfigSha256,
      embeddingModelId: 'embedding-model',
      embeddingModelVersion: 1,
      embeddingModelHash: 'b'.repeat(64),
      sourceCount: route.route.keywords.length + route.route.examples.length,
      rows: [],
    };
  }

  async replacePrepared(index: PreparedRouteEmbeddingIndex, tenantId: string, trx: Kysely<Database>): Promise<void> {
    this.calls.push('replace');
    this.replaceUsedOriginalDb = trx === this.options.originalDb;
    this.statusDuringReplace = (await new RouteConfigRepository(trx).getByIdAndVersion(index.routeId, index.flowVersion, {
      tenantId,
    }))?.status;
  }

  async hasRouteIndex(_route: RouteSpec, routeConfigSha256: string): Promise<boolean> {
    this.calls.push('has');
    this.checkedRouteConfigSha256 = routeConfigSha256;
    return this.hasRouteIndexResult;
  }
}

function simpleFlow(flowId: string, version: number): FlowSpec {
  return {
    flow_id: flowId,
    version,
    status: 'draft',
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    steps: [{ id: 'activity', type: 'activity', activity: 'noop' }],
  };
}

function simpleRoute(
  routeId: string,
  flowId: string,
  version: number,
  matchSignals: { keywords: string[]; examples: string[] },
): RouteSpec {
  return {
    route_id: routeId,
    flow_id: flowId,
    version,
    status: 'draft',
    route: {
      keywords: matchSignals.keywords,
      examples: matchSignals.examples,
      negative_examples: [],
      supported_channels: [],
      role_constraints: [],
      priority: 50,
      confidence_threshold: 0.7,
      ambiguous_threshold: 0.5,
    },
  };
}
