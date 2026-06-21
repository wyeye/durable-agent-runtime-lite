import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  EvaluationCaseRepository,
  EvaluationDatasetRepository,
  EvaluationGatePolicyRepository,
  sql,
  ToolCallLogRepository,
} from '../src/index.js';

const runPostgres = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres('evaluation repositories with PostgreSQL', () => {
  it('reuses outer transactions for evaluation tool call reservations', async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string });
    const tenantId = `eval_reservation_${randomUUID()}`;
    const runId = `eval_run_${randomUUID()}`;
    const caseId = `case_${randomUUID()}`;
    class RollbackProbe extends Error {}

    try {
      await db.transaction().execute(async (trx) => {
        const reservation = await new ToolCallLogRepository(trx).reserveEvaluationLogicalCall({
          tenantId,
          evaluationRunId: runId,
          evaluationCaseId: caseId,
          toolName: 'knowledge.search',
          toolVersion: '1.0.0',
          logicalToolCallId: 'logical_1',
          operation: 'invoke',
          limit: 1,
        });
        expect(reservation.allowed).toBe(true);
        throw new RollbackProbe();
      }).catch((error: unknown) => {
        if (!(error instanceof RollbackProbe)) {
          throw error;
        }
      });

      const count = await sql<{ count: string }>`
        select count(*)::text as count
        from evaluation_tool_call_reservation
        where tenant_id = ${tenantId}
          and evaluation_run_id = ${runId}
          and evaluation_case_id = ${caseId}
      `.execute(db);
      expect(Number(count.rows[0]?.count ?? 0)).toBe(0);
    } finally {
      await sql`delete from evaluation_tool_call_reservation where tenant_id = ${tenantId}`.execute(db);
      await closeDb(db);
    }
  });

  it('round-trips evaluation jsonb fields through PostgreSQL', async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string });
    const suffix = randomUUID();
    const datasetId = `eval_jsonb_${suffix}`;
    const gatePolicyId = `eval_gate_jsonb_${suffix}`;
    try {
      const datasets = new EvaluationDatasetRepository(db);
      const cases = new EvaluationCaseRepository(db);
      const gatePolicies = new EvaluationGatePolicyRepository(db);

      const dataset = await datasets.createDraft({
        dataset_id: datasetId,
        version: 1,
        name: 'Evaluation JSONB roundtrip',
        status: 'draft',
        tags: ['runtime', 'jsonb'],
        default_weight: 1,
        revision: 1,
      }, { tenantId: 'tenant_1', operatorId: 'operator' });
      expect(dataset.tags).toEqual(['runtime', 'jsonb']);

      const evaluationCase = await cases.upsert({
        case_id: `case_${suffix}`,
        dataset_id: datasetId,
        dataset_version: 1,
        name: 'JSONB case',
        input: { text: 'case_jsonb' },
        expected_tool_calls: [{
          tool_name: 'knowledge.search',
          min_calls: 1,
          max_calls: 1,
          argument_match_mode: 'ignore',
          expected_arguments: {},
        }],
        forbidden_tools: [],
        final_assertions: [],
        policy_assertions: [],
        context_refs: ['ctx://jsonb'],
        weight: 1,
        tags: ['jsonb-case'],
        enabled: true,
      }, { tenantId: 'tenant_1', operatorId: 'operator' });
      expect(evaluationCase.input).toEqual({ text: 'case_jsonb' });
      expect(evaluationCase.expected_tool_calls).toHaveLength(1);
      expect(evaluationCase.context_refs).toEqual(['ctx://jsonb']);
      expect(evaluationCase.tags).toEqual(['jsonb-case']);

      await datasets.validate(datasetId, 1, { tenantId: 'tenant_1', operatorId: 'operator' });
      const published = await datasets.publish(datasetId, 1, { tenantId: 'tenant_1', operatorId: 'operator' });
      expect(published.dataset_hash).toMatch(/^[a-f0-9]{64}$/u);

      const gatePolicy = await gatePolicies.createDraft({
        gate_policy_id: gatePolicyId,
        version: 1,
        status: 'draft',
        resource_types: ['prompt'],
        required_dataset_refs: [{
          dataset_id: datasetId,
          version: 1,
          dataset_hash: published.dataset_hash,
        }],
        thresholds: { minimum_pass_rate: 1 },
        regression_rules: {},
        required_case_tags: ['jsonb-case'],
        allow_override: true,
        revision: 1,
      }, { tenantId: 'tenant_1', operatorId: 'operator' });
      expect(gatePolicy.resource_types).toEqual(['prompt']);
      expect(gatePolicy.required_dataset_refs).toEqual([{
        dataset_id: datasetId,
        version: 1,
        dataset_hash: published.dataset_hash,
      }]);
      expect(gatePolicy.required_case_tags).toEqual(['jsonb-case']);
    } finally {
      await sql`delete from evaluation_gate_policy where gate_policy_id = ${gatePolicyId}`.execute(db);
      await sql`delete from evaluation_dataset where dataset_id = ${datasetId}`.execute(db);
      await closeDb(db);
    }
  });
});
