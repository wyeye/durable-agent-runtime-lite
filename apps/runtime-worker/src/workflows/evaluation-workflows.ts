import {
  ActivityCancellationType,
  CancellationScope,
  ChildWorkflowCancellationType,
  type ActivityOptions,
  executeChild,
  isCancellation,
  proxyActivities,
  rootCause,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  EvaluationCaseWorkflowInput,
  EvaluationRunWorkflowInput,
  PiDurableAgentWorkflowInput,
} from '@dar/temporal';
import { buildTaskWorkflowId } from '@dar/temporal';
import type {
  EvaluationAggregateResult,
  EvaluationCaseResult,
  EvaluationGateDecision,
  EvaluationRun,
} from '@dar/contracts';
import type {
  EvaluationCaseSummary,
  LoadEvaluationRunPlanActivityInput,
  LoadEvaluationRunPlanActivityResult,
  PrepareEvaluationCaseActivityResult,
} from '../activities/index.js';
import type { piDurableAgentWorkflow } from './pi-durable-agent-workflow.js';

type EvaluationActivities = {
  loadEvaluationRunPlanActivity(input: LoadEvaluationRunPlanActivityInput): Promise<LoadEvaluationRunPlanActivityResult>;
  markEvaluationRunRunningActivity(input: {
    evaluation_run_id: string;
    workflow_id: string;
    workflow_run_id?: string;
  }): Promise<EvaluationRun>;
  failEvaluationRunActivity(input: {
    evaluation_run_id: string;
    error_code: string;
    error_message: string;
  }): Promise<EvaluationRun>;
  completeEvaluationRunActivity(input: {
    evaluation_run_id: string;
    aggregate: EvaluationAggregateResult;
  }): Promise<EvaluationRun>;
  cancelEvaluationRunActivity(input: {
    evaluation_run_id: string;
    aggregate?: EvaluationAggregateResult;
  }): Promise<EvaluationRun>;
  verifyEvaluationCandidateFidelityActivity(input: {
    tenant_id: string;
    evaluation_execution_plan_ref: string;
    evaluation_execution_plan_hash: string;
  }): Promise<{ verified: true }>;
  prepareEvaluationCaseActivity(input: {
    tenant_id: string;
    user_id: string;
    evaluation_run_id: string;
    case_id: string;
    workflow_id: string;
    request_id: string;
    evaluation_execution_plan_ref: string;
    evaluation_execution_plan_hash: string;
  }): Promise<PrepareEvaluationCaseActivityResult>;
  collectAndScoreEvaluationCaseActivity(input: {
    tenant_id: string;
    evaluation_run_id: string;
    case_id: string;
    task_run_id: string;
    agent_run_id?: string;
    workflow_id: string;
    workflow_run_id?: string;
    started_at_ms?: number;
  }): Promise<EvaluationCaseResult>;
  recordEvaluationCaseSystemErrorActivity(input: {
    tenant_id: string;
    evaluation_run_id: string;
    case_id: string;
    task_run_id?: string;
    agent_run_id?: string;
    workflow_id: string;
    workflow_run_id?: string;
    started_at_ms?: number;
    error_code: string;
    error_message: string;
    cancelled?: boolean;
  }): Promise<EvaluationCaseResult>;
  aggregateEvaluationRunActivity(input: {
    evaluation_run_id: string;
  }): Promise<EvaluationAggregateResult>;
  compareEvaluationRunActivity(input: {
    candidate_run_id: string;
    baseline_run_id: string;
    created_by?: string;
    candidate_aggregate?: EvaluationAggregateResult;
  }): Promise<unknown>;
  generateEvaluationGateDecisionActivity(input: {
    evaluation_run_id: string;
  }): Promise<EvaluationGateDecision | undefined>;
};

