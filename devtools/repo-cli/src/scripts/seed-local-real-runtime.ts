import {
  agentSpecSchema,
  flowSpecSchema,
  modelPolicySchema,
  promptDefinitionSchema,
  routeSpecSchema,
  tenantRuntimePolicySchema,
  type AgentSpec,
  type FlowSpec,
  type ModelPolicy,
  type PromptDefinition,
  type RouteSpec,
  type TenantRuntimePolicy,
} from '@dar/contracts';
import {
  AgentExecutionPlanRepository,
  AgentSpecRepository,
  closeDb,
  createDb,
  FlowDefinitionRepository,
  FlowExecutionPlanRepository,
  hashJson,
  hashModelPolicy,
  hashTenantRuntimePolicy,
  ModelPolicyRepository,
  PromptDefinitionRepository,
  RouteConfigRepository,
  TenantRuntimePolicyReleaseService,
  TenantRuntimePolicyRepository,
} from '@dar/db';
import { ensureModelCatalogEntry, localOllamaModelCatalogEntryInput } from './model-catalog-seed.js';

const defaultDatabaseUrl = 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';

const tenantId = process.env.LOCAL_REAL_TENANT_ID ?? 'local-real';
const operatorId = process.env.LOCAL_REAL_OPERATOR_ID ?? 'local-real-seed';

const modelPolicyId = 'local_real_ollama_policy';
const promptId = 'local_real_prompt';
const agentId = 'local_real_agent';
const flowId = 'local_real_pi_flow';
const routeId = 'local_real_pi_route';

type Db = ReturnType<typeof createDb>;

async function main(): Promise<void> {
  const db = createDb({ databaseUrl: process.env.DATABASE_URL ?? defaultDatabaseUrl });
  try {
    const modelPolicy = await ensureOllamaModelPolicy(db);
    await ensurePrompt(db);
    const agent = await ensureAgent(db, modelPolicy);
    const agentPlan = await new AgentExecutionPlanRepository(db).createForAgent({
      tenantId,
      agentId: agent.agent_id,
      agentVersion: agent.version,
      operatorId,
    });
    const flow = await ensureFlow(db, agent);
    const flowPlan = await ensureFlowExecutionPlan(db, flow);
    const route = await ensureRoute(db, flow);
    const policy = await ensureTenantPolicy(db);

    console.log(JSON.stringify({
      ok: true,
      tenant_id: tenantId,
      route: {
        route_id: route.route_id,
        action_id: route.route_id,
        flow_id: route.flow_id,
        version: route.version,
      },
      flow_execution_plan: {
        execution_plan_ref: flowPlan.execution_plan_ref,
        execution_plan_hash: flowPlan.execution_plan_hash,
      },
      agent_execution_plan: {
        execution_plan_ref: agentPlan.execution_plan_ref,
        execution_plan_hash: agentPlan.execution_plan_hash,
      },
      model_policy: {
        model_policy_id: modelPolicy.model_policy_id,
        version: modelPolicy.version,
        model_policy_hash: hashModelPolicy(modelPolicy),
      },
      tenant_policy: {
        version: policy.version,
        policy_hash: hashTenantRuntimePolicy(policy),
      },
      runtime_api_examples: {
        router_preview: {
          tenant_id: tenantId,
          user_id: 'local-real-user',
          channel: 'web',
          input: {
            action_id: routeId,
            text: '真实pi 请用一句话回复本地真实链路已经接通',
          },
        },
        routed_task: {
          tenant_id: tenantId,
          user_id: 'local-real-user',
          channel: 'web',
          input: {
            action_id: routeId,
            text: '真实pi 请用一句话回复本地真实链路已经接通',
          },
        },
        direct_agent_task: {
          tenant_id: tenantId,
          user_id: 'local-real-user',
          agent_execution_plan_ref: agentPlan.execution_plan_ref,
          input: {
            text: '请用一句话回复本地 Ollama Pi 直达链路已经接通',
          },
        },
      },
    }, null, 2));
  } finally {
    await closeDb(db);
  }
}

