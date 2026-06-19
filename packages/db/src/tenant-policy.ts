import type {
  AgentBudget,
  AgentExecutionPlan,
  FlowExecutionPlan,
  TenantPolicyDecision,
  TenantPolicySnapshotDerivationType,
  TenantPolicyHandoffRule,
  TenantPolicyOperation,
  TenantPolicyToolRule,
  TenantRuntimePolicy,
  TenantRuntimePolicySnapshot,
  ToolRiskLevel,
} from '@dar/contracts';
import {
  effectiveTenantPolicySchema,
  agentBudgetSchema,
  registryValidationResultSchema,
  tenantPolicyDecisionSchema,
  tenantRuntimePolicySchema,
  type RegistryValidationResult,
} from '@dar/contracts';
import type { Kysely } from 'kysely';
import {
  AgentExecutionPlanRepository,
  AuditEventRepository,
  FlowExecutionPlanRepository,
  hashTenantRuntimePolicy,
  TenantRuntimePolicyRepository,
  TenantRuntimePolicySnapshotRepository,
  ToolManifestRepository,
} from './repositories.js';
import type { Database } from './index.js';

export type TenantRuntimePolicyMode = 'required' | 'optional';

export class TenantRuntimePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 403,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TenantRuntimePolicyError';
  }
}

export interface TenantRuntimePolicyResolverInput {
  tenant_id: string;
  user_id: string;
  execution_plan_ref: string;
  execution_plan_hash?: string;
  execution_plan_type: 'flow' | 'agent';
  request_id?: string;
  mode?: TenantRuntimePolicyMode;
}

export interface TenantRuntimePolicyDeriveInput {
  tenant_id: string;
  user_id: string;
  parent_snapshot_ref: string;
  target_execution_plan_ref: string;
  target_execution_plan_hash?: string;
  target_execution_plan_type: 'flow' | 'agent';
  derivation_type: Exclude<TenantPolicySnapshotDerivationType, 'root'>;
  request_id?: string;
}

export type EffectiveTenantPolicy = ReturnType<typeof effectivePolicyFromSnapshot>;

export interface TenantRuntimePolicyResolverResult {
  snapshot: TenantRuntimePolicySnapshot;
  decision: TenantPolicyDecision;
}

export class TenantRuntimePolicyValidationService {
  constructor(private readonly db: Kysely<Database>) {}

  async validate(policyInput: TenantRuntimePolicy): Promise<RegistryValidationResult> {
    const parsed = tenantRuntimePolicySchema.parse(policyInput);
    const errors: RegistryValidationResult['errors'] = [];
    const warnings: RegistryValidationResult['warnings'] = [];
    const nodes: RegistryValidationResult['dependency_graph']['nodes'] = [];
    const edges: RegistryValidationResult['dependency_graph']['edges'] = [];

    if (parsed.max_concurrent_agent_runs <= 0) {
      errors.push(issue('TENANT_POLICY_INVALID_CONCURRENCY', 'max_concurrent_agent_runs must be greater than 0', 'max_concurrent_agent_runs'));
    }
    for (const [key, value] of Object.entries(parsed.budget_cap)) {
      if (typeof value === 'number' && value < 0) {
        errors.push(issue('TENANT_POLICY_INVALID_BUDGET', `${key} must be non-negative`, `budget_cap.${key}`));
      }
    }
    if (containsWildcard(parsed)) {
      errors.push(issue('TENANT_POLICY_WILDCARD_DENIED', 'Tenant policy must not use wildcard allow rules'));
    }
    if (containsSecretLikeValue(parsed)) {
      errors.push(issue('TENANT_POLICY_SECRET_LIKE_VALUE', 'Tenant policy must not contain secret-like values'));
    }

    const toolRepository = new ToolManifestRepository(this.db);
    for (const rule of [...parsed.allowed_tools, ...parsed.denied_tools]) {
      nodes.push({ resource_type: 'tool', resource_id: rule.tool_name });
      if (!rule.versions?.length) {
        warnings.push(issue('TENANT_POLICY_TOOL_VERSION_NOT_PINNED', `Tool rule ${rule.tool_name} does not pin versions`, `tools.${rule.tool_name}`));
        continue;
      }
      for (const version of rule.versions) {
        const manifest = await toolRepository.getByIdAndVersion(rule.tool_name, manifestVersionToRegistryVersion(version), {
          tenantId: parsed.tenant_id,
        });
        if (!manifest || manifest.spec.version !== version || manifest.status !== 'published') {
          errors.push(issue('TENANT_POLICY_TOOL_NOT_PUBLISHED', `ToolManifest not published: ${rule.tool_name}@${version}`, `tools.${rule.tool_name}`));
        }
      }
    }

    for (const rule of parsed.allowed_models) {
      nodes.push({ resource_type: 'agent', resource_id: rule.model_id });
      if (isProductionMockModel(rule.model_id)) {
        errors.push(issue('TENANT_POLICY_PRODUCTION_MOCK_MODEL_DENIED', `Mock/deterministic model is not valid for production policy: ${rule.model_id}`, 'allowed_models'));
      }
    }

    return registryValidationResultSchema.parse({
      valid: errors.length === 0,
      can_publish: errors.length === 0,
      errors,
      warnings,
      dependency_graph: { nodes, edges },
    });
  }
}