const evaluationActivityOptions = {
  read: {
    startToCloseTimeout: '30 seconds',
    scheduleToCloseTimeout: '2 minutes',
    retry: {
      maximumAttempts: 3,
      nonRetryableErrorTypes: [
        'NOT_FOUND',
        'VALIDATION_FAILED',
        'EVALUATION_EXECUTION_PLAN_HASH_MISMATCH',
        'EVALUATION_SUBJECT_HASH_MISMATCH',
        'EVALUATION_CANDIDATE_FIDELITY_MISMATCH',
      ],
    },
  },
  write: {
    startToCloseTimeout: '30 seconds',
    scheduleToCloseTimeout: '2 minutes',
    retry: {
      maximumAttempts: 4,
      initialInterval: '1 second',
      maximumInterval: '10 seconds',
      nonRetryableErrorTypes: ['NOT_FOUND', 'VALIDATION_FAILED'],
    },
  },
  caseScore: {
    startToCloseTimeout: '45 seconds',
    scheduleToCloseTimeout: '3 minutes',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      maximumAttempts: 3,
      initialInterval: '1 second',
      maximumInterval: '10 seconds',
      nonRetryableErrorTypes: ['NOT_FOUND', 'VALIDATION_FAILED'],
    },
  },
} satisfies Record<string, ActivityOptions>;

const readActivities = proxyActivities<Pick<EvaluationActivities,
  'loadEvaluationRunPlanActivity' | 'verifyEvaluationCandidateFidelityActivity'
>>(evaluationActivityOptions.read);

const writeActivities = proxyActivities<Pick<EvaluationActivities,
  | 'markEvaluationRunRunningActivity'
  | 'failEvaluationRunActivity'
  | 'completeEvaluationRunActivity'
  | 'cancelEvaluationRunActivity'
  | 'aggregateEvaluationRunActivity'
  | 'compareEvaluationRunActivity'
  | 'generateEvaluationGateDecisionActivity'
>>(evaluationActivityOptions.write);

const caseActivities = proxyActivities<Pick<EvaluationActivities,
  'collectAndScoreEvaluationCaseActivity' | 'recordEvaluationCaseSystemErrorActivity'
>>(
  evaluationActivityOptions.caseScore,
);

const caseSetupActivities = proxyActivities<Pick<EvaluationActivities, 'prepareEvaluationCaseActivity'>>(
  evaluationActivityOptions.write,
);