async function ensureOllamaModelPolicy(db: Db): Promise<ModelPolicy> {
  const catalog = await ensureModelCatalogEntry(db, localOllamaModelCatalogEntryInput(operatorId));
  const repository = new ModelPolicyRepository(db);
  const expected = modelPolicySchema.parse({
    model_policy_id: modelPolicyId,
    version: 1,
    status: 'published',
    protocol: 'openai_chat_completions',
    targets: [{
      target_id: `${modelPolicyId}_primary`,
      model_ref: catalog.model_ref,
      priority: 0,
      enabled: true,
    }],
    retry_policy: {
      max_attempts_per_target: 2,
      retryable_status_codes: [429, 500, 502, 503, 504],
      retry_on_timeout: true,
      retry_on_network_error: true,
      backoff_ms: 250,
      max_backoff_ms: 2_000,
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
      max_output_tokens: 800,
      initial_tool_choice_mode: 'none',
      after_tool_result_tool_choice_mode: 'none',
      response_format: 'text',
      allow_parallel_tool_calls: false,
    },
    revision: 1,
  });

  const existing = await repository.getByIdAndVersion(expected.model_policy_id, expected.version, { tenantId });
  if (existing) {
    assertSameHash('ModelPolicy', hashModelPolicy(existing), hashModelPolicy(expected));
    if (existing.status === 'published' || existing.status === 'gray') {
      return existing;
    }
    if (existing.status === 'draft' || existing.status === 'validated') {
      return repository.publish(existing.model_policy_id, existing.version, {
        tenantId,
        operatorId,
        releaseNote: 'Publish local real Ollama model policy',
      });
    }
    throw new Error(`ModelPolicy ${modelPolicyId}@1 is not executable: ${existing.status}`);
  }

  await repository.createDraft(expected, { tenantId, operatorId });
  return repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId,
    releaseNote: 'Publish local real Ollama model policy',
  });
}

async function ensurePrompt(db: Db): Promise<PromptDefinition> {
  const prompt = promptDefinitionSchema.parse({
    prompt_id: promptId,
    version: 1,
    name: 'Local real Pi prompt',
    content: [
      '你是 Durable Agent Runtime Lite 本地真实链路验证助手。',
      '使用简短中文回答用户问题。',
      '不要调用工具，不要编造外部系统结果，只说明当前请求已经通过本地 Ollama Pi 链路处理。',
    ].join('\n'),
    variables: [],
    status: 'published',
  });
  await ensureVersionedSpec(new PromptDefinitionRepository(db), promptId, 1, prompt);
  return prompt;
}

async function ensureAgent(db: Db, modelPolicy: ModelPolicy): Promise<AgentSpec> {
  const modelPolicyHash = hashModelPolicy(modelPolicy);
  const agent = agentSpecSchema.parse({
    agent_id: agentId,
    version: 1,
    prompt_ref: `${promptId}@1`,
    model_policy: modelPolicy.model_policy_id,
    model_policy_ref: {
      model_policy_id: modelPolicy.model_policy_id,
      model_policy_version: modelPolicy.version,
      model_policy_hash: modelPolicyHash,
    },
    allowed_tools: [],
    allowed_handoffs: [],
    max_steps: 4,
    max_tokens: 2_000,
    output_schema: 'local_real_text_v1',
    status: 'published',
  });
  await ensureVersionedSpec(new AgentSpecRepository(db), agentId, 1, agent);
  return agent;
}

async function ensureFlow(db: Db, agent: AgentSpec): Promise<FlowSpec> {
  const flow = flowSpecSchema.parse({
    flow_id: flowId,
    version: 1,
    name: 'Local real routed Pi flow',
    description: 'Route -> ConfigDrivenWorkflow -> Pi durable agent workflow -> local Ollama.',
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        payload: { type: 'object' },
      },
    },
    steps: [{
      id: 'local_real_pi',
      type: 'agent',
      agent_id: agent.agent_id,
      input: {
        agent_version: agent.version,
        text: '${input.text}',
        payload: '${input.payload}',
      },
    }],
    status: 'published',
  });
  await ensureVersionedSpec(new FlowDefinitionRepository(db), flowId, 1, flow);
  return flow;
}

async function ensureFlowExecutionPlan(db: Db, flow: FlowSpec) {
  const repository = new FlowExecutionPlanRepository(db);
  const existing = await repository.getLatestForFlow(flow.flow_id, flow.version, { tenantId });
  if (existing) {
    return existing;
  }
  return repository.createForFlow({
    tenantId,
    flowId: flow.flow_id,
    flowVersion: flow.version,
    operatorId,
  });
}