export class TenantRuntimePolicyReleaseService {
  private readonly repository: TenantRuntimePolicyRepository;
  private readonly validation: TenantRuntimePolicyValidationService;

  constructor(private readonly db: Kysely<Database>) {
    this.repository = new TenantRuntimePolicyRepository(db);
    this.validation = new TenantRuntimePolicyValidationService(db);
  }

  validate(policy: TenantRuntimePolicy): Promise<RegistryValidationResult> {
    return this.validation.validate(policy);
  }

  async publish(tenantId: string, version: number, options: { operatorId: string; releaseNote: string; metadataJson?: Record<string, unknown> }): Promise<TenantRuntimePolicy> {
    const policy = await this.repository.getByTenantAndVersion(tenantId, version);
    if (!policy) {
      throw new TenantRuntimePolicyError('TENANT_RUNTIME_POLICY_NOT_FOUND', `Tenant runtime policy not found: ${tenantId}@${version}`, 404);
    }
    const validation = await this.validation.validate(policy);
    if (!validation.can_publish) {
      throw new TenantRuntimePolicyError('TENANT_RUNTIME_POLICY_VALIDATION_FAILED', 'Tenant runtime policy cannot be published', 422, { validation });
    }
    return this.repository.publish(tenantId, version, {
      tenantId,
      operatorId: options.operatorId,
      releaseNote: options.releaseNote,
      metadataJson: options.metadataJson ?? {},
    });
  }

  rollback(tenantId: string, options: { targetVersion: number; operatorId: string; releaseNote: string; metadataJson?: Record<string, unknown> }): Promise<TenantRuntimePolicy> {
    return this.repository.rollback(tenantId, {
      tenantId,
      targetVersion: options.targetVersion,
      operatorId: options.operatorId,
      releaseNote: options.releaseNote,
      metadataJson: options.metadataJson ?? {},
    });
  }

  deprecate(tenantId: string, version: number, options: { operatorId: string; releaseNote: string }): Promise<TenantRuntimePolicy> {
    return this.repository.deprecate(tenantId, version, { tenantId, operatorId: options.operatorId, releaseNote: options.releaseNote });
  }

  disable(tenantId: string, version: number, options: { operatorId: string; releaseNote: string }): Promise<TenantRuntimePolicy> {
    return this.repository.disable(tenantId, version, { tenantId, operatorId: options.operatorId, releaseNote: options.releaseNote });
  }
}

export class TenantRuntimePolicyResolver {
  static readonly maxLineageDepth = 8;

  constructor(private readonly db: Kysely<Database>) {}

