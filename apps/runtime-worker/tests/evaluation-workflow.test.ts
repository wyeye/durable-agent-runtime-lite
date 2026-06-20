import { Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EvaluationAggregateResult,
  EvaluationCaseResult,
  EvaluationRun,
} from '@dar/contracts';
import { ApplicationFailure } from '@temporalio/workflow';
import { TASK_QUEUES } from '@dar/temporal';

let environment: TestWorkflowEnvironment | undefined;

describe('Evaluation workflows', () => {
  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it('isolates child case system errors and finalizes only after comparison and gate decision', async () => {
    const calls: string[] = [];
    const caseResults: EvaluationCaseResult[] = [];
    const aggregate: EvaluationAggregateResult = {
      evaluation_run_id: 'eval_run_workflow',
      total_cases: 2,
      completed_cases: 2,
      passed_cases: 1,
      failed_cases: 1,
      skipped_cases: 0,
      weighted_score: 0.5,
      pass_rate: 0.5,
      hard_gate_failures: [],
      metric_summary: { system_error_cases: 1 },
    };
    const worker = await createWorker({
      loadEvaluationRunPlanActivity: async () => {
        calls.push('load');
        return {
          run: evaluationRun({ baseline_run_id: 'eval_run_baseline' }),
          plan: {},
          subject_snapshot: {},
          cases: [
            { case_id: 'case_pass' },
            { case_id: 'case_pi_error' },
          ],
          max_concurrent_cases: 2,
          case_timeout_ms: 30_000,
        };
      },
      markEvaluationRunRunningActivity: async () => {
        calls.push('running');
        return evaluationRun({ status: 'running' });
      },
      verifyEvaluationCandidateFidelityActivity: async () => ({ verified: true }),
      prepareEvaluationCaseActivity: async (input: { case_id: string }) => ({
        task_run_id: `task_${input.case_id}`,
        agent_execution_plan_ref: 'db://agent-execution-plan/plan_eval',
        initial_user_input: input.case_id,
        tenant_policy_snapshot_ref: 'db://tenant-runtime-policy-snapshot/snapshot_eval',
        tenant_policy_hash: 'a'.repeat(64),
      }),
      createAgentRunActivity: async (input: { task_run_id: string }) => {
        return {
          agent_run_id: `agent_${input.task_run_id}`,
          task_run_id: input.task_run_id,
        };
      },
      loadAgentExecutionPlanByRefActivity: async () => agentExecutionPlan(),
      updateAgentRunActivity: async (input: { agent_run_id: string }) => ({
        agent_run_id: input.agent_run_id,
      }),
      updateAgentStepActivity: async () => ({}),
      runPiSegmentActivity: async (input: { agent_run_id: string }) => {
        if (input.agent_run_id.includes('case_pi_error')) {
          throw ApplicationFailure.nonRetryable('pi child failed for case', 'PI_CASE_FAILED');
        }
        return {
          status: 'completed',
          final_answer: 'ok',
          context_snapshot_ref: {
            snapshot_id: `snapshot_${input.agent_run_id}`,
            schema_version: 'pi-context/v1',
            snapshot_hash: 'e'.repeat(64),
            message_count: 1,
            byte_size: 128,
          },
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          model_turn_count: 1,
        };
      },
      collectAndScoreEvaluationCaseActivity: async (input: { case_id: string; task_run_id: string }) => {
        const result = caseResult({
          case_id: input.case_id,
          task_run_id: input.task_run_id,
          status: 'passed',
          score: 1,
        });
        caseResults.push(result);
        return result;
      },
      recordEvaluationCaseSystemErrorActivity: async (input: { case_id: string; task_run_id?: string }) => {
        const result = caseResult({
          case_id: input.case_id,
          task_run_id: input.task_run_id,
          status: 'system_error',
          score: 0,
          error_code: 'EVALUATION_CASE_SYSTEM_ERROR',
        });
        caseResults.push(result);
        return result;
      },
      aggregateEvaluationRunActivity: async () => {
        calls.push('aggregate');
        return aggregate;
      },
      compareEvaluationRunActivity: async () => {
        calls.push('compare');
        return {};
      },
      generateEvaluationGateDecisionActivity: async () => {
        calls.push('gate');
        return undefined;
      },
      completeEvaluationRunActivity: async () => {
        calls.push('complete');
        return evaluationRun({ status: 'completed' });
      },
      failEvaluationRunActivity: async () => {
        calls.push('fail');
        return evaluationRun({ status: 'failed' });
      },
      cancelEvaluationRunActivity: async () => {
        calls.push('cancel');
        return evaluationRun({ status: 'cancelled' });
      },
    });

    await worker.runUntil(async () => {
      const handle = await environment!.client.workflow.start('evaluationRunWorkflow', {
        taskQueue: TASK_QUEUES.evaluationWorkerMain,
        workflowId: 'evaluation-run-workflow-test',
        args: [{
          tenant_id: 'tenant_eval',
          user_id: 'operator_eval',
          evaluation_run_id: 'eval_run_workflow',
          evaluation_execution_plan_ref: 'db://evaluation-execution-plan/plan_eval',
          evaluation_execution_plan_hash: 'b'.repeat(64),
          request_id: 'req_eval',
        }],
      });
      const result = await handle.result();
      expect(result.cases).toHaveLength(2);
      expect(result.cases.map((entry) => entry.status).sort()).toEqual(['passed', 'system_error']);
      expect(caseResults.some((entry) => entry.status === 'system_error')).toBe(true);
      expect(calls).toEqual(['load', 'running', 'aggregate', 'compare', 'gate', 'complete']);
    });
  }, 30_000);
});

