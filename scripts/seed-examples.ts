import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  agentSpecSchema,
  flowSpecSchema,
  modelPolicySchema,
  promptDefinitionSchema,
  tenantRuntimePolicySchema,
  routeSpecSchema,
  toolManifestSchema,
} from '@dar/contracts';
import {
  closeDb,
  createDb,
  FlowExecutionPlanRepository,
  FlowDefinitionRepository,
  ModelPolicyRepository,
  RouteConfigRepository,
  TenantRuntimePolicyReleaseService,
  TenantRuntimePolicyRepository,
  hashModelPolicy,
  hashTenantRuntimePolicy,
  ToolManifestRepository,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';

const repoRootUrl = new URL('..', import.meta.url);
const tenantId = process.env.SEED_TENANT_ID ?? 'default';
const defaultDatabaseUrl = 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const shouldSeedLocalOllamaModelPolicy = process.env.SEED_LOCAL_OLLAMA_MODEL_POLICY === 'true';
const localOllamaModelId = 'qwen2.5:7b-instruct-q4_K_M';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, repoRootUrl), 'utf8'));
}

export async function seedExamples(databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl): Promise<void> {
  const db = createDb({ databaseUrl });
  try {
    const flow = flowSpecSchema.parse(await readJson('examples/flows/sample-flow.json'));
    const route = routeSpecSchema.parse(await readJson('examples/routes/sample-route.json'));
    const knowledgeSearchTool = toolManifestSchema.parse(
      await readJson('examples/tools/knowledge-search-tool.json'),
    );
    const recordWriteTool = toolManifestSchema.parse(
      await readJson('examples/tools/record-write-mock-tool.json'),
    );
    const modelPolicy = modelPolicySchema.parse(await readJson('examples/model-policies/sample-model-policy.json'));
    const agent = agentSpecSchema.parse(await readJson('examples/agents/sample-agent.json'));
    const promptContent = await readFile(new URL('examples/prompts/sample-prompt.md', repoRootUrl), 'utf8');
    const prompt = promptDefinitionSchema.parse({
      prompt_id: 'sample_prompt',
      version: 1,
      name: 'Sample controlled agent prompt',
      content: promptContent,
      variables: [],
      status: 'published',
    });

    await new FlowDefinitionRepository(db).upsert(flow, { tenantId, status: 'published', createdBy: 'seed-examples' });
    await new RouteConfigRepository(db).upsert(route, { tenantId, status: 'published', createdBy: 'seed-examples' });
    await new ToolManifestRepository(db).upsert(knowledgeSearchTool, {
      tenantId,
      status: 'published',
      createdBy: 'seed-examples',
    });
    await new ToolManifestRepository(db).upsert(recordWriteTool, {
      tenantId,
      status: 'published',
      createdBy: 'seed-examples',
    });
    await seedModelPolicy(db, tenantId, modelPolicy);
    if (shouldSeedLocalOllamaModelPolicy) {
      await seedModelPolicy(db, tenantId, localOllamaModelPolicy());
    }
    await upsertAgentSpec(db, agent, { tenantId, status: 'published', createdBy: 'seed-examples' });
    await upsertPromptDefinition(db, prompt, { tenantId, status: 'published', createdBy: 'seed-examples' });
    await new FlowExecutionPlanRepository(db).createForFlow({
      tenantId,
      flowId: flow.flow_id,
      flowVersion: flow.version,
      operatorId: 'seed-examples',
    });
    const policy = await seedTenantPolicy(db, tenantId);
    console.log(JSON.stringify({
      seeded_tenant_policy: {
        tenant_id: policy.tenant_id,
        version: policy.version,
        status: policy.status,
        policy_hash: hashTenantRuntimePolicy(policy),
      },
    }));
  } finally {
    await closeDb(db);
  }
}