  async resolve(input: TenantRuntimePolicyResolverInput): Promise<TenantRuntimePolicyResolverResult> {
    const mode = input.mode ?? 'required';
    const policy = await new TenantRuntimePolicyRepository(this.db).getLatestPublished(input.tenant_id);
    if (!policy && mode === 'required') {
      await this.appendResolveAudit(input, 'policy.resolve.denied', 'denied', 'TENANT_RUNTIME_POLICY_NOT_FOUND');
      throw new TenantRuntimePolicyError('TENANT_RUNTIME_POLICY_NOT_FOUND', 'Tenant runtime policy is required but no published policy exists', 403);
    }

    const plan = await this.loadExecutionPlan(input);
    if (input.execution_plan_hash && plan.execution_plan_hash !== input.execution_plan_hash) {
      await this.appendResolveAudit(input, 'policy.resolve.denied', 'denied', 'EXECUTION_PLAN_HASH_MISMATCH');
      throw new TenantRuntimePolicyError('EXECUTION_PLAN_HASH_MISMATCH', 'Execution plan hash mismatch', 409);
    }

    const effective = policy
      ? resolveEffectivePolicy(policy, plan)
      : resolveExecutionPlanOnlyPolicy(input.tenant_id, plan);
    const sourcePolicy = policy ?? executionPlanOnlyPolicy(input.tenant_id, effective.resolved_budget);
    const sourcePolicyHash = policy ? hashTenantRuntimePolicy(policy) : hashTenantRuntimePolicy(sourcePolicy);
    const snapshot = await new TenantRuntimePolicySnapshotRepository(this.db).createImmutableSnapshot({
      tenantId: input.tenant_id,
      policy: sourcePolicy,
      policyHash: sourcePolicyHash,
      executionPlanRef: plan.execution_plan_ref,
      executionPlanHash: plan.execution_plan_hash,
      executionPlanType: input.execution_plan_type,
      derivationType: 'root',
      lineageDepth: 0,
      resolvedPolicy: effective,
    });
    const decision = tenantPolicyDecisionSchema.parse({
      decision: 'allow',
      reason_code: policy ? 'TENANT_POLICY_RESOLVED' : 'EXECUTION_PLAN_ONLY_POLICY',
      reason_summary: policy ? 'Tenant policy resolved against execution plan' : 'Development optional mode used execution-plan-only policy',
      snapshot_ref: snapshot.snapshot_ref,
      snapshot_hash: snapshot.snapshot_hash,
      matched_rules: [],
      effective_budget: snapshot.resolved_budget,
      effective_allowed_tools: snapshot.resolved_allowed_tools,
      effective_allowed_models: snapshot.resolved_allowed_models,
      effective_allowed_handoffs: snapshot.resolved_allowed_handoffs,
    });
    await this.appendResolveAudit(input, 'policy.snapshot.created', 'succeeded', decision.reason_code, snapshot);
    await this.appendResolveAudit(input, 'policy.resolve.allowed', 'allowed', decision.reason_code, snapshot);
    return { snapshot, decision };
  }