async function createWorker(overrides: Record<string, unknown>): Promise<Worker> {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  return Worker.create({
    connection: environment.nativeConnection,
    taskQueue: TASK_QUEUES.evaluationWorkerMain,
    workflowsPath: new URL('../src/workflows/index.ts', import.meta.url).pathname,
    activities: {
      loadEvaluationRunPlanActivity: async () => {
        throw new Error('loadEvaluationRunPlanActivity not mocked');
      },
      markEvaluationRunRunningActivity: async () => evaluationRun({ status: 'running' }),
      failEvaluationRunActivity: async () => evaluationRun({ status: 'failed' }),
      completeEvaluationRunActivity: async () => evaluationRun({ status: 'completed' }),
      cancelEvaluationRunActivity: async () => evaluationRun({ status: 'cancelled' }),
      verifyEvaluationCandidateFidelityActivity: async () => ({ verified: true }),
      prepareEvaluationCaseActivity: async () => {
        throw new Error('prepareEvaluationCaseActivity not mocked');
      },
      collectAndScoreEvaluationCaseActivity: async () => {
        throw new Error('collectAndScoreEvaluationCaseActivity not mocked');
      },
      recordEvaluationCaseSystemErrorActivity: async () => {
        throw new Error('recordEvaluationCaseSystemErrorActivity not mocked');
      },
      aggregateEvaluationRunActivity: async () => {
        throw new Error('aggregateEvaluationRunActivity not mocked');
      },
      compareEvaluationRunActivity: async () => undefined,
      generateEvaluationGateDecisionActivity: async () => undefined,
      createAgentRunActivity: async () => ({
        agent_run_id: 'agent_run_eval',
      }),
      loadAgentExecutionPlanByRefActivity: async () => {
        throw new Error('loadAgentExecutionPlanByRefActivity not mocked');
      },
      loadTenantPolicySnapshotActivity: async () => undefined,
      loadPiRuntimeConfigActivity: async () => ({ max_segments_before_continue_as_new: 20 }),
      updateAgentRunActivity: async () => ({ agent_run_id: 'agent_run_eval' }),
      updateAgentStepActivity: async () => ({}),
      runPiSegmentActivity: async () => {
        throw new Error('runPiSegmentActivity not mocked');
      },
      ...overrides,
    },
  });
}

function evaluationRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    evaluation_run_id: 'eval_run_workflow',
    tenant_id: 'tenant_eval',
    dataset_id: 'dataset_eval',
    dataset_version: 1,
    dataset_hash: 'c'.repeat(64),
    subject_snapshot_ref: 'db://evaluation-subject-snapshot/snapshot_eval',
    subject_snapshot_hash: 'd'.repeat(64),
    evaluation_execution_plan_ref: 'db://evaluation-execution-plan/plan_eval',
    evaluation_execution_plan_hash: 'b'.repeat(64),
    trigger_type: 'manual',
    status: 'queued',
    total_cases: 2,
    completed_cases: 0,
    passed_cases: 0,
    failed_cases: 0,
    skipped_cases: 0,
    system_error_cases: 0,
    evidence_collection_status: 'not_started',
    ...overrides,
  };
}

function agentExecutionPlan() {
  const resolvedModelPolicy = {
    model_policy_id: 'policy_eval',
    model_policy_version: 1,
    model_policy_hash: '2'.repeat(64),
    protocol: 'dar_generate',
    resolved_targets: [
      {
        target_id: 'target_eval',
        gateway_profile: 'deterministic',
        model_id: 'deterministic:final_only',
        priority: 0,
        enabled: true,
        capabilities: ['text'],
      },
    ],
    retry_policy: {
      max_attempts_per_target: 1,
      retryable_status_codes: [],
      retry_on_timeout: false,
      retry_on_network_error: false,
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
      max_output_tokens: 100,
      initial_tool_choice_mode: 'none',
      after_tool_result_tool_choice_mode: 'none',
      response_format: 'text',
      allow_parallel_tool_calls: false,
    },
  };
  const budget = {
    max_segments: 2,
    max_model_turns: 2,
    max_tool_calls: 0,
    max_input_tokens: 0,
    max_output_tokens: 0,
    max_total_tokens: 1000,
    max_duration_ms: 30_000,
    max_handoffs: 0,
    max_context_bytes: 262_144,
  };
  const plan = {
    agent_id: 'agent_eval',
    agent_version: 1,
    agent_sha256: 'f'.repeat(64),
    prompt_id: 'prompt_eval',
    prompt_version: 1,
    prompt_sha256: '1'.repeat(64),
    system_prompt: 'You are a test agent.',
    model_policy: 'deterministic:final_only',
    model_policy_id: 'policy_eval',
    model_policy_version: 1,
    model_policy_hash: '2'.repeat(64),
    resolved_model_policy: resolvedModelPolicy,
    allowed_tools: [],
    allowed_handoffs: [],
    output_schema: {},
    budget,
  };
  return {
    execution_plan_id: 'agent_plan_eval',
    execution_plan_ref: 'db://agent-execution-plan/plan_eval',
    tenant_id: 'tenant_eval',
    agent_id: 'agent_eval',
    agent_version: 1,
    agent_sha256: 'f'.repeat(64),
    prompt_id: 'prompt_eval',
    prompt_version: 1,
    prompt_sha256: '1'.repeat(64),
    model_policy: 'deterministic:final_only',
    model_policy_id: 'policy_eval',
    model_policy_version: 1,
    model_policy_hash: '2'.repeat(64),
    resolved_model_policy: resolvedModelPolicy,
    allowed_tools: [],
    allowed_handoffs: [],
    output_schema: {},
    budget,
    plan,
    generated_at: '2026-01-01T00:00:00.000Z',
    execution_plan_hash: '3'.repeat(64),
  };
}

function caseResult(
  overrides: Partial<EvaluationCaseResult> & Pick<EvaluationCaseResult, 'case_id' | 'status'>,
): EvaluationCaseResult {
  return {
    evaluation_case_result_id: `result_${overrides.case_id}`,
    evaluation_run_id: 'eval_run_workflow',
    score: overrides.status === 'passed' ? 1 : 0,
    metric_results: [],
    candidate_fidelity_verified: true,
    assertion_failure_count: 0,
    hard_gate_failure_count: 0,
    model_call_ids: [],
    tool_call_ids: [],
    ...overrides,
  };
}
