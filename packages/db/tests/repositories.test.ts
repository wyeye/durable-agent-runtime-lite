import { describe, expect, it } from 'vitest';
import type {
  AgentExecutionPlan,
  EvaluationCase,
  FlowExecutionPlan,
  FlowSpec,
  HumanTask,
  IdempotencyRecord,
  ResolvedModelPolicy,
  RouteSpec,
  TaskRun,
  ToolCallLog,
  ToolManifest,
} from '@dar/contracts';
import { tenantRuntimePolicySchema } from '@dar/contracts';
import {
  agentExecutionPlanContentHash,
  AgentContextSnapshotRepository,
  AgentExecutionPlanRepository,
  AgentStepRepository,
  buildExecutionPlanRef,
  buildAgentExecutionPlanRef,
  buildDbFlowSnapshotRef,
  FlowDefinitionRepository,
  FlowExecutionPlanRepository,
  hashJson,
  HumanTaskRepository,
  IdempotencyRecordRepository,
  parseAgentOutputSchema,
  parseDbFlowSnapshotRef,
  RouteConfigRepository,
  stableStringify,
  TaskRunRepository,
  TenantAgentAdmissionRepository,
  TenantRuntimePolicySnapshotRepository,
  hashTenantRuntimePolicy,
  ToolCallLogRepository,
  ToolManifestRepository,
  AuditEventRepository,
  EvaluationComparisonService,
  buildCandidateAgentExecutionPlan,
  assertCandidateFidelity,
  EvaluationGateError,
  EvaluationGateService,
  EvaluationScoringEngine,
  hashEvaluationCandidateBundle,
  hashEvaluationDataset,
  hashEvaluationGatePolicy,
  ModelPolicyRepository,
} from '../src/index.js';

class FakeQuery {
  private rows: unknown[];
  private first: unknown;
  private shouldReturnAll = false;

  constructor(rows: unknown[] = [], first?: unknown) {
    this.rows = rows;
    this.first = first;
  }

  select() {
    return this;
  }

  selectAll() {
    return this;
  }

  where() {
    return this;
  }

  orderBy() {
    return this;
  }

  values(value: unknown) {
    this.first = value;
    return this;
  }

  onConflict() {
    return this;
  }

  is() {
    return this;
  }

  column() {
    return this;
  }

  columns() {
    return this;
  }

  doNothing() {
    return this;
  }

  doUpdateSet() {
    return this;
  }

  returning() {
    return this;
  }

  returningAll() {
    this.shouldReturnAll = true;
    return this;
  }

  set(value: unknown) {
    this.first = { ...(this.rows[0] as object | undefined), ...(value as object) };
    return this;
  }

  async execute() {
    return this.rows;
  }

  async executeTakeFirst() {
    return this.first ?? this.rows[0];
  }

  async executeTakeFirstOrThrow() {
    const value = this.shouldReturnAll && this.first ? this.first : (this.first ?? this.rows[0]);
    if (!value) {
      throw new Error('missing fake row');
    }
    return value;
  }
}

class FakeDb {
  calls: Array<{ op: string; table: string }> = [];

  constructor(private readonly rows: Record<string, unknown[]>) {}

  selectFrom(table: string) {
    this.calls.push({ op: 'select', table });
    return new FakeQuery(this.rows[table] ?? []);
  }

  insertInto(table: string) {
    this.calls.push({ op: 'insert', table });
    return new FakeQuery(this.rows[table] ?? []);
  }

  updateTable(table: string) {
    this.calls.push({ op: 'update', table });
    return new FakeQuery(this.rows[table] ?? []);
  }
}

const flowSpec: FlowSpec = {
  flow_id: 'db_route_flow',
  version: 7,
  status: 'published',
  runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
  steps: [
    {
      id: 'search',
      type: 'tool',
      tool: 'knowledge.search',
      tool_version: '1.0.0',
      input: { query: '${input.query}' },
    },
  ],
};

const routeSpec: RouteSpec = {
  route_id: 'db_route',
  flow_id: 'db_route_flow',
  version: 7,
  status: 'published',
  route: {
    priority: 99,
    keywords: ['db-only'],
    examples: [],
    negative_examples: [],
    supported_channels: [],
    role_constraints: [],
    confidence_threshold: 0.5,
    ambiguous_threshold: 0.3,
  },
};

const toolManifest: ToolManifest = {
  tool_name: 'knowledge.search',
  version: '1.0.0',
  status: 'published',
  risk_level: 'L1',
  side_effect: false,
  adapter: { type: 'mock' },
  input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
  required_permissions: [],
};

function modelPolicyFixture(modelPolicyId: string, version: number) {
  return {
    model_policy_id: modelPolicyId,
    version,
    status: 'published' as const,
    protocol: 'dar_generate' as const,
    targets: [
      {
        target_id: `${modelPolicyId}-target`,
        gateway_profile: 'local-mock',
        model_id: `deterministic:${modelPolicyId}`,
        priority: 0,
        enabled: true,
        capabilities: ['text' as const],
      },
    ],
    retry_policy: {
      max_attempts_per_target: 1,
      retryable_status_codes: [429, 500],
      retry_on_timeout: true,
      retry_on_network_error: true,
      backoff_ms: 0,
      max_backoff_ms: 0,
    },
    fallback_policy: {
      enabled: false,
      ordered_target_ids: [],
      eligible_error_classes: [],
      stop_on_auth_error: true,
      stop_on_validation_error: true,
      stop_on_policy_denial: true,
    },
    request_policy: {
      temperature: 0,
      top_p: 1,
      max_output_tokens: 1000,
      initial_tool_choice_mode: 'auto' as const,
      after_tool_result_tool_choice_mode: 'auto' as const,
      response_format: 'text' as const,
      allow_parallel_tool_calls: false,
    },
    revision: 1,
  };
}

function evaluationCaseFixture(caseId: string, weight = 1): EvaluationCase {
  return {
    case_id: caseId,
    dataset_id: 'runtime-agent-core-v1',
    dataset_version: 1,
    name: caseId,
    input: { text: caseId },
    expected_tool_calls: [],
    forbidden_tools: [],
    final_assertions: [],
    policy_assertions: [],
    context_refs: [],
    weight,
    tags: [],
    enabled: true,
  };
}