  async deriveForExecutionPlan(input: TenantRuntimePolicyDeriveInput): Promise<TenantRuntimePolicyResolverResult> {
    const snapshotRepository = new TenantRuntimePolicySnapshotRepository(this.db);
    const parent = await snapshotRepository.getByRef(input.parent_snapshot_ref, { tenantId: input.tenant_id });
    if (!parent) {
      throw new TenantRuntimePolicyError('TENANT_POLICY_PARENT_SNAPSHOT_NOT_FOUND', 'Parent tenant policy snapshot not found', 404);
    }
    if (parent.tenant_id !== input.tenant_id) {
      throw new TenantRuntimePolicyError('TENANT_POLICY_SNAPSHOT_TENANT_MISMATCH', 'Policy snapshot tenant mismatch', 403);
    }
    if (parent.lineage_depth >= TenantRuntimePolicyResolver.maxLineageDepth) {
      throw new TenantRuntimePolicyError('TENANT_POLICY_LINEAGE_DEPTH_EXCEEDED', 'Tenant policy snapshot lineage depth exceeded', 409);
    }
    const root = await snapshotRepository.getByRef(parent.root_snapshot_ref, { tenantId: input.tenant_id });
    if (!root) {
      throw new TenantRuntimePolicyError('TENANT_POLICY_ROOT_SNAPSHOT_NOT_FOUND', 'Root tenant policy snapshot not found', 404);
    }
    if (root.tenant_id !== parent.tenant_id) {
      throw new TenantRuntimePolicyError('TENANT_POLICY_SNAPSHOT_TENANT_MISMATCH', 'Policy snapshot root tenant mismatch', 403);
    }
    const policy = await new TenantRuntimePolicyRepository(this.db).getByTenantAndVersion(
      input.tenant_id,
      root.source_policy_version,
    );
    if (!policy) {
      throw new TenantRuntimePolicyError('TENANT_RUNTIME_POLICY_NOT_FOUND', 'Source tenant runtime policy version not found', 403);
    }
    const policyHash = hashTenantRuntimePolicy(policy);
    if (policyHash !== root.source_policy_hash || policyHash !== parent.source_policy_hash) {
      await this.appendResolveAudit({
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        execution_plan_ref: input.target_execution_plan_ref,
        execution_plan_type: input.target_execution_plan_type,
        ...(input.target_execution_plan_hash ? { execution_plan_hash: input.target_execution_plan_hash } : {}),
        ...(input.request_id ? { request_id: input.request_id } : {}),
      }, 'policy.snapshot.hash_mismatch', 'denied', 'TENANT_POLICY_HASH_MISMATCH', parent);
      throw new TenantRuntimePolicyError('TENANT_POLICY_HASH_MISMATCH', 'Source tenant policy hash mismatch', 409);
    }
    const plan = await this.loadExecutionPlan({
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      execution_plan_ref: input.target_execution_plan_ref,
      execution_plan_type: input.target_execution_plan_type,
      mode: 'required',
      ...(input.target_execution_plan_hash ? { execution_plan_hash: input.target_execution_plan_hash } : {}),
      ...(input.request_id ? { request_id: input.request_id } : {}),
    });
    if (input.target_execution_plan_hash && plan.execution_plan_hash !== input.target_execution_plan_hash) {
      throw new TenantRuntimePolicyError('EXECUTION_PLAN_HASH_MISMATCH', 'Execution plan hash mismatch', 409);
    }
    const effective = resolveEffectivePolicy(policy, plan);
    const child = await snapshotRepository.createImmutableSnapshot({
      tenantId: input.tenant_id,
      policy,
      policyHash,
      executionPlanRef: plan.execution_plan_ref,
      executionPlanHash: plan.execution_plan_hash,
      executionPlanType: input.target_execution_plan_type,
      rootSnapshotRef: root.snapshot_ref,
      parentSnapshotRef: parent.snapshot_ref,
      derivationType: input.derivation_type,
      lineageDepth: parent.lineage_depth + 1,
      resolvedPolicy: effective,
    });
    const decision = tenantPolicyDecisionSchema.parse({
      decision: 'allow',
      reason_code: 'TENANT_POLICY_SNAPSHOT_DERIVED',
      reason_summary: 'Tenant policy snapshot derived for execution plan lineage',
      snapshot_ref: child.snapshot_ref,
      snapshot_hash: child.snapshot_hash,
      matched_rules: [],
      effective_budget: child.resolved_budget,
      effective_allowed_tools: child.resolved_allowed_tools,
      effective_allowed_models: child.resolved_allowed_models,
      effective_allowed_handoffs: child.resolved_allowed_handoffs,
    });
    await this.appendResolveAudit({
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      execution_plan_ref: plan.execution_plan_ref,
      execution_plan_hash: plan.execution_plan_hash,
      execution_plan_type: input.target_execution_plan_type,
      mode: 'required',
      ...(input.request_id ? { request_id: input.request_id } : {}),
    }, 'policy.snapshot.derived', 'succeeded', decision.reason_code, child);
    return { snapshot: child, decision };
  }

  private async loadExecutionPlan(input: TenantRuntimePolicyResolverInput): Promise<FlowExecutionPlan | AgentExecutionPlan> {
    if (input.execution_plan_type === 'flow') {
      const plan = await new FlowExecutionPlanRepository(this.db).getByRef(input.execution_plan_ref, { tenantId: input.tenant_id });
      if (!plan) {
        throw new TenantRuntimePolicyError('FLOW_EXECUTION_PLAN_NOT_FOUND', `FlowExecutionPlan not found: ${input.execution_plan_ref}`, 404);
      }
      return plan;
    }
    const plan = await new AgentExecutionPlanRepository(this.db).getByRef(input.execution_plan_ref, { tenantId: input.tenant_id });
    if (!plan) {
      throw new TenantRuntimePolicyError('AGENT_EXECUTION_PLAN_NOT_FOUND', `AgentExecutionPlan not found: ${input.execution_plan_ref}`, 404);
    }
    return plan;
  }

  private async appendResolveAudit(
    input: TenantRuntimePolicyResolverInput,
    action: string,
    result: 'allowed' | 'denied' | 'succeeded' | 'failed' | 'pending',
    reason: string,
    snapshot?: TenantRuntimePolicySnapshot,
  ): Promise<void> {
    await new AuditEventRepository(this.db).append({
      event_key: [
        action,
        input.tenant_id,
        input.execution_plan_ref,
        snapshot?.snapshot_ref ?? reason,
        input.request_id ?? 'no-request',
      ].join(':'),
      tenant_id: input.tenant_id,
      actor_id: input.user_id,
      action,
      target_type: 'tenant_runtime_policy',
      target_id: input.tenant_id,
      result,
      reason,
      trace_id: input.request_id,
      payload: {
        tenant_id: input.tenant_id,
        execution_plan_ref: input.execution_plan_ref,
        execution_plan_hash: input.execution_plan_hash,
        policy_snapshot_ref: snapshot?.snapshot_ref,
        policy_snapshot_hash: snapshot?.snapshot_hash,
      },
    });
  }
}