async function seedModelPolicy(db: ReturnType<typeof createDb>, tenantIdValue: string, policy: ReturnType<typeof modelPolicySchema.parse>) {
  const repository = new ModelPolicyRepository(db);
  const existing = await repository.getByIdAndVersion(policy.model_policy_id, policy.version, { tenantId: tenantIdValue });
  const expectedHash = hashModelPolicy(policy);
  if (existing) {
    const existingHash = hashModelPolicy(existing);
    if (existingHash !== expectedHash) {
      throw new Error(`ModelPolicy seed content mismatch: ${policy.model_policy_id}@${policy.version}`);
    }
    if (existing.status === 'published' || existing.status === 'gray') {
      return existing;
    }
    if (existing.status === 'draft' || existing.status === 'validated') {
      return repository.publish(policy.model_policy_id, policy.version, {
        tenantId: tenantIdValue,
        operatorId: 'seed-examples',
        releaseNote: 'Seed sample model policy',
      });
    }
    throw new Error(`ModelPolicy ${policy.model_policy_id}@${policy.version} already exists with non-executable status ${existing.status}`);
  }
  await repository.createDraft(policy, { tenantId: tenantIdValue, operatorId: 'seed-examples' });
  return repository.publish(policy.model_policy_id, policy.version, {
    tenantId: tenantIdValue,
    operatorId: 'seed-examples',
    releaseNote: 'Seed sample model policy',
  });
}

function localOllamaModelPolicy() {
  return modelPolicySchema.parse({
    model_policy_id: 'local_ollama_qwen25_7b_instruct_q4_k_m',
    version: 1,
    status: 'published',
    protocol: 'openai_chat_completions',
    targets: [
      {
        target_id: 'local_ollama_qwen25_7b_instruct_q4_k_m_primary',
        gateway_profile: 'local-ollama',
        model_id: localOllamaModelId,
        priority: 0,
        enabled: true,
        capabilities: ['text', 'tools', 'usage'],
      },
    ],
    retry_policy: {
      max_attempts_per_target: 2,
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
  });
}

async function seedTenantPolicy(db: ReturnType<typeof createDb>, tenantIdValue: string) {
  const repository = new TenantRuntimePolicyRepository(db);
  const existing = await repository.getLatestPublished(tenantIdValue);
  if (existing) {
    return existing;
  }
  const existingVersion = await repository.getByTenantAndVersion(tenantIdValue, 1);
  if (existingVersion) {
    if (existingVersion.status === 'draft' || existingVersion.status === 'validated') {
      return new TenantRuntimePolicyReleaseService(db).publish(tenantIdValue, existingVersion.version, {
        operatorId: 'seed-examples',
        releaseNote: 'Seed development tenant runtime policy',
      });
    }
    return existingVersion;
  }
  const policy = tenantRuntimePolicySchema.parse({
    tenant_id: tenantIdValue,
    version: 1,
    status: 'draft',
    allowed_tools: [
      {
        tool_name: 'knowledge.search',
        versions: ['1.0.0'],
        allowed_operations: ['invoke', 'preview', 'commit'],
        max_risk_level: 'L1',
      },
      {
        tool_name: 'record.write.mock',
        versions: ['1.0.0'],
        allowed_operations: ['preview', 'commit'],
        max_risk_level: 'L3',
      },
    ],
    denied_tools: [],
    allowed_models: [
      { model_id: 'deterministic:readonly_tool' },
      { model_id: 'deterministic:l3_tool' },
      { model_id: 'deterministic:need_user' },
      { model_id: 'deterministic:handoff' },
      { model_id: 'deterministic:final_only' },
      { model_id: 'deterministic:repeated_tool' },
      { model_id: 'model_gateway:model_gateway' },
      { model_id: 'model_gateway:readonly_tool' },
      ...(shouldSeedLocalOllamaModelPolicy
        ? [{ model_id: localOllamaModelId }, { model_id: 'local-ollama:local_ollama_qwen25_7b_instruct_q4_k_m' }]
        : []),
    ],
    denied_models: [],
    allowed_handoffs: [
      {
        flow_id: 'sample_flow',
        versions: [1],
      },
      {
        flow_id: 'pi_handoff_target',
        versions: [1],
        execution_plan_refs: ['db://flow-execution-plan/plan_handoff'],
      },
    ],
    denied_handoffs: [],
    budget_cap: {
      max_segments: 6,
      max_model_turns: 12,
      max_tool_calls: 6,
      max_input_tokens: 8000,
      max_output_tokens: 8000,
      max_total_tokens: 12000,
      max_duration_ms: 600000,
      max_handoffs: 2,
      max_context_bytes: 524288,
    },
    max_concurrent_agent_runs: 2,
  });
  await repository.createDraft(policy, { tenantId: tenantIdValue, operatorId: 'seed-examples' });
  return new TenantRuntimePolicyReleaseService(db).publish(tenantIdValue, policy.version, {
    operatorId: 'seed-examples',
    releaseNote: 'Seed development tenant runtime policy',
  });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  seedExamples()
    .then(() => {
      console.log(`seeded examples for tenant ${tenantId}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