describe('db repositories', () => {
  it('builds stable hashes and DB flow refs', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }));

    const ref = buildDbFlowSnapshotRef('db_route_flow', 7);
    expect(ref).toBe('db://flow/db_route_flow/versions/7');
    expect(parseDbFlowSnapshotRef(ref)).toEqual({ flowId: 'db_route_flow', version: 7 });
    expect(parseDbFlowSnapshotRef('sample_flow@1')).toBeUndefined();
    expect(buildExecutionPlanRef('plan_1')).toBe('db://flow-execution-plan/plan_1');
  });

  it('normalizes AgentSpec output_schema refs and JSON schema strings', () => {
    expect(parseAgentOutputSchema('agent_run_result_v1')).toEqual({ $ref: 'agent_run_result_v1' });
    expect(parseAgentOutputSchema('{"type":"object"}')).toEqual({ type: 'object' });
    expect(parseAgentOutputSchema(undefined)).toBeUndefined();
    expect(() => parseAgentOutputSchema('not valid json ref!')).toThrow(
      /schema ref or JSON object string/u,
    );
  });

  it('loads published FlowSpec, RouteSpec, and ToolManifest from the DB tables', async () => {
    const db = new FakeDb({
      flow_definition: [{ spec_json: flowSpec }],
      flow_route_config: [{ route_spec_json: routeSpec }],
      tool_manifest: [{ spec_json: toolManifest }],
    });

    await expect(
      new FlowDefinitionRepository(db as never).getPublished('db_route_flow', 7),
    ).resolves.toMatchObject({
      flow_id: 'db_route_flow',
      version: 7,
    });
    await expect(new RouteConfigRepository(db as never).listPublished()).resolves.toEqual([
      routeSpec,
    ]);
    await expect(
      new ToolManifestRepository(db as never).getPublished('knowledge.search'),
    ).resolves.toMatchObject({
      tool_name: 'knowledge.search',
    });

    expect(db.calls.map((call) => call.table)).toEqual([
      'flow_definition',
      'flow_route_config',
      'tool_manifest',
    ]);
  });

  it('normalizes legacy ModelPolicy request_policy tool_choice_mode from DB rows', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    const db = new FakeDb({
      model_policy: [
        {
          tenant_id: 'tenant_1',
          model_policy_id: 'legacy_model_policy',
          version: 1,
          status: 'published',
          protocol: 'dar_generate',
          targets_json: [
            {
              target_id: 'primary',
              gateway_profile: 'local-deterministic',
              model_id: 'deterministic:final_only',
              priority: 0,
              enabled: true,
              capabilities: ['text'],
            },
          ],
          retry_policy_json: {},
          fallback_policy_json: {},
          request_policy_json: {
            temperature: 0,
            top_p: 1,
            max_output_tokens: 1000,
            tool_choice_mode: 'auto',
            response_format: 'text',
            allow_parallel_tool_calls: false,
          },
          revision: 1,
          created_by: null,
          updated_by: null,
          published_by: 'seed-examples',
          created_at: now,
          updated_at: now,
          published_at: now,
        },
      ],
    });

    const policy = await new ModelPolicyRepository(db as never).getByIdAndVersion('legacy_model_policy', 1, {
        tenantId: 'tenant_1',
      });

    expect(policy).toMatchObject({
      model_policy_id: 'legacy_model_policy',
      request_policy: {
        initial_tool_choice_mode: 'auto',
        after_tool_result_tool_choice_mode: 'auto',
      },
    });
    expect(policy?.request_policy).not.toHaveProperty('tool_choice_mode');
  });

  it('hashes evaluation datasets, candidate bundles, and gate policies with exact content', () => {
    const hash = 'a'.repeat(64);
    const datasetHash = hashEvaluationDataset({
      dataset_id: 'runtime-agent-core-v1',
      version: 1,
      name: 'Runtime Agent Core',
      status: 'published',
      tags: ['runtime'],
      default_weight: 1,
      revision: 1,
    });
    expect(datasetHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(datasetHash).not.toBe(hashEvaluationDataset({
      dataset_id: 'runtime-agent-core-v1',
      version: 1,
      name: 'Runtime Agent Core changed',
      status: 'published',
      tags: ['runtime'],
      default_weight: 1,
      revision: 1,
    }));

    const bundleHash = hashEvaluationCandidateBundle({
      primary_subject_type: 'prompt',
      primary_subject_id: 'sample_prompt',
      primary_subject_version: 1,
      primary_subject_hash: hash,
      agent_id: 'sample_agent',
      agent_version: 1,
      agent_hash: hash,
      prompt_id: 'sample_prompt',
      prompt_version: 1,
      prompt_hash: hash,
      model_policy_id: 'local-ollama-qwen25-7b',
      model_policy_version: 1,
      model_policy_hash: hash,
      agent_execution_plan_ref: 'db://agent-execution-plan/sample_agent_plan',
      agent_execution_plan_hash: hash,
      tool_refs: [],
      tenant_policy_snapshot_ref: 'db://tenant-runtime-policy-snapshot/snapshot_1',
      tenant_policy_snapshot_hash: hash,
    });
    expect(bundleHash).toMatch(/^[a-f0-9]{64}$/u);

    const policyHash = hashEvaluationGatePolicy({
      gate_policy_id: 'registry-publish-v1',
      version: 1,
      status: 'published',
      resource_types: ['prompt', 'agent', 'model_policy'],
      required_dataset_refs: ['runtime-agent-core-v1@1#abc'],
      thresholds: { minimum_pass_rate: 1 },
      regression_rules: {},
      required_case_tags: [],
      allow_override: true,
      revision: 1,
    });
    expect(policyHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('builds prompt candidate execution plans with candidate prompt content, not agent current prompt', () => {
    const agentHash = 'a'.repeat(64);
    const oldPromptHash = 'b'.repeat(64);
    const candidatePromptHash = 'c'.repeat(64);
    const modelPolicyHash = 'd'.repeat(64);
    const plan = buildCandidateAgentExecutionPlan({
      tenantId: 'tenant_1',
      agent: {
        sha256: agentHash,
        spec: {
          agent_id: 'agent_1',
          version: 1,
          status: 'published',
          prompt_ref: 'prompt_old@1',
          model_policy: 'deterministic:final_only',
          model_policy_ref: {
            model_policy_id: 'policy_1',
            model_policy_version: 1,
            model_policy_hash: modelPolicyHash,
          },
          allowed_tools: [],
          allowed_handoffs: [],
          max_steps: 3,
          max_tokens: 1000,
        },
      },
      prompt: {
        sha256: candidatePromptHash,
        spec: {
          prompt_id: 'prompt_candidate',
          version: 2,
          name: 'candidate',
          content: 'candidate prompt content',
          variables: [],
          status: 'draft',
        },
      },
      modelPolicy: modelPolicyFixture('policy_1', 1),
      modelPolicyHash,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(plan.prompt_id).toBe('prompt_candidate');
    expect(plan.prompt_sha256).toBe(candidatePromptHash);
    expect(plan.plan.system_prompt).toBe('candidate prompt content');
    expect(plan.plan.prompt_sha256).not.toBe(oldPromptHash);
  });

  it('builds agent candidate execution plans from candidate agent dependencies', () => {
    const agentHash = 'e'.repeat(64);
    const promptHash = 'f'.repeat(64);
    const modelPolicyHash = '1'.repeat(64);
    const plan = buildCandidateAgentExecutionPlan({
      tenantId: 'tenant_1',
      agent: {
        sha256: agentHash,
        spec: {
          agent_id: 'agent_candidate',
          version: 3,
          status: 'draft',
          prompt_ref: 'prompt_candidate@7',
          model_policy: 'deterministic:readonly_tool',
          model_policy_ref: {
            model_policy_id: 'policy_candidate',
            model_policy_version: 4,
            model_policy_hash: modelPolicyHash,
          },
          allowed_tools: [],
          allowed_handoffs: ['flow_next'],
          max_steps: 5,
          max_tokens: 2000,
        },
      },
      prompt: {
        sha256: promptHash,
        spec: {
          prompt_id: 'prompt_candidate',
          version: 7,
          name: 'candidate',
          content: 'agent candidate prompt',
          variables: [],
          status: 'published',
        },
      },
      modelPolicy: modelPolicyFixture('policy_candidate', 4),
      modelPolicyHash,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(plan.agent_id).toBe('agent_candidate');
    expect(plan.agent_sha256).toBe(agentHash);
    expect(plan.prompt_id).toBe('prompt_candidate');
    expect(plan.model_policy_id).toBe('policy_candidate');
    expect(plan.allowed_handoffs).toEqual(['flow_next']);
    expect(plan.budget.max_segments).toBe(5);
  });

  it('builds model policy candidate execution plans with candidate resolved model policy', () => {
    const modelPolicyHash = '2'.repeat(64);
    const plan = buildCandidateAgentExecutionPlan({
      tenantId: 'tenant_1',
      agent: {
        sha256: '3'.repeat(64),
        spec: {
          agent_id: 'agent_1',
          version: 1,
          status: 'published',
          prompt_ref: 'prompt_1@1',
          model_policy: 'deterministic:old',
          model_policy_ref: {
            model_policy_id: 'old_policy',
            model_policy_version: 1,
            model_policy_hash: '4'.repeat(64),
          },
          allowed_tools: [],
          allowed_handoffs: [],
          max_steps: 3,
          max_tokens: 1000,
        },
      },
      prompt: {
        sha256: '5'.repeat(64),
        spec: {
          prompt_id: 'prompt_1',
          version: 1,
          name: 'prompt',
          content: 'prompt',
          variables: [],
          status: 'published',
        },
      },
      modelPolicy: modelPolicyFixture('candidate_policy', 9),
      modelPolicyHash,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(plan.model_policy_id).toBe('candidate_policy');
    expect(plan.model_policy_version).toBe(9);
    expect(plan.model_policy_hash).toBe(modelPolicyHash);
    expect(plan.plan.resolved_model_policy.model_policy_id).toBe('candidate_policy');
    expect(plan.plan.resolved_model_policy.model_policy_hash).not.toBe('4'.repeat(64));
  });

  it('fails closed when subject snapshot candidate bundle and execution plan hashes diverge', () => {
    const hash = '6'.repeat(64);
    const plan = buildCandidateAgentExecutionPlan({
      tenantId: 'tenant_1',
      agent: {
        sha256: hash,
        spec: {
          agent_id: 'agent_1',
          version: 1,
          status: 'published',
          prompt_ref: 'prompt_1@1',
          model_policy: 'deterministic:final_only',
          model_policy_ref: {
            model_policy_id: 'policy_1',
            model_policy_version: 1,
            model_policy_hash: hash,
          },
          allowed_tools: [],
          allowed_handoffs: [],
          max_steps: 3,
          max_tokens: 1000,
        },
      },
      prompt: {
        sha256: hash,
        spec: {
          prompt_id: 'prompt_1',
          version: 1,
          name: 'prompt',
          content: 'prompt',
          variables: [],
          status: 'published',
        },
      },
      modelPolicy: modelPolicyFixture('policy_1', 1),
      modelPolicyHash: hash,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const bundle = {
      primary_subject_type: 'prompt' as const,
      primary_subject_id: 'prompt_1',
      primary_subject_version: 1,
      primary_subject_hash: hash,
      agent_id: 'agent_1',
      agent_version: 1,
      agent_hash: hash,
      prompt_id: 'prompt_1',
      prompt_version: 1,
      prompt_hash: hash,
      model_policy_id: 'policy_1',
      model_policy_version: 1,
      model_policy_hash: hash,
      agent_execution_plan_ref: plan.execution_plan_ref,
      agent_execution_plan_hash: '7'.repeat(64),
      tool_refs: [],
      tenant_policy_snapshot_ref: 'db://tenant-runtime-policy-snapshot/snapshot_1',
      tenant_policy_snapshot_hash: hash,
    };

    expect(() => assertCandidateFidelity({
      subjectSnapshot: {
        subject_snapshot_id: 'snapshot_1',
        subject_snapshot_ref: 'db://evaluation-subject-snapshot/snapshot_1',
        primary_subject_type: 'prompt',
        primary_subject_id: 'prompt_1',
        primary_subject_version: 1,
        primary_subject_hash: hash,
        candidate_bundle: bundle,
        candidate_bundle_hash: hashEvaluationCandidateBundle(bundle),
        created_at: '2026-01-01T00:00:00.000Z',
      },
      agentExecutionPlan: plan,
    })).toThrow(/fidelity mismatch/u);
  });

  it('scores evaluation cases with safety hard gates independent of averages', () => {
    const evaluationCase: EvaluationCase = {
      case_id: 'case_forbidden',
      dataset_id: 'runtime-agent-core-v1',
      dataset_version: 1,
      name: 'forbidden tool',
      input: { text: 'do not write' },
      expected_status: 'completed',
      expected_tool_calls: [],
      forbidden_tools: ['record.write.real'],
      final_assertions: [{ type: 'non_empty' }],
      policy_assertions: [],
      context_refs: [],
      weight: 1,
      tags: [],
      enabled: true,
    };
    const result = new EvaluationScoringEngine().scoreCase({
      evaluationCase,
      actualStatus: 'completed',
      finalOutput: 'done',
      toolCalls: [{ tool_name: 'record.write.real', arguments: {} }],
      policyViolations: 0,
      unauthorizedToolCount: 0,
      sideEffectWithoutApprovalCount: 0,
      secretLeakCount: 0,
      hiddenReasoningLeakCount: 0,
      crossTenantViolationCount: 0,
    });
    expect(result.status).toBe('failed');
    expect(result.score).toBe(0);
    expect(result.metric_results.some((metric) => metric.metric_name === 'forbidden_tool_count' && metric.hard_gate && !metric.passed)).toBe(true);
  });

  it('does not fail a case solely because a continuous score is below one', () => {
    const baseCase: EvaluationCase = {
      case_id: 'case_partial_score',
      dataset_id: 'runtime-agent-core-v1',
      dataset_version: 1,
      name: 'partial score',
      input: { text: 'answer' },
      expected_tool_calls: [
        {
          tool_name: 'knowledge.search',
          min_calls: 1,
          max_calls: 3,
          argument_match_mode: 'ignore',
          expected_arguments: {},
        },
      ],
      forbidden_tools: [],
      final_assertions: [],
      policy_assertions: [],
      context_refs: [],
      weight: 1,
      tags: [],
      enabled: true,
    };
    const partial = new EvaluationScoringEngine().scoreCase({
      evaluationCase: baseCase,
      actualStatus: 'completed',
      finalOutput: 'done',
      toolCalls: [
        { tool_name: 'knowledge.search', arguments: {} },
        { tool_name: 'knowledge.search', arguments: {} },
      ],
    });
    expect(partial.score).toBeLessThan(1);
    expect(partial.status).toBe('passed');

    const requiredMinimum = new EvaluationScoringEngine().scoreCase({
      evaluationCase: { ...baseCase, minimum_case_score: 0.9 },
      actualStatus: 'completed',
      finalOutput: 'done',
      toolCalls: [
        { tool_name: 'knowledge.search', arguments: {} },
        { tool_name: 'knowledge.search', arguments: {} },
      ],
    });
    expect(requiredMinimum.status).toBe('failed');
  });

  it('treats cancelled evaluation cases as skipped and excludes them from weighted score', () => {
    const cases: EvaluationCase[] = [
      evaluationCaseFixture('case_passed', 2),
      evaluationCaseFixture('case_cancelled', 3),
    ];
    const aggregate = new EvaluationScoringEngine().aggregate({
      runId: 'run_cancelled',
      cases,
      results: [
        {
          evaluation_case_result_id: 'result_passed',
          evaluation_run_id: 'run_cancelled',
          case_id: 'case_passed',
          status: 'passed',
          score: 1,
          metric_results: [],
          candidate_fidelity_verified: true,
          assertion_failure_count: 0,
          hard_gate_failure_count: 0,
          model_call_ids: [],
          tool_call_ids: [],
        },
        {
          evaluation_case_result_id: 'result_cancelled',
          evaluation_run_id: 'run_cancelled',
          case_id: 'case_cancelled',
          status: 'cancelled',
          score: 0,
          metric_results: [],
          candidate_fidelity_verified: true,
          assertion_failure_count: 0,
          hard_gate_failure_count: 0,
          model_call_ids: [],
          tool_call_ids: [],
        },
      ],
    });

    expect(aggregate.completed_cases).toBe(1);
    expect(aggregate.skipped_cases).toBe(1);
    expect(aggregate.weighted_score).toBe(1);
    expect(aggregate.pass_rate).toBe(1);
  });

  it('compares evaluation runs only when dataset versions match', () => {
    const comparison = new EvaluationComparisonService().compare({
      candidateRun: {
        evaluation_run_id: 'run_b',
        tenant_id: 'default',
        dataset_id: 'runtime-agent-core-v1',
        dataset_version: 2,
        dataset_hash: 'b'.repeat(64),
        subject_snapshot_ref: 'snapshot_b',
        subject_snapshot_hash: 'b'.repeat(64),
        evaluation_execution_plan_ref: 'plan_b',
        evaluation_execution_plan_hash: 'b'.repeat(64),
        trigger_type: 'regression',
        status: 'completed',
        total_cases: 1,
        completed_cases: 1,
        passed_cases: 0,
        failed_cases: 1,
        skipped_cases: 0,
        aggregate_score: 0,
      },
      candidateResults: [],
      baselineRun: {
        evaluation_run_id: 'run_a',
        tenant_id: 'default',
        dataset_id: 'runtime-agent-core-v1',
        dataset_version: 1,
        dataset_hash: 'a'.repeat(64),
        subject_snapshot_ref: 'snapshot_a',
        subject_snapshot_hash: 'a'.repeat(64),
        evaluation_execution_plan_ref: 'plan_a',
        evaluation_execution_plan_hash: 'a'.repeat(64),
        trigger_type: 'manual',
        status: 'completed',
        total_cases: 1,
        completed_cases: 1,
        passed_cases: 1,
        failed_cases: 0,
        skipped_cases: 0,
        aggregate_score: 1,
      },
      baselineResults: [],
    });
    expect(comparison.comparable).toBe(false);
    expect(comparison.regression_severity).toBe('not_comparable');
  });

  it('fails closed for publish gates unless an exact passed decision exists', async () => {
    const resourceHash = 'c'.repeat(64);
    const bundleHash = 'd'.repeat(64);
    const policyHash = 'e'.repeat(64);
    const noPolicyDb = new FakeDb({ evaluation_gate_policy: [], audit_event: [] });

    await expect(new EvaluationGateService(noPolicyDb as never).assertPublishAllowed({
      resourceType: 'prompt',
      resourceId: 'release_prompt',
      resourceVersion: 1,
      resourceHash,
      candidateBundleHash: bundleHash,
      operatorId: 'operator',
      tenantId: 'tenant_1',
      mode: 'required',
    })).rejects.toMatchObject({
      name: 'EvaluationGateError',
      code: 'EVALUATION_GATE_REQUIRED',
    } satisfies Partial<EvaluationGateError>);

    await expect(new EvaluationGateService(noPolicyDb as never).assertPublishAllowed({
      resourceType: 'prompt',
      resourceId: 'release_prompt',
      resourceVersion: 1,
      resourceHash,
      candidateBundleHash: bundleHash,
      operatorId: 'operator',
      tenantId: 'tenant_1',
      mode: 'advisory',
    })).resolves.toMatchObject({
      warning: expect.stringContaining('EVALUATION_GATE_REQUIRED'),
    });

    const now = '2026-01-01T00:00:00.000Z';
    const passedDb = new FakeDb({
      evaluation_gate_policy: [
        {
          gate_policy_id: 'registry-publish-v1',
          version: 1,
          status: 'published',
          resource_types_json: ['prompt'],
          required_dataset_refs_json: ['runtime-agent-core-v1@1#abc'],
          thresholds_json: { minimum_pass_rate: 1 },
          regression_rules_json: {},
          required_case_tags_json: [],
          allow_override: false,
          revision: 1,
          gate_policy_hash: policyHash,
          created_by: 'operator',
          updated_by: 'operator',
          published_by: 'operator',
          created_at: now,
          updated_at: now,
          published_at: now,
        },
      ],
      evaluation_gate_decision: [
        {
          gate_decision_id: 'gate_decision_passed',
          resource_type: 'prompt',
          resource_id: 'release_prompt',
          resource_version: 1,
          resource_hash: resourceHash,
          candidate_bundle_hash: bundleHash,
          gate_policy_id: 'registry-publish-v1',
          gate_policy_version: 1,
          gate_policy_hash: policyHash,
          evaluation_run_ids_json: ['run_1'],
          decision: 'passed',
          reasons_json: [],
          decided_at: now,
          created_at: now,
        },
      ],
    });

    await expect(new EvaluationGateService(passedDb as never).assertPublishAllowed({
      resourceType: 'prompt',
      resourceId: 'release_prompt',
      resourceVersion: 1,
      resourceHash,
      candidateBundleHash: bundleHash,
      operatorId: 'operator',
      tenantId: 'tenant_1',
      mode: 'required',
    })).resolves.toMatchObject({
      decision: { gate_decision_id: 'gate_decision_passed', decision: 'passed' },
    });
  });

  it('stores and verifies FlowExecutionPlan by immutable ref', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    const plan: FlowExecutionPlan = {
      execution_plan_id: 'plan_1',
      execution_plan_ref: buildExecutionPlanRef('plan_1'),
      tenant_id: 'tenant_1',
      flow_id: flowSpec.flow_id,
      flow_version: flowSpec.version,
      flow_sha256: hashJson(flowSpec),
      flow_spec: flowSpec,
      agents: [],
      tools: [],
      allowed_tools: [],
      budget: { max_steps: 0, max_tokens: 0 },
      generated_at: now,
      execution_plan_hash: hashJson({
        execution_plan_id: 'plan_1',
        execution_plan_ref: buildExecutionPlanRef('plan_1'),
        tenant_id: 'tenant_1',
        flow_id: flowSpec.flow_id,
        flow_version: flowSpec.version,
        flow_sha256: hashJson(flowSpec),
        flow_spec: flowSpec,
        agents: [],
        tools: [],
        allowed_tools: [],
        budget: { max_steps: 0, max_tokens: 0 },
        generated_at: now,
      }),
    };
    const db = new FakeDb({
      flow_execution_plan: [
        {
          execution_plan_id: plan.execution_plan_id,
          execution_plan_ref: plan.execution_plan_ref,
          tenant_id: plan.tenant_id,
          flow_id: plan.flow_id,
          flow_version: plan.flow_version,
          flow_sha256: plan.flow_sha256,
          plan_json: plan,
          execution_plan_hash: plan.execution_plan_hash,
          generated_at: now,
        },
      ],
    });

    await expect(
      new FlowExecutionPlanRepository(db as never).getByRef(plan.execution_plan_ref, {
        tenantId: 'tenant_1',
      }),
    ).resolves.toEqual(plan);
  });

  it('validates tenant runtime policy schema, stable hash, snapshots, and admission stores', async () => {
    const policy = tenantRuntimePolicySchema.parse({
      tenant_id: 'tenant_policy_test',
      version: 1,
      status: 'draft',
      allowed_tools: [
        {
          tool_name: 'knowledge.search',
          versions: ['1.0.0'],
          allowed_operations: ['invoke', 'preview', 'commit'],
          max_risk_level: 'L1',
        },
      ],
      denied_tools: [
        {
          tool_name: 'record.write.mock',
          allowed_operations: ['invoke', 'preview', 'commit'],
          reason_code: 'DENY_WRITE',
        },
      ],
      allowed_models: [{ model_id: 'deterministic:readonly_tool' }],
      denied_models: [{ model_id: 'deterministic:l3_tool', reason_code: 'DENY_L3_MODEL' }],
      allowed_handoffs: [{ flow_id: 'sample_flow', versions: [1] }],
      denied_handoffs: [],
      budget_cap: { max_segments: 2, max_tool_calls: 1, max_total_tokens: 1000 },
      max_concurrent_agent_runs: 1,
    });
    expect(hashTenantRuntimePolicy(policy)).toBe(
      hashTenantRuntimePolicy({ ...policy, updated_by: 'ignored' }),
    );

    const snapshotRepo = new TenantRuntimePolicySnapshotRepository(
      new FakeDb({
        tenant_runtime_policy_snapshot: [],
      }) as never,
    );
    await expect(
      snapshotRepo.verifyHash('missing', 'a'.repeat(64), { tenantId: policy.tenant_id }),
    ).resolves.toBe(false);

    const admissionRepo = new TenantAgentAdmissionRepository(
      new FakeDb({
        tenant_agent_admission: [],
      }) as never,
    );
    await expect(admissionRepo.getActiveCount(policy.tenant_id)).resolves.toBe(0);
  });

  it('creates immutable tenant policy snapshots with root and child lineage in the snapshot hash', async () => {
    const policy = tenantRuntimePolicySchema.parse({
      tenant_id: 'tenant_policy_lineage_test',
      version: 1,
      status: 'published',
      allowed_tools: [
        {
          tool_name: 'knowledge.search',
          versions: ['1.0.0'],
          allowed_operations: ['invoke'],
          max_risk_level: 'L1',
        },
      ],
      denied_tools: [],
      allowed_models: [{ model_id: 'deterministic:readonly_tool' }],
      denied_models: [],
      allowed_handoffs: [],
      denied_handoffs: [],
      budget_cap: {
        max_segments: 2,
        max_model_turns: 2,
        max_tool_calls: 1,
        max_total_tokens: 1000,
      },
      max_concurrent_agent_runs: 1,
    });
    const policyHash = hashTenantRuntimePolicy(policy);
    const resolvedPolicy = {
      resolved_allowed_tools: policy.allowed_tools,
      resolved_denied_tools: policy.denied_tools,
      resolved_allowed_models: policy.allowed_models,
      resolved_allowed_handoffs: policy.allowed_handoffs,
      resolved_budget: {
        max_segments: 2,
        max_model_turns: 2,
        max_tool_calls: 1,
        max_input_tokens: 0,
        max_output_tokens: 0,
        max_total_tokens: 1000,
        max_duration_ms: 300000,
        max_handoffs: 0,
        max_context_bytes: 262144,
      },
      max_concurrent_agent_runs: 1,
    };
    const repository = new TenantRuntimePolicySnapshotRepository(
      new FakeDb({
        tenant_runtime_policy_snapshot: [],
      }) as never,
    );

    const root = await repository.createImmutableSnapshot({
      tenantId: policy.tenant_id,
      policy,
      policyHash,
      executionPlanRef: 'db://flow-execution-plan/root',
      executionPlanHash: 'a'.repeat(64),
      executionPlanType: 'flow',
      resolvedPolicy,
    });
    expect(root).toMatchObject({
      tenant_id: policy.tenant_id,
      root_snapshot_ref: root.snapshot_ref,
      derivation_type: 'root',
      lineage_depth: 0,
      source_policy_version: 1,
      source_policy_hash: policyHash,
    });
    expect(root.parent_snapshot_ref).toBeUndefined();

    const child = await repository.createImmutableSnapshot({
      tenantId: policy.tenant_id,
      policy,
      policyHash,
      executionPlanRef: 'db://agent-execution-plan/child',
      executionPlanHash: 'b'.repeat(64),
      executionPlanType: 'agent',
      rootSnapshotRef: root.snapshot_ref,
      parentSnapshotRef: root.snapshot_ref,
      derivationType: 'flow_agent_child',
      lineageDepth: 1,
      resolvedPolicy,
    });
    expect(child).toMatchObject({
      tenant_id: policy.tenant_id,
      root_snapshot_ref: root.snapshot_ref,
      parent_snapshot_ref: root.snapshot_ref,
      derivation_type: 'flow_agent_child',
      lineage_depth: 1,
      execution_plan_ref: 'db://agent-execution-plan/child',
    });
    expect(child.snapshot_hash).not.toBe(root.snapshot_hash);

    const siblingWithDifferentParent = await repository.createImmutableSnapshot({
      tenantId: policy.tenant_id,
      policy,
      policyHash,
      executionPlanRef: 'db://agent-execution-plan/child',
      executionPlanHash: 'b'.repeat(64),
      executionPlanType: 'agent',
      rootSnapshotRef: root.snapshot_ref,
      parentSnapshotRef: 'db://tenant-runtime-policy-snapshot/different_parent',
      derivationType: 'flow_agent_child',
      lineageDepth: 1,
      resolvedPolicy,
    });
    expect(siblingWithDifferentParent.snapshot_hash).not.toBe(child.snapshot_hash);

    await expect(
      repository.createImmutableSnapshot({
        tenantId: policy.tenant_id,
        policy,
        policyHash,
        executionPlanRef: 'db://flow-execution-plan/invalid',
        executionPlanHash: 'c'.repeat(64),
        executionPlanType: 'flow',
        parentSnapshotRef: root.snapshot_ref,
        derivationType: 'root',
        resolvedPolicy,
      }),
    ).rejects.toThrow(/Root TenantRuntimePolicySnapshot/u);
  });

  it('stores and verifies AgentExecutionPlan by immutable ref without adapter secrets', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    const hash = 'd'.repeat(64);
    const resolvedModelPolicy: ResolvedModelPolicy = {
      model_policy_id: 'deterministic-final',
      model_policy_version: 1,
      model_policy_hash: hash,
      protocol: 'dar_generate',
      resolved_targets: [
        {
          target_id: 'deterministic-final-target',
          gateway_profile: 'local-mock',
          model_id: 'deterministic:final_only',
          priority: 0,
          enabled: true,
          capabilities: ['text'],
        },
      ],
      retry_policy: {
        max_attempts_per_target: 1,
        retryable_status_codes: [429, 500],
        retry_on_timeout: true,
        retry_on_network_error: true,
        backoff_ms: 0,
        max_backoff_ms: 0,
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
    };
    const executionPlanRef = buildAgentExecutionPlanRef('agent_plan_1');
    const planWithoutHash = {
      execution_plan_id: 'agent_plan_1',
      execution_plan_ref: executionPlanRef,
      tenant_id: 'tenant_1',
      agent_id: 'agent_1',
      agent_version: 1,
      agent_sha256: hash,
      prompt_id: 'prompt_1',
      prompt_version: 1,
      prompt_sha256: hash,
      model_policy: 'deterministic:final_only',
      model_policy_id: resolvedModelPolicy.model_policy_id,
      model_policy_version: resolvedModelPolicy.model_policy_version,
      model_policy_hash: resolvedModelPolicy.model_policy_hash,
      resolved_model_policy: resolvedModelPolicy,
      allowed_tools: [
        {
          tool_name: 'knowledge.search',
          tool_version: '1.0.0',
          tool_sha256: hash,
          description: 'Search',
          risk_level: 'L1',
          input_schema: { type: 'object' },
        },
      ],
      allowed_handoffs: [],
      budget: {
        max_segments: 3,
        max_model_turns: 6,
        max_tool_calls: 1,
        max_input_tokens: 0,
        max_output_tokens: 0,
        max_total_tokens: 1000,
        max_duration_ms: 300000,
        max_handoffs: 0,
        max_context_bytes: 262144,
      },
      plan: {
        agent_id: 'agent_1',
        agent_version: 1,
        agent_sha256: hash,
        prompt_id: 'prompt_1',
        prompt_version: 1,
        prompt_sha256: hash,
        system_prompt: 'safe prompt',
        model_policy: 'deterministic:final_only',
        model_policy_id: resolvedModelPolicy.model_policy_id,
        model_policy_version: resolvedModelPolicy.model_policy_version,
        model_policy_hash: resolvedModelPolicy.model_policy_hash,
        resolved_model_policy: resolvedModelPolicy,
        allowed_tools: [
          {
            tool_name: 'knowledge.search',
            tool_version: '1.0.0',
            tool_sha256: hash,
            description: 'Search',
            risk_level: 'L1',
            input_schema: { type: 'object' },
          },
        ],
        allowed_handoffs: [],
        budget: {
          max_segments: 3,
          max_model_turns: 6,
          max_tool_calls: 1,
          max_input_tokens: 0,
          max_output_tokens: 0,
          max_total_tokens: 1000,
          max_duration_ms: 300000,
          max_handoffs: 0,
          max_context_bytes: 262144,
        },
      },
      generated_at: now,
    };
    const plan = {
      ...planWithoutHash,
      execution_plan_hash: hashJson({
        execution_plan_id: planWithoutHash.execution_plan_id,
        execution_plan_ref: planWithoutHash.execution_plan_ref,
        tenant_id: planWithoutHash.tenant_id,
        agent_id: planWithoutHash.agent_id,
        agent_version: planWithoutHash.agent_version,
        agent_sha256: planWithoutHash.agent_sha256,
        prompt_id: planWithoutHash.prompt_id,
        prompt_version: planWithoutHash.prompt_version,
        prompt_sha256: planWithoutHash.prompt_sha256,
        model_policy: planWithoutHash.model_policy,
        model_policy_id: planWithoutHash.model_policy_id,
        model_policy_version: planWithoutHash.model_policy_version,
        model_policy_hash: planWithoutHash.model_policy_hash,
        resolved_model_policy: planWithoutHash.resolved_model_policy,
        allowed_tools: planWithoutHash.allowed_tools,
        allowed_handoffs: planWithoutHash.allowed_handoffs,
        budget: planWithoutHash.budget,
        plan: planWithoutHash.plan,
        generated_at: planWithoutHash.generated_at,
      }),
    };
    const db = new FakeDb({
      agent_execution_plan: [
        {
          execution_plan_id: plan.execution_plan_id,
          execution_plan_ref: plan.execution_plan_ref,
          tenant_id: plan.tenant_id,
          agent_id: plan.agent_id,
          agent_version: plan.agent_version,
          agent_sha256: plan.agent_sha256,
          prompt_id: plan.prompt_id,
          prompt_version: plan.prompt_version,
          prompt_sha256: plan.prompt_sha256,
          model_policy_json: { value: plan.model_policy },
          model_policy_id: plan.model_policy_id,
          model_policy_version: plan.model_policy_version,
          model_policy_hash: plan.model_policy_hash,
          resolved_model_policy_json: plan.resolved_model_policy,
          allowed_tools_json: plan.allowed_tools,
          allowed_handoffs_json: plan.allowed_handoffs,
          output_schema_json: null,
          budget_json: plan.budget,
          plan_json: plan,
          execution_plan_hash: plan.execution_plan_hash,
          generated_at: now,
          created_at: now,
        },
      ],
    });

    await expect(
      new AgentExecutionPlanRepository(db as never).getByRef(executionPlanRef, {
        tenantId: 'tenant_1',
      }),
    ).resolves.toMatchObject({
      execution_plan_ref: executionPlanRef,
      allowed_tools: [{ tool_name: 'knowledge.search' }],
    });
    await expect(
      new AgentExecutionPlanRepository(db as never).verifyHash(
        executionPlanRef,
        plan.execution_plan_hash,
        { tenantId: 'tenant_1' },
      ),
    ).resolves.toBe(true);
    expect(JSON.stringify(plan.allowed_tools)).not.toMatch(/authorization|api_key|endpoint_ref/i);
  });

  it('compares AgentExecutionPlan content without generated ids or timestamps for idempotent regeneration', () => {
    const hash = 'e'.repeat(64);
    const resolvedModelPolicy: ResolvedModelPolicy = {
      model_policy_id: 'deterministic-final',
      model_policy_version: 1,
      model_policy_hash: hash,
      protocol: 'dar_generate',
      resolved_targets: [
        {
          target_id: 'deterministic-final-target',
          gateway_profile: 'local-mock',
          model_id: 'deterministic:final_only',
          priority: 0,
          enabled: true,
          capabilities: ['text'],
        },
      ],
      retry_policy: {
        max_attempts_per_target: 1,
        retryable_status_codes: [429, 500],
        retry_on_timeout: true,
        retry_on_network_error: true,
        backoff_ms: 0,
        max_backoff_ms: 0,
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
    };
    const basePlan: Omit<
      AgentExecutionPlan,
      'execution_plan_id' | 'execution_plan_ref' | 'execution_plan_hash' | 'generated_at'
    > = {
      tenant_id: 'tenant_1',
      agent_id: 'agent_1',
      agent_version: 1,
      agent_sha256: hash,
      prompt_id: 'prompt_1',
      prompt_version: 1,
      prompt_sha256: hash,
      model_policy: 'deterministic:final_only',
      model_policy_id: resolvedModelPolicy.model_policy_id,
      model_policy_version: resolvedModelPolicy.model_policy_version,
      model_policy_hash: resolvedModelPolicy.model_policy_hash,
      resolved_model_policy: resolvedModelPolicy,
      allowed_tools: [],
      allowed_handoffs: [],
      budget: {
        max_segments: 3,
        max_model_turns: 3,
        max_tool_calls: 0,
        max_input_tokens: 0,
        max_output_tokens: 0,
        max_total_tokens: 1000,
        max_duration_ms: 300000,
        max_handoffs: 0,
        max_context_bytes: 262144,
      },
      plan: {
        agent_id: 'agent_1',
        agent_version: 1,
        agent_sha256: hash,
        prompt_id: 'prompt_1',
        prompt_version: 1,
        prompt_sha256: hash,
        system_prompt: 'safe prompt',
        model_policy: 'deterministic:final_only',
        model_policy_id: resolvedModelPolicy.model_policy_id,
        model_policy_version: resolvedModelPolicy.model_policy_version,
        model_policy_hash: resolvedModelPolicy.model_policy_hash,
        resolved_model_policy: resolvedModelPolicy,
        allowed_tools: [],
        allowed_handoffs: [],
        budget: {
          max_segments: 3,
          max_model_turns: 3,
          max_tool_calls: 0,
          max_input_tokens: 0,
          max_output_tokens: 0,
          max_total_tokens: 1000,
          max_duration_ms: 300000,
          max_handoffs: 0,
          max_context_bytes: 262144,
        },
      },
    };
    const firstPlan: AgentExecutionPlan = {
      ...basePlan,
      execution_plan_id: 'agent_plan_1',
      execution_plan_ref: buildAgentExecutionPlanRef('agent_plan_1'),
      execution_plan_hash: hashJson({ ...basePlan, execution_plan_id: 'agent_plan_1' }),
      generated_at: '2026-01-01T00:00:00.000Z',
    };
    const regeneratedPlan: AgentExecutionPlan = {
      ...basePlan,
      execution_plan_id: 'agent_plan_2',
      execution_plan_ref: buildAgentExecutionPlanRef('agent_plan_2'),
      execution_plan_hash: hashJson({ ...basePlan, execution_plan_id: 'agent_plan_2' }),
      generated_at: '2026-01-02T00:00:00.000Z',
    };
    const changedPlan: AgentExecutionPlan = {
      ...regeneratedPlan,
      model_policy: 'deterministic:readonly_tool',
      plan: {
        ...regeneratedPlan.plan,
        model_policy: 'deterministic:readonly_tool',
      },
    };

    expect(firstPlan.execution_plan_hash).not.toBe(regeneratedPlan.execution_plan_hash);
    expect(agentExecutionPlanContentHash(firstPlan)).toBe(
      agentExecutionPlanContentHash(regeneratedPlan),
    );
    expect(agentExecutionPlanContentHash(firstPlan)).not.toBe(
      agentExecutionPlanContentHash(changedPlan),
    );
  });

  it('returns idempotency replay or conflict from stored request hash', async () => {
    const record: IdempotencyRecord = {
      idempotency_key: 'tenant_1:tool:idem_1',
      tenant_id: 'tenant_1',
      target_type: 'tool',
      target_id: 'knowledge.search',
      request_hash: 'hash_1',
      response_json: { status: 'succeeded' },
      status: 'succeeded',
      created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    const db = new FakeDb({ idempotency_record: [record] });
    const repository = new IdempotencyRecordRepository(db as never);

    await expect(
      repository.replayOrConflict({
        idempotencyKey: record.idempotency_key,
        tenantId: 'tenant_1',
        targetType: 'tool',
        targetId: 'knowledge.search',
        requestHash: 'hash_1',
      }),
    ).resolves.toMatchObject({ decision: 'replay' });

    await expect(
      repository.replayOrConflict({
        idempotencyKey: record.idempotency_key,
        tenantId: 'tenant_1',
        targetType: 'tool',
        targetId: 'knowledge.search',
        requestHash: 'hash_2',
      }),
    ).resolves.toMatchObject({ decision: 'conflict' });
  });

  it('updates task_run status with failure error details', async () => {
    const taskRunRow: TaskRun = {
      task_run_id: 'task_failed',
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      route_type: 'matched',
      flow_id: 'sample_flow',
      flow_version: 1,
      workflow_id: 'workflow_1',
      status: 'running',
      created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    const db = new FakeDb({ task_run: [taskRunRow] });

    await expect(
      new TaskRunRepository(db as never).updateStatus('task_failed', {
        status: 'failed',
        errorCode: 'TOOL_FAILED',
        errorMessage: 'tool gateway request failed',
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      error_code: 'TOOL_FAILED',
      error_message: 'tool gateway request failed',
    });

    expect(db.calls.map((call) => call.table)).toEqual(['task_run']);
  });

  it('approves and rejects human tasks with decision metadata', async () => {
    const humanTask: HumanTask = {
      human_task_id: 'human_1',
      tenant_id: 'tenant_1',
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
      kind: 'approval',
      status: 'pending',
      candidate_groups: [],
      payload: { tool_call_id: 'tool_call_1' },
      created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    const db = new FakeDb({ human_task: [humanTask] });
    const repository = new HumanTaskRepository(db as never);

    await expect(
      repository.approve('human_1', {
        tenantId: 'tenant_1',
        decidedBy: 'approver_1',
        decisionReason: 'approved in test',
        payload: { note: 'ok' },
      }),
    ).resolves.toMatchObject({
      status: 'approved',
      decided_by: 'approver_1',
      decision_reason: 'approved in test',
      decision: { status: 'approved', payload: { note: 'ok' } },
    });

    await expect(
      repository.reject('human_1', {
        tenantId: 'tenant_1',
        decidedBy: 'approver_2',
        decisionReason: 'not safe',
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      decided_by: 'approver_2',
      decision_reason: 'not safe',
    });
  });

  it('stores context snapshot refs by stable hash', async () => {
    const db = new FakeDb({ agent_context_snapshot: [] });
    const repository = new AgentContextSnapshotRepository(db as never);

    await expect(
      repository.create({
        snapshotId: 'snapshot_1',
        agentRunId: 'agent_run_1',
        schemaVersion: 'pi-context/v1',
        sanitizedMessages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      }),
    ).resolves.toMatchObject({
      snapshot_id: 'snapshot_1',
      schema_version: 'pi-context/v1',
      message_count: 1,
    });
  });

  it('updates AgentStep boundary results without creating a second step', async () => {
    const now = new Date('2025-01-01T00:00:00.000Z').toISOString();
    const db = new FakeDb({
      agent_step: [
        {
          agent_step_id: 'agent_step_1',
          agent_run_id: 'agent_run_1',
          segment_index: 0,
          stable_step_key: 'agent_run_1:0',
          segment_status: 'waiting_tool',
          decision_summary: 'Pi requested 1 tool call(s)',
          proposed_tool_calls_json: [],
          tool_result_refs_json: [],
          authoritative_tool_result_refs_json: [],
          human_task_ids_json: [],
          context_snapshot_before_ref: null,
          context_snapshot_after_ref: null,
          handoff_refs_json: [],
          context_snapshot_ref: null,
          output_ref: null,
          usage_json: {},
          error_code: null,
          error_message: null,
          created_at: now,
          updated_at: now,
        },
      ],
    });

    await expect(
      new AgentStepRepository(db as never).updateBoundaryResult({
        stableStepKey: 'agent_run_1:0',
        segmentStatus: 'tool_resolved',
        authoritativeToolResultRefs: [
          {
            tool_call_id: 'call_1',
            tool_name: 'knowledge.search',
            tool_version: '1.0.0',
            result_ref: 'tool-call:tool_call_1',
            status: 'succeeded',
            is_error: false,
          },
        ],
        contextSnapshotAfter: {
          snapshot_id: 'snapshot_after',
          schema_version: 'pi-context/v1',
          snapshot_hash: 'a'.repeat(64),
          message_count: 4,
          byte_size: 512,
        },
        contextSnapshotRef: {
          snapshot_id: 'snapshot_after',
          schema_version: 'pi-context/v1',
          snapshot_hash: 'a'.repeat(64),
          message_count: 4,
          byte_size: 512,
        },
      }),
    ).resolves.toMatchObject({
      stable_step_key: 'agent_run_1:0',
      segment_status: 'tool_resolved',
      tool_result_refs: [{ result_ref: 'tool-call:tool_call_1' }],
      authoritative_tool_result_refs: [{ tool_call_id: 'call_1' }],
      context_snapshot_after: { snapshot_id: 'snapshot_after' },
    });
  });

  it('loads and updates tool_call_log status by stable tool_call_id', async () => {
    const toolCall: ToolCallLog = {
      tool_call_id: 'tool_call_1',
      task_run_id: 'task_1',
      workflow_id: 'workflow_1',
      tenant_id: 'tenant_1',
      user_id: 'user_1',
      tool_name: 'record.write.mock',
      tool_version: '1.0.0',
      risk_level: 'L3',
      policy_decision: 'require_human_confirm',
      status: 'pending_confirmation',
      mode: 'preview',
      idempotency_key: 'task_1:record.write.mock:preview',
      input_hash: 'input_hash',
      preview_json: { planned: true },
      created_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      updated_at: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    const db = new FakeDb({ tool_call_log: [toolCall] });
    const repository = new ToolCallLogRepository(db as never);

    await expect(repository.get('tool_call_1')).resolves.toMatchObject({
      tool_call_id: 'tool_call_1',
      status: 'pending_confirmation',
      preview_json: { planned: true },
    });

    await expect(
      repository.update('tool_call_1', {
        status: 'committed',
        mode: 'commit',
        result_json: { written: true },
        output_hash: 'output_hash',
      }),
    ).resolves.toMatchObject({
      tool_call_id: 'tool_call_1',
      status: 'committed',
      mode: 'commit',
      result_json: { written: true },
      output_hash: 'output_hash',
    });
  });

  it('stores audit event keys for retry-safe logical events', async () => {
    const db = new FakeDb({ audit_event: [] });
    const repository = new AuditEventRepository(db as never);

    await expect(
      repository.append({
        event_key: 'agent.admission.reconciled:tenant_1:admission_1',
        tenant_id: 'tenant_1',
        actor_id: 'system:admission-reconcile',
        action: 'agent.admission.reconciled',
        target_type: 'tenant_agent_admission',
        target_id: 'admission_1',
        result: 'succeeded',
        reason: 'workflow_completed',
        payload: {
          tenant_id: 'tenant_1',
          task_run_id: 'task_1',
          tenant_admission_id: 'admission_1',
        },
      }),
    ).resolves.toMatchObject({
      event_key: 'agent.admission.reconciled:tenant_1:admission_1',
      action: 'agent.admission.reconciled',
      payload: { tenant_admission_id: 'admission_1' },
    });
  });
});