export function effectivePolicyFromSnapshot(snapshot: TenantRuntimePolicySnapshot) {
  return effectiveTenantPolicySchema.parse({
    tenant_id: snapshot.tenant_id,
    snapshot_ref: snapshot.snapshot_ref,
    snapshot_hash: snapshot.snapshot_hash,
    source_policy_version: snapshot.source_policy_version,
    source_policy_hash: snapshot.source_policy_hash,
    execution_plan_ref: snapshot.execution_plan_ref,
    execution_plan_hash: snapshot.execution_plan_hash,
    execution_plan_type: snapshot.execution_plan_type,
    root_snapshot_ref: snapshot.root_snapshot_ref,
    ...(snapshot.parent_snapshot_ref ? { parent_snapshot_ref: snapshot.parent_snapshot_ref } : {}),
    derivation_type: snapshot.derivation_type,
    lineage_depth: snapshot.lineage_depth,
    allowed_tools: snapshot.resolved_allowed_tools,
    denied_tools: snapshot.resolved_denied_tools,
    allowed_models: snapshot.resolved_allowed_models,
    allowed_handoffs: snapshot.resolved_allowed_handoffs,
    budget: snapshot.resolved_budget,
    max_concurrent_agent_runs: snapshot.max_concurrent_agent_runs,
  });
}

export function resolveEffectivePolicy(
  policy: TenantRuntimePolicy,
  plan: FlowExecutionPlan | AgentExecutionPlan,
): Omit<TenantRuntimePolicySnapshot, 'snapshot_id' | 'snapshot_ref' | 'tenant_id' | 'root_snapshot_ref' | 'parent_snapshot_ref' | 'derivation_type' | 'lineage_depth' | 'source_policy_version' | 'source_policy_hash' | 'execution_plan_ref' | 'execution_plan_hash' | 'execution_plan_type' | 'snapshot_hash' | 'created_at'> {
  const planTools = planToolEntries(plan);
  const planModels = planModelEntries(plan);
  const planHandoffs = planHandoffEntries(plan);
  const allowedTools = planTools
    .filter((tool) => toolAllowedByPolicy(tool, policy))
    .map((tool) => ({
      tool_name: tool.tool_name,
      versions: [tool.tool_version],
      allowed_operations: operationsForTool(tool, policy),
      max_risk_level: tool.risk_level,
    }));
  const deniedTools = planTools
    .filter((tool) => toolDeniedByPolicy(tool, policy))
    .map((tool) => ({
      tool_name: tool.tool_name,
      versions: [tool.tool_version],
      allowed_operations: ['invoke', 'preview', 'commit'] as TenantPolicyOperation[],
      max_risk_level: tool.risk_level,
      reason_code: 'TENANT_POLICY_TOOL_DENIED',
    }));
  const allowedModels = planModels.filter((model) => modelAllowedByPolicy(model, policy)).map((model) => ({ model_id: model.model_id }));
  const allowedHandoffs = planHandoffs
    .filter((handoff) => handoffAllowedByPolicy(handoff, policy))
    .map((flowRef) => ({ flow_id: flowRef, execution_plan_refs: [flowRef] }));
  return {
    resolved_allowed_tools: allowedTools,
    resolved_denied_tools: deniedTools,
    resolved_allowed_models: allowedModels,
    resolved_allowed_handoffs: allowedHandoffs,
    resolved_budget: capBudget(planBudget(plan), policy.budget_cap),
    max_concurrent_agent_runs: policy.max_concurrent_agent_runs,
  };
}