export async function evaluationRunWorkflow(
  input: EvaluationRunWorkflowInput,
): Promise<{ evaluation_run_id: string; aggregate?: EvaluationAggregateResult; gate_decision?: EvaluationGateDecision; cases: EvaluationCaseSummary[] }> {
  const info = workflowInfo();
  try {
    const loaded = await readActivities.loadEvaluationRunPlanActivity({
      tenant_id: input.tenant_id,
      evaluation_run_id: input.evaluation_run_id,
      evaluation_execution_plan_ref: input.evaluation_execution_plan_ref,
      evaluation_execution_plan_hash: input.evaluation_execution_plan_hash,
    });
    const markedRun = await writeActivities.markEvaluationRunRunningActivity({
      evaluation_run_id: input.evaluation_run_id,
      workflow_id: info.workflowId,
      workflow_run_id: info.runId,
    });
    if (isCancellationRequested(markedRun)) {
      const aggregate = await writeActivities.aggregateEvaluationRunActivity({
        evaluation_run_id: input.evaluation_run_id,
      });
      await writeActivities.cancelEvaluationRunActivity({
        evaluation_run_id: input.evaluation_run_id,
        aggregate,
      });
      return {
        evaluation_run_id: input.evaluation_run_id,
        aggregate,
        cases: [],
      };
    }
    assertRunStatus(markedRun, 'running', 'start');
    const summaries: EvaluationCaseSummary[] = [];
    const maxConcurrentCases = loaded.max_concurrent_cases;
    for (let index = 0; index < loaded.cases.length; index += maxConcurrentCases) {
      const batch = loaded.cases.slice(index, index + maxConcurrentCases);
      const batchSummaries = await Promise.all(batch.map((evaluationCase) =>
        executeChild(evaluationCaseWorkflow, {
          workflowId: buildEvaluationCaseWorkflowId(input.tenant_id, input.evaluation_run_id, evaluationCase.case_id),
          cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
          workflowExecutionTimeout: `${loaded.case_timeout_ms} milliseconds`,
          args: [{
            tenant_id: input.tenant_id,
            user_id: input.user_id,
            evaluation_run_id: input.evaluation_run_id,
            case_id: evaluationCase.case_id,
            case_timeout_ms: loaded.case_timeout_ms,
            evaluation_execution_plan_ref: input.evaluation_execution_plan_ref,
            evaluation_execution_plan_hash: input.evaluation_execution_plan_hash,
            request_id: input.request_id,
            ...(input.trace_id ? { trace_id: input.trace_id } : {}),
          }],
        })
      ));
      summaries.push(...batchSummaries);
    }
    const aggregate = await writeActivities.aggregateEvaluationRunActivity({
      evaluation_run_id: input.evaluation_run_id,
    });
    if (loaded.run.baseline_run_id) {
      await writeActivities.compareEvaluationRunActivity({
        candidate_run_id: input.evaluation_run_id,
        baseline_run_id: loaded.run.baseline_run_id,
        created_by: input.user_id,
        candidate_aggregate: aggregate,
      });
    }
    const gateDecision = await writeActivities.generateEvaluationGateDecisionActivity({
      evaluation_run_id: input.evaluation_run_id,
    });
    const completedRun = await writeActivities.completeEvaluationRunActivity({
      evaluation_run_id: input.evaluation_run_id,
      aggregate,
    });
    if (isCancellationRequested(completedRun)) {
      await writeActivities.cancelEvaluationRunActivity({
        evaluation_run_id: input.evaluation_run_id,
        aggregate,
      });
      return {
        evaluation_run_id: input.evaluation_run_id,
        aggregate,
        cases: summaries,
      };
    }
    assertRunStatus(completedRun, 'completed', 'complete');
    return {
      evaluation_run_id: input.evaluation_run_id,
      aggregate,
      ...(gateDecision ? { gate_decision: gateDecision } : {}),
      cases: summaries,
    };
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(async () => {
        let aggregate: EvaluationAggregateResult | undefined;
        try {
          aggregate = await writeActivities.aggregateEvaluationRunActivity({
            evaluation_run_id: input.evaluation_run_id,
          });
        } catch {
          aggregate = undefined;
        }
        await writeActivities.cancelEvaluationRunActivity({
          evaluation_run_id: input.evaluation_run_id,
          ...(aggregate ? { aggregate } : {}),
        });
      });
      throw error;
    }
    await writeActivities.failEvaluationRunActivity({
      evaluation_run_id: input.evaluation_run_id,
      error_code: 'EVALUATION_RUN_WORKFLOW_FAILED',
      error_message: error instanceof Error ? error.message : 'Evaluation run workflow failed',
    });
    throw error;
  }
}

