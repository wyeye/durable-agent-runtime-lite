import { executeChild, proxyActivities } from '@temporalio/workflow';
import type { GenericAgentWorkflowInput } from '@dar/temporal';
import type { AgentRunResult, PiDurableAgentWorkflowResult } from '@dar/contracts';
import type { piDurableAgentWorkflow } from './pi-durable-agent-workflow.js';

const { updateTaskRunStatusActivity } = proxyActivities<{
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
    ...(input.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: input.tenant_policy_snapshot_ref } : {}),
    ...(input.tenant_policy_hash ? { tenant_policy_hash: input.tenant_policy_hash } : {}),
    ...(input.tenant_admission_id ? { tenant_admission_id: input.tenant_admission_id } : {}),
  };

  await updateTaskRunStatusActivity({ ...context, status: 'running' });

  try {
    if (!input.agent_execution_plan_ref) {
      throw new Error('GenericAgentWorkflow requires agent_execution_plan_ref');
    }
    const result = await executeChild<typeof piDurableAgentWorkflow>('piDurableAgentWorkflow', {
      workflowId: `${context.workflow_id}-agent-generic`,
      args: [{
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        task_run_id: input.task_run_id,
        parent_workflow_id: context.workflow_id,
        agent_execution_plan_ref: input.agent_execution_plan_ref,
        execution_mode: 'mediated_tool_call',
        initial_user_input: typeof input.input === 'string' ? input.input : JSON.stringify(input.input ?? {}),
        ...(input.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: input.tenant_policy_snapshot_ref } : {}),
        ...(input.tenant_policy_hash ? { tenant_policy_hash: input.tenant_policy_hash } : {}),
        ...(input.tenant_admission_id ? { tenant_admission_id: input.tenant_admission_id } : {}),
        request_id: input.request_id,
        ...(input.trace_id ? { trace_id: input.trace_id } : {}),
      }],
    });
    await updateTaskRunStatusActivity({
      ...context,
      status: result.status === 'completed' ? 'completed' : result.status === 'waiting_user' || result.status === 'waiting_human' ? 'waiting_human' : 'failed',
      ...(result.error?.code ? { error_code: result.error.code } : {}),
      ...(result.error?.message ? { error_message: result.error.message } : {}),
    });
    return agentResultFromDurableResult(result);
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

function agentResultFromDurableResult(result: PiDurableAgentWorkflowResult): AgentRunResult {
  if (result.status === 'completed') {
    return {
      status: 'final',
      ...(result.final_answer ? { final_answer: result.final_answer } : {}),
      proposed_tool_calls: [],
      usage: result.usage,
    };
  }
  return {
    status: result.status === 'waiting_user' || result.status === 'waiting_human' ? 'need_user' : 'failed',
    proposed_tool_calls: [],
    usage: result.usage,
    error: result.error ?? { code: 'AGENT_RUN_FAILED', message: `Agent run ended with ${result.status}` },
  };
}

function workflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow failed';
}