export function assertSnapshotAllowsTool(input: {
  snapshot: TenantRuntimePolicySnapshot;
  tenantId: string;
  snapshotHash: string;
  executionPlanRef: string;
  executionPlanHash: string;
  toolName: string;
  toolVersion: string;
  operation: TenantPolicyOperation;
  riskLevel: ToolRiskLevel;
}): void {
  assertSnapshotIdentity(input);
  const denied = input.snapshot.resolved_denied_tools.some((rule) => rule.tool_name === input.toolName && ruleMatchesVersion(rule, input.toolVersion));
  if (denied) {
    throw new TenantRuntimePolicyError('TOOL_DENIED_BY_TENANT_POLICY', 'Tool denied by tenant policy', 403);
  }
  const allowed = input.snapshot.resolved_allowed_tools.some((rule) =>
    rule.tool_name === input.toolName
    && ruleMatchesVersion(rule, input.toolVersion)
    && rule.allowed_operations.includes(input.operation),
  );
  if (!allowed) {
    throw new TenantRuntimePolicyError('TOOL_DENIED_BY_TENANT_POLICY', 'Tool is not allowed by tenant policy snapshot', 403);
  }
}

export function assertSnapshotAllowsModel(input: {
  snapshot: TenantRuntimePolicySnapshot;
  tenantId: string;
  snapshotHash: string;
  executionPlanRef: string;
  executionPlanHash: string;
  modelPolicy: string;
  modelPolicyId?: string;
  modelPolicyVersion?: number;
  modelPolicyHash?: string;
  targetIds?: string[];
  modelIds?: string[];
}): void {
  assertSnapshotIdentity(input);
  const aliases = new Set([
    input.modelPolicy,
    ...(input.modelPolicyId ? [input.modelPolicyId] : []),
    ...(input.modelPolicyId && input.modelPolicyVersion ? [`${input.modelPolicyId}@${input.modelPolicyVersion}`] : []),
    ...(input.modelPolicyId && input.modelPolicyVersion && input.modelPolicyHash ? [`${input.modelPolicyId}@${input.modelPolicyVersion}#${input.modelPolicyHash}`] : []),
    ...(input.targetIds ?? []),
    ...(input.modelIds ?? []),
  ]);
  const allowed = input.snapshot.resolved_allowed_models.some((rule) => aliases.has(rule.model_id));
  if (!allowed) {
    throw new TenantRuntimePolicyError('AGENT_MODEL_DENIED_BY_TENANT_POLICY', 'Agent model is not allowed by tenant policy snapshot', 403);
  }
}

export function assertSnapshotAllowsHandoff(input: {
  snapshot: TenantRuntimePolicySnapshot;
  tenantId: string;
  snapshotHash: string;
  executionPlanRef: string;
  executionPlanHash: string;
  targetExecutionPlanRef: string;
}): void {
  assertSnapshotIdentity(input);
  const allowed = input.snapshot.resolved_allowed_handoffs.some((rule) => handoffRuleMatches(rule, input.targetExecutionPlanRef));
  if (!allowed) {
    throw new TenantRuntimePolicyError('HANDOFF_DENIED_BY_TENANT_POLICY', 'Workflow handoff is not allowed by tenant policy snapshot', 403);
  }
}

function assertSnapshotIdentity(input: {
  snapshot: TenantRuntimePolicySnapshot;
  tenantId: string;
  snapshotHash: string;
  executionPlanRef: string;
  executionPlanHash: string;
}): void {
  if (input.snapshot.tenant_id !== input.tenantId) {
    throw new TenantRuntimePolicyError('TENANT_POLICY_SNAPSHOT_TENANT_MISMATCH', 'Policy snapshot tenant mismatch', 403);
  }
  if (input.snapshot.snapshot_hash !== input.snapshotHash) {
    throw new TenantRuntimePolicyError('TENANT_POLICY_HASH_MISMATCH', 'Policy snapshot hash mismatch', 409);
  }
  if (input.snapshot.execution_plan_ref !== input.executionPlanRef || input.snapshot.execution_plan_hash !== input.executionPlanHash) {
    throw new TenantRuntimePolicyError('EXECUTION_PLAN_HASH_MISMATCH', 'Execution plan hash mismatch', 409);
  }
}

function resolveExecutionPlanOnlyPolicy(
  tenantId: string,
  plan: FlowExecutionPlan | AgentExecutionPlan,
): ReturnType<typeof resolveEffectivePolicy> {
  const tools = planToolEntries(plan).map((tool) => ({
    tool_name: tool.tool_name,
    versions: [tool.tool_version],
    allowed_operations: ['invoke', 'preview', 'commit'] as TenantPolicyOperation[],
    max_risk_level: tool.risk_level,
  }));
  return {
    resolved_allowed_tools: tools,
    resolved_denied_tools: [],
    resolved_allowed_models: planModelEntries(plan).map((model) => ({ model_id: model.model_id })),
    resolved_allowed_handoffs: planHandoffEntries(plan).map((flow_id) => ({ flow_id, execution_plan_refs: [flow_id] })),
    resolved_budget: planBudget(plan),
    max_concurrent_agent_runs: 1,
  };
}