export async function evaluationCaseWorkflow(
  input: EvaluationCaseWorkflowInput,
): Promise<EvaluationCaseSummary> {
  const info = workflowInfo();
  const startedAtMs = Date.now();
  await readActivities.verifyEvaluationCandidateFidelityActivity({
    tenant_id: input.tenant_id,
    evaluation_execution_plan_ref: input.evaluation_execution_plan_ref,
    evaluation_execution_plan_hash: input.evaluation_execution_plan_hash,
  });
  const prepared = await caseSetupActivities.prepareEvaluationCaseActivity({
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    evaluation_run_id: input.evaluation_run_id,
    case_id: input.case_id,
    workflow_id: buildTaskWorkflowId(input.tenant_id, `eval_task_${input.evaluation_run_id}_${input.case_id}`),
    request_id: input.request_id,
    evaluation_execution_plan_ref: input.evaluation_execution_plan_ref,
    evaluation_execution_plan_hash: input.evaluation_execution_plan_hash,
  });
  const taskRunId = prepared.task_run_id;
  try {
    const agentResult = await executeChild<typeof piDurableAgentWorkflow>('piDurableAgentWorkflow', {
      workflowId: buildTaskWorkflowId(input.tenant_id, taskRunId),
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
      ...(input.case_timeout_ms ? { workflowExecutionTimeout: `${input.case_timeout_ms} milliseconds` } : {}),
      args: [{
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        task_run_id: taskRunId,
        workflow_id: buildTaskWorkflowId(input.tenant_id, taskRunId),
        parent_workflow_id: info.workflowId,
        agent_execution_plan_ref: prepared.agent_execution_plan_ref,
        execution_mode: 'mediated_tool_call',
        initial_user_input: prepared.initial_user_input,
        tenant_policy_snapshot_ref: prepared.tenant_policy_snapshot_ref,
        tenant_policy_hash: prepared.tenant_policy_hash,
        execution_context_type: 'evaluation',
        evaluation_run_id: input.evaluation_run_id,
        evaluation_case_id: input.case_id,
        evaluation_execution_plan_ref: input.evaluation_execution_plan_ref,
        evaluation_execution_plan_hash: input.evaluation_execution_plan_hash,
        task_status_owner: false,
        request_id: input.request_id,
        ...(input.trace_id ? { trace_id: input.trace_id } : {}),
      } satisfies PiDurableAgentWorkflowInput],
    });
    const result = await caseActivities.collectAndScoreEvaluationCaseActivity({
      tenant_id: input.tenant_id,
      evaluation_run_id: input.evaluation_run_id,
      case_id: input.case_id,
      task_run_id: taskRunId,
      agent_run_id: agentResult.agent_run_id,
      workflow_id: info.workflowId,
      workflow_run_id: info.runId,
      started_at_ms: startedAtMs,
    });
    return caseSummary(input.case_id, taskRunId, result);
  } catch (error) {
    if (isCancellation(error)) {
      await CancellationScope.nonCancellable(async () => {
        await caseActivities.recordEvaluationCaseSystemErrorActivity({
          tenant_id: input.tenant_id,
          evaluation_run_id: input.evaluation_run_id,
          case_id: input.case_id,
          task_run_id: taskRunId,
          workflow_id: info.workflowId,
          workflow_run_id: info.runId,
          started_at_ms: startedAtMs,
          error_code: 'EVALUATION_CASE_CANCELLED',
          error_message: 'Evaluation case workflow was cancelled',
          cancelled: true,
        });
      });
      throw error;
    }
    const result = await caseActivities.recordEvaluationCaseSystemErrorActivity({
      tenant_id: input.tenant_id,
      evaluation_run_id: input.evaluation_run_id,
      case_id: input.case_id,
      task_run_id: taskRunId,
      workflow_id: info.workflowId,
      workflow_run_id: info.runId,
      started_at_ms: startedAtMs,
      error_code: 'EVALUATION_CASE_SYSTEM_ERROR',
      error_message: workflowErrorMessage(error),
    });
    return caseSummary(input.case_id, taskRunId, result);
  }
}

function isCancellationRequested(run: EvaluationRun): boolean {
  return run.status === 'cancelling' || run.status === 'cancelled';
}

function assertRunStatus(run: EvaluationRun, expected: EvaluationRun['status'], operation: string): void {
  if (run.status !== expected) {
    throw new Error(`Evaluation run ${operation} returned unexpected status: ${run.status}`);
  }
}

function caseSummary(
  caseId: string,
  taskRunId: string,
  result: EvaluationCaseResult,
): EvaluationCaseSummary {
  return {
    case_id: caseId,
    status: result.status,
    ...(result.score !== undefined ? { score: result.score } : {}),
    task_run_id: taskRunId,
    ...(result.agent_run_id ? { agent_run_id: result.agent_run_id } : {}),
  };
}

function workflowErrorMessage(error: unknown): string {
  const cause = rootCause(error);
  return cause ?? (error instanceof Error ? error.message : 'Evaluation case failed');
}

function buildEvaluationCaseWorkflowId(tenantId: string, runId: string, caseId: string): string {
  return `evaluation-case-${sanitize(tenantId)}-${sanitize(runId)}-${sanitize(caseId)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}
