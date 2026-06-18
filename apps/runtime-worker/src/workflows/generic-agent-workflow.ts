import { proxyActivities } from '@temporalio/workflow';
import type { GenericAgentWorkflowInput } from '@dar/temporal';
import type { AgentRunResult, FlowExecutionPlanAgent } from '@dar/contracts';
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
    if (!input.agent_version || !input.prompt_ref || !input.model_policy || !input.allowed_tools) {
      throw new Error('GenericAgentWorkflow requires explicit agent execution metadata');
    }
    const promptRef = parsePromptRef(input.prompt_ref);
    const agent: FlowExecutionPlanAgent = {
      step_id: 'generic_agent',
      agent_id: input.agent_id,
      agent_version: input.agent_version,
      agent_sha256: '0'.repeat(64),
      prompt_id: promptRef.id,
      prompt_version: promptRef.version,
      prompt_sha256: '0'.repeat(64),
      model_policy: input.model_policy,
      allowed_tools: input.allowed_tools,
      budget: {
        max_steps: input.max_steps ?? 6,
        max_tokens: input.max_tokens ?? 12_000,
      },
    };
    const result = await runAgentActivity(
      context,
      agent,
      { input_ref: input.input_ref, input: input.input ?? {} },
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

function parsePromptRef(value: string): { id: string; version: number } {
  const match = /^(.+)@([1-9]\d*)$/u.exec(value);
  if (!match) {
    throw new Error(`Invalid prompt_ref for GenericAgentWorkflow: ${value}`);
  }
  return { id: match[1] ?? '', version: Number(match[2]) };
}

function workflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow failed';
}
