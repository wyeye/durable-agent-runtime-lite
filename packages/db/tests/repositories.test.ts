import { describe, expect, it } from 'vitest';
import type {
  AgentExecutionPlan,
  FlowExecutionPlan,
  FlowSpec,
  HumanTask,
  IdempotencyRecord,
  RouteSpec,
  TaskRun,
  ToolCallLog,
  ToolManifest,
} from '@dar/contracts';
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
  ToolCallLogRepository,
  ToolManifestRepository,
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
    const value = this.shouldReturnAll && this.first ? this.first : this.first ?? this.rows[0];
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
  steps: [{ id: 'search', type: 'tool', tool: 'knowledge.search', tool_version: '1.0.0', input: { query: '${input.query}' } }],
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
    expect(() => parseAgentOutputSchema('not valid json ref!')).toThrow(/schema ref or JSON object string/u);
  });

  it('loads published FlowSpec, RouteSpec, and ToolManifest from the DB tables', async () => {
    const db = new FakeDb({
      flow_definition: [{ spec_json: flowSpec }],
      flow_route_config: [{ route_spec_json: routeSpec }],
      tool_manifest: [{ spec_json: toolManifest }],
    });

    await expect(new FlowDefinitionRepository(db as never).getPublished('db_route_flow', 7)).resolves.toMatchObject({
      flow_id: 'db_route_flow',
      version: 7,
    });
    await expect(new RouteConfigRepository(db as never).listPublished()).resolves.toEqual([routeSpec]);
    await expect(new ToolManifestRepository(db as never).getPublished('knowledge.search')).resolves.toMatchObject({
      tool_name: 'knowledge.search',
    });

    expect(db.calls.map((call) => call.table)).toEqual([
      'flow_definition',
      'flow_route_config',
      'tool_manifest',
    ]);
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

    await expect(new FlowExecutionPlanRepository(db as never).getByRef(plan.execution_plan_ref, { tenantId: 'tenant_1' })).resolves.toEqual(plan);
  });

  it('stores and verifies AgentExecutionPlan by immutable ref without adapter secrets', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    const hash = 'd'.repeat(64);
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
      allowed_tools: [{
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        tool_sha256: hash,
        description: 'Search',
        risk_level: 'L1',
        input_schema: { type: 'object' },
      }],
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
        allowed_tools: [{
          tool_name: 'knowledge.search',
          tool_version: '1.0.0',
          tool_sha256: hash,
          description: 'Search',
          risk_level: 'L1',
          input_schema: { type: 'object' },
        }],
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
      execution_plan_hash: hashJson(planWithoutHash),
    };
    const db = new FakeDb({
      agent_execution_plan: [{
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
        allowed_tools_json: plan.allowed_tools,
        allowed_handoffs_json: plan.allowed_handoffs,
        output_schema_json: null,
        budget_json: plan.budget,
        plan_json: plan,
        execution_plan_hash: plan.execution_plan_hash,
        generated_at: now,
        created_at: now,
      }],
    });

    await expect(new AgentExecutionPlanRepository(db as never).getByRef(executionPlanRef, { tenantId: 'tenant_1' })).resolves.toMatchObject({
      execution_plan_ref: executionPlanRef,
      allowed_tools: [{ tool_name: 'knowledge.search' }],
    });
    await expect(new AgentExecutionPlanRepository(db as never).verifyHash(executionPlanRef, plan.execution_plan_hash, { tenantId: 'tenant_1' })).resolves.toBe(true);
    expect(JSON.stringify(plan.allowed_tools)).not.toMatch(/authorization|api_key|endpoint_ref/i);
  });

  it('compares AgentExecutionPlan content without generated ids or timestamps for idempotent regeneration', () => {
    const hash = 'e'.repeat(64);
    const basePlan: Omit<AgentExecutionPlan, 'execution_plan_id' | 'execution_plan_ref' | 'execution_plan_hash' | 'generated_at'> = {
      tenant_id: 'tenant_1',
      agent_id: 'agent_1',
      agent_version: 1,
      agent_sha256: hash,
      prompt_id: 'prompt_1',
      prompt_version: 1,
      prompt_sha256: hash,
      model_policy: 'deterministic:final_only',
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
    expect(agentExecutionPlanContentHash(firstPlan)).toBe(agentExecutionPlanContentHash(regeneratedPlan));
    expect(agentExecutionPlanContentHash(firstPlan)).not.toBe(agentExecutionPlanContentHash(changedPlan));
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
      agent_step: [{
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
      }],
    });

    await expect(new AgentStepRepository(db as never).updateBoundaryResult({
      stableStepKey: 'agent_run_1:0',
      segmentStatus: 'tool_resolved',
      authoritativeToolResultRefs: [{
        tool_call_id: 'call_1',
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        result_ref: 'tool-call:tool_call_1',
        status: 'succeeded',
        is_error: false,
      }],
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
    })).resolves.toMatchObject({
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
});
