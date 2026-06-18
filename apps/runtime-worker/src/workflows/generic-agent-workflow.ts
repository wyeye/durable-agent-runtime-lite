import { proxyActivities } from '@temporalio/workflow';
import type { GenericAgentWorkflowInput } from '@dar/temporal';
import type { AgentRunResult } from '@dar/contracts';
import type { FlowExecutionActivities } from '../interpreter/flow-interpreter.js';

const { runAgentActivity, updateTaskRunStatusActivity } = proxyActivities<{
  runAgentActivity: FlowExecutionActivities['runAgent'];
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
  startToCloseTimeout: '1 minute',
});

export async function genericAgentWorkflow(input: GenericAgentWorkflowInput): Promise<AgentRunResult> {
  const context = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    task_run_id: input.task_run_id,
    workflow_id: input.workflow_id ?? `task-${input.tenant_id}-${input.task_run_id}`,
    request_id: input.request_id,
  };

  await updateTaskRunStatusActivity({ ...context, status: 'running' });

  try {
    const result = await runAgentActivity(
      context,
      input.agent_id,
      { input_ref: input.input_ref, input: input.input ?? {} },
      ['knowledge.search'],
    );
    await updateTaskRunStatusActivity({
      ...context,
      status: result.status === 'need_user' ? 'waiting_human' : result.status === 'failed' ? 'failed' : 'completed',
      ...(result.error?.code ? { error_code: result.error.code } : {}),
      ...(result.error?.message ? { error_message: result.error.message } : {}),
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

function workflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow failed';
}