function executionPlanOnlyPolicy(tenantId: string, budget: AgentBudget): TenantRuntimePolicy {
  return tenantRuntimePolicySchema.parse({
    tenant_id: tenantId,
    version: 1,
    status: 'published',
    allowed_tools: [],
    denied_tools: [],
    allowed_models: [],
    denied_models: [],
    allowed_handoffs: [],
    denied_handoffs: [],
    budget_cap: budget,
    max_concurrent_agent_runs: 1,
  });
}

function planToolEntries(plan: FlowExecutionPlan | AgentExecutionPlan): Array<{ tool_name: string; tool_version: string; risk_level: ToolRiskLevel }> {
  return 'tools' in plan
    ? plan.tools.map((tool) => ({ tool_name: tool.tool_name, tool_version: tool.tool_version, risk_level: tool.risk_level }))
    : plan.allowed_tools.map((tool) => ({ tool_name: tool.tool_name, tool_version: tool.tool_version, risk_level: tool.risk_level }));
}

function planModelEntries(plan: FlowExecutionPlan | AgentExecutionPlan): Array<{ model_id: string; aliases: string[] }> {
  const entries = 'agents' in plan
    ? plan.agents.flatMap((agent) => modelIdentitiesForPlan(agent.model_policy, agent.model_policy_id, agent.model_policy_version, agent.model_policy_hash, agent.resolved_model_policy?.resolved_targets))
    : modelIdentitiesForPlan(plan.model_policy, plan.model_policy_id, plan.model_policy_version, plan.model_policy_hash, plan.resolved_model_policy.resolved_targets);
  const byPrimary = new Map<string, Set<string>>();
  for (const entry of entries) {
    const aliases = byPrimary.get(entry.model_id) ?? new Set<string>();
    entry.aliases.forEach((alias) => aliases.add(alias));
    byPrimary.set(entry.model_id, aliases);
  }
  return [...byPrimary.entries()].map(([model_id, aliases]) => ({ model_id, aliases: [...aliases].sort() }));
}

function modelIdentitiesForPlan(
  displayPolicy: string,
  policyId: string,
  policyVersion: number,
  policyHash: string,
  targets: Array<{ target_id: string; model_id: string }> | undefined,
): Array<{ model_id: string; aliases: string[] }> {
  const policyVersionRef = `${policyId}@${policyVersion}`;
  const policyHashRef = `${policyVersionRef}#${policyHash}`;
  const resolvedTargets = targets ?? [];
  if (resolvedTargets.length === 0) {
    return [{ model_id: policyHashRef, aliases: [displayPolicy, policyVersionRef, policyHashRef] }];
  }
  return resolvedTargets.map((target) => ({
    model_id: target.model_id,
    aliases: [displayPolicy, policyId, policyVersionRef, policyHashRef, target.target_id, target.model_id],
  }));
}

function planHandoffEntries(plan: FlowExecutionPlan | AgentExecutionPlan): string[] {
  return 'agents' in plan
    ? [...new Set(plan.agents.flatMap((agent) => agent.allowed_handoffs))]
    : plan.allowed_handoffs;
}

function planBudget(plan: FlowExecutionPlan | AgentExecutionPlan): AgentBudget {
  if ('plan' in plan) {
    return plan.budget;
  }
  return agentBudgetSchema.parse({
    max_segments: Math.max(plan.budget.max_steps, 1),
    max_model_turns: Math.max(plan.budget.max_steps, 1),
    max_tool_calls: plan.tools.length,
    max_total_tokens: Math.max(plan.budget.max_tokens, 1),
  });
}

