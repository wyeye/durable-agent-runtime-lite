import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { ConfigDrivenWorkflowInput, HumanTaskDecisionSignalInput } from '@dar/temporal';
import { WORKFLOW_SIGNALS } from '@dar/temporal';
import type { FlowExecutionPlan, HumanTask } from '@dar/contracts';
import { executeFlowSpec, type FlowExecutionActivities, type FlowExecutionResult } from '../interpreter/flow-interpreter.js';

export interface ConfigDrivenWorkflowArgs extends ConfigDrivenWorkflowInput {
  input?: unknown;
}

const humanTaskDecisionSignal = defineSignal<[HumanTaskDecisionSignalInput]>(WORKFLOW_SIGNALS.humanTaskDecision);

const {
  normalizeInput,
  invokeToolActivity,
  previewToolActivity,
  commitToolActivity,
  runAgentActivity,
  createHumanTaskActivity,
  loadExecutionPlanByRefActivity,
  updateTaskRunStatusActivity,
} = proxyActivities<{
  normalizeInput: FlowExecutionActivities['normalizeInput'];
  invokeToolActivity: FlowExecutionActivities['invokeTool'];
  previewToolActivity: FlowExecutionActivities['previewTool'];
  commitToolActivity: FlowExecutionActivities['commitTool'];
  runAgentActivity: FlowExecutionActivities['runAgent'];
  createHumanTaskActivity: FlowExecutionActivities['createHumanTask'];
  loadExecutionPlanByRefActivity(executionPlanRef: string): Promise<FlowExecutionPlan>;
  updateTaskRunStatusActivity(input: {
    tenant_id: string;
    user_id: string;
    task_run_id: string;
    workflow_id: string;
    request_id: string;
    status: 'running' | 'waiting_human' | 'completed' | 'failed';
    error_code?: string;
    error_message?: string;
  }): Promise<void>;
}>({
  startToCloseTimeout: '6 minutes',
});

export async function configDrivenWorkflow(input: ConfigDrivenWorkflowArgs): Promise<FlowExecutionResult> {
  const decisions = new Map<string, HumanTaskDecisionSignalInput>();
  setHandler(humanTaskDecisionSignal, (decision) => {
    if (decision.task_run_id !== input.task_run_id) {
      return;
    }
    if (!decisions.has(decision.human_task_id)) {
      decisions.set(decision.human_task_id, decision);
    }
  });

  const context = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    task_run_id: input.task_run_id,
    workflow_id: input.workflow_id ?? `task-${input.tenant_id}-${input.task_run_id}`,
    request_id: input.request_id,
  };

  await updateTaskRunStatusActivity({ ...context, status: 'running' });

  try {
    if (!input.execution_plan_ref) {
      throw new Error('ConfigDrivenWorkflow requires execution_plan_ref');
    }
    const executionPlan = await loadExecutionPlanByRefActivity(input.execution_plan_ref);
    if (executionPlan.flow_id !== input.flow_id || executionPlan.flow_version !== input.flow_version) {
      throw new Error(`FlowExecutionPlan target mismatch: ${input.execution_plan_ref}`);
    }
    if (input.flow_sha256 && executionPlan.flow_sha256 !== input.flow_sha256) {
      throw new Error(`FlowExecutionPlan flow hash mismatch: ${input.execution_plan_ref}`);
    }

    const result = await executeFlowSpec(executionPlan, context, input.input ?? {}, {
      normalizeInput,
      invokeTool: invokeToolActivity,
      previewTool: previewToolActivity,
      commitTool: commitToolActivity,
      runAgent: runAgentActivity,
      createHumanTask: createHumanTaskActivity,
      waitForHumanTaskDecision: async (_context, humanTaskId) => {
        await condition(() => decisions.has(humanTaskId));
        const decision = decisions.get(humanTaskId);
        if (!decision) {
          throw new Error(`HumanTask decision signal missing after wait: ${humanTaskId}`);
        }
        return signalDecisionToHumanTask(decision);
      },
    });

    await updateTaskRunStatusActivity({
      ...context,
      status: result.status,
      ...(result.error_code ? { error_code: result.error_code } : {}),
      ...(result.error_message ? { error_message: result.error_message } : {}),
    });
    return result;
  } catch (error) {
    await updateTaskRunStatusActivity({
      ...context,
      status: 'failed',
      error_code: 'WORKFLOW_FAILED',
      error_message: workflowErrorMessage(error),
    });
    throw error;
  }
}

function signalDecisionToHumanTask(decision: HumanTaskDecisionSignalInput): HumanTask {
  return {
    human_task_id: decision.human_task_id,
    tenant_id: decision.tenant_id,
    task_run_id: decision.task_run_id,
    ...(decision.workflow_id ? { workflow_id: decision.workflow_id } : {}),
    status: decision.status,
    candidate_groups: [],
    payload: {},
    ...(decision.decision ? { decision: decision.decision } : {}),
    ...(decision.decided_by ? { decided_by: decision.decided_by } : {}),
    ...(decision.decided_at ? { decided_at: decision.decided_at } : {}),
    ...(decision.decision_reason ? { decision_reason: decision.decision_reason } : {}),
    ...(decision.decided_at ? { completed_at: decision.decided_at } : {}),
  };
}

function workflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow failed';
}
