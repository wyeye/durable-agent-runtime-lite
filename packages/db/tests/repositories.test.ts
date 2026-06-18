import { describe, expect, it } from 'vitest';
import type {
  FlowSpec,
  HumanTask,
  IdempotencyRecord,
  RouteSpec,
  TaskRun,
  ToolCallLog,
  ToolManifest,
} from '@dar/contracts';
import {
  buildDbFlowSnapshotRef,
  FlowDefinitionRepository,
  hashJson,
  HumanTaskRepository,
  IdempotencyRecordRepository,
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

  returning() {
    return this;
  }

  returningAll() {
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
    const value = this.first ?? this.rows[0];
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
  steps: [{ id: 'search', type: 'tool', tool: 'knowledge.search', input: { query: '${input.query}' } }],
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