function capBudget(plan: AgentBudget, cap: TenantRuntimePolicy['budget_cap']): AgentBudget {
  return agentBudgetSchema.parse({
    max_segments: minOptional(plan.max_segments, cap.max_segments),
    max_model_turns: minOptional(plan.max_model_turns, cap.max_model_turns),
    max_tool_calls: minOptional(plan.max_tool_calls, cap.max_tool_calls),
    max_input_tokens: minOptional(plan.max_input_tokens, cap.max_input_tokens),
    max_output_tokens: minOptional(plan.max_output_tokens, cap.max_output_tokens),
    max_total_tokens: minOptional(plan.max_total_tokens, cap.max_total_tokens),
    max_duration_ms: minOptional(plan.max_duration_ms, cap.max_duration_ms),
    max_handoffs: minOptional(plan.max_handoffs, cap.max_handoffs),
    max_context_bytes: minOptional(plan.max_context_bytes, cap.max_context_bytes),
    ...(plan.max_cost !== undefined || cap.max_cost !== undefined
      ? { max_cost: minOptional(plan.max_cost ?? Number.POSITIVE_INFINITY, cap.max_cost) }
      : {}),
  });
}

function minOptional(planValue: number, capValue: number | undefined): number {
  return capValue === undefined ? planValue : Math.min(planValue, capValue);
}

function toolAllowedByPolicy(tool: { tool_name: string; tool_version: string; risk_level: ToolRiskLevel }, policy: TenantRuntimePolicy): boolean {
  if (toolDeniedByPolicy(tool, policy)) {
    return false;
  }
  return policy.allowed_tools.some((rule) => rule.tool_name === tool.tool_name && ruleMatchesVersion(rule, tool.tool_version) && riskWithinRule(tool.risk_level, rule));
}

function toolDeniedByPolicy(tool: { tool_name: string; tool_version: string; risk_level: ToolRiskLevel }, policy: TenantRuntimePolicy): boolean {
  return policy.denied_tools.some((rule) => rule.tool_name === tool.tool_name && ruleMatchesVersion(rule, tool.tool_version));
}

function operationsForTool(tool: { tool_name: string; tool_version: string }, policy: TenantRuntimePolicy): TenantPolicyOperation[] {
  const rules = policy.allowed_tools.filter((rule) => rule.tool_name === tool.tool_name && ruleMatchesVersion(rule, tool.tool_version));
  return [...new Set(rules.flatMap((rule) => rule.allowed_operations))].sort();
}

function modelAllowedByPolicy(model: { model_id: string; aliases: string[] }, policy: TenantRuntimePolicy): boolean {
  const aliases = new Set([model.model_id, ...model.aliases]);
  if (policy.denied_models.some((rule) => aliases.has(rule.model_id))) {
    return false;
  }
  return policy.allowed_models.some((rule) => aliases.has(rule.model_id));
}

function handoffAllowedByPolicy(handoff: string, policy: TenantRuntimePolicy): boolean {
  if (policy.denied_handoffs.some((rule) => handoffRuleMatches(rule, handoff))) {
    return false;
  }
  return policy.allowed_handoffs.some((rule) => handoffRuleMatches(rule, handoff));
}

function handoffRuleMatches(rule: TenantPolicyHandoffRule, handoff: string): boolean {
  return rule.execution_plan_refs?.includes(handoff) || rule.flow_id === handoff;
}

function ruleMatchesVersion(rule: TenantPolicyToolRule, version: string): boolean {
  return !rule.versions?.length || rule.versions.includes(version);
}

function riskWithinRule(riskLevel: ToolRiskLevel, rule: TenantPolicyToolRule): boolean {
  if (!rule.max_risk_level) {
    return true;
  }
  return riskRank(riskLevel) <= riskRank(rule.max_risk_level);
}

function riskRank(riskLevel: ToolRiskLevel): number {
  return Number(riskLevel.slice(1));
}

function issue(code: string, message: string, path?: string): RegistryValidationResult['errors'][number] {
  return { code, message, severity: code.includes('WARNING') ? 'warning' : 'error', ...(path ? { path } : {}) };
}

function containsWildcard(policy: TenantRuntimePolicy): boolean {
  return [...policy.allowed_tools.map((rule) => rule.tool_name), ...policy.allowed_models.map((rule) => rule.model_id)]
    .some((value) => value === '*' || value.toLowerCase() === 'all');
}

function containsSecretLikeValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return /authorization|api[_-]?key|secret|credential|password|bearer\s+/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsSecretLikeValue);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => /authorization|api[_-]?key|secret|credential|password/iu.test(key) || containsSecretLikeValue(entry));
  }
  return false;
}

function isProductionMockModel(modelId: string): boolean {
  return modelId.startsWith('mock:');
}

function manifestVersionToRegistryVersion(toolVersion: string): number {
  const [major] = toolVersion.split('.');
  const parsed = Number(major);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}