async function ensureRoute(db: Db, flow: FlowSpec): Promise<RouteSpec> {
  const route = routeSpecSchema.parse({
    route_id: routeId,
    flow_id: flow.flow_id,
    version: flow.version,
    status: 'published',
    route: {
      priority: 95,
      keywords: ['真实pi', '真实链路', 'ollama', 'local-real'],
      examples: ['本地真实链路测试', '用 ollama 跑 pi 流程', '验证 route 到 pi'],
      negative_examples: ['不要走真实链路', '不要调用 ollama'],
      supported_channels: ['web', 'api', 'control-plane', 'chat'],
      role_constraints: [],
      confidence_threshold: 0.7,
      ambiguous_threshold: 0.5,
    },
  });
  await ensureVersionedSpec(new RouteConfigRepository(db), routeId, flow.version, route);
  return route;
}

async function ensureTenantPolicy(db: Db): Promise<TenantRuntimePolicy> {
  const repository = new TenantRuntimePolicyRepository(db);
  const expected = tenantRuntimePolicySchema.parse({
    tenant_id: tenantId,
    version: 1,
    status: 'published',
    allowed_tools: [],
    denied_tools: [],
    allowed_models: [
      { model_id: modelPolicyId },
      { model_id: `${modelPolicyId}@1` },
      { model_id: 'qwen2.5:7b-instruct-q4_K_M' },
    ],
    denied_models: [],
    allowed_handoffs: [],
    denied_handoffs: [],
    budget_cap: {
      max_segments: 4,
      max_model_turns: 4,
      max_tool_calls: 0,
      max_total_tokens: 4_000,
      max_duration_ms: 300_000,
      max_handoffs: 0,
      max_context_bytes: 262_144,
    },
    max_concurrent_agent_runs: 2,
  });
  const existing = await repository.getByTenantAndVersion(tenantId, 1);
  if (existing) {
    const expectedForStatus = tenantRuntimePolicySchema.parse({ ...expected, status: existing.status });
    assertSameHash('TenantRuntimePolicy', hashTenantRuntimePolicy(existing), hashTenantRuntimePolicy(expectedForStatus));
    if (existing.status === 'published') {
      return existing;
    }
    if (existing.status === 'draft' || existing.status === 'validated') {
      return new TenantRuntimePolicyReleaseService(db).publish(tenantId, 1, {
        operatorId,
        releaseNote: 'Publish local real tenant runtime policy',
      });
    }
    throw new Error(`TenantRuntimePolicy ${tenantId}@1 is not executable: ${existing.status}`);
  }

  await repository.createDraft(expected, { tenantId, operatorId });
  return new TenantRuntimePolicyReleaseService(db).publish(tenantId, 1, {
    operatorId,
    releaseNote: 'Publish local real tenant runtime policy',
  });
}

async function ensureVersionedSpec<TSpec extends object>(
  repository: {
    getByIdAndVersion(id: string, version: number, options: { tenantId: string }): Promise<{ status: string; sha256: string; revision: number } | undefined>;
    createDraft(spec: TSpec, options: { tenantId: string; operatorId: string }): Promise<{ revision: number }>;
    markValidated(id: string, version: number, options: { tenantId: string; operatorId: string }): Promise<unknown>;
    publish(id: string, version: number, options: { tenantId: string; operatorId: string }): Promise<unknown>;
  },
  id: string,
  version: number,
  spec: TSpec,
): Promise<void> {
  const existing = await repository.getByIdAndVersion(id, version, { tenantId });
  if (existing) {
    const expectedHash = hashJson({ ...spec, status: existing.status });
    assertSameHash(id, existing.sha256, expectedHash);
    if (existing.status === 'published' || existing.status === 'gray') {
      return;
    }
    if (existing.status === 'draft') {
      await repository.markValidated(id, version, { tenantId, operatorId });
      await repository.publish(id, version, { tenantId, operatorId });
      return;
    }
    if (existing.status === 'validated') {
      await repository.publish(id, version, { tenantId, operatorId });
      return;
    }
    throw new Error(`${id}@${version} is not executable: ${existing.status}`);
  }
  await repository.createDraft(spec, { tenantId, operatorId });
  await repository.markValidated(id, version, { tenantId, operatorId });
  await repository.publish(id, version, { tenantId, operatorId });
}

function assertSameHash(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`${label} seed content mismatch`);
  }
}

main().catch((error: unknown) => {
  console.error('seed-local-real-runtime failed');
  console.error(error);
  process.exit(1);
});
