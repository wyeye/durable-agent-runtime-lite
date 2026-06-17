import { proxyActivities } from '@temporalio/workflow';
import type { GenericAgentWorkflowInput } from '@dar/temporal';
import type { AgentRunResult } from '@dar/contracts';
import type { FlowExecutionActivities } from '../interpreter/flow-interpreter.js';

const { runAgentActivity } = proxyActivities<{
  runAgentActivity: FlowExecutionActivities['runAgent'];
}>({
  startToCloseTimeout: '1 minute',
});

export async function genericAgentWorkflow(input: GenericAgentWorkflowInput): Promise<AgentRunResult> {
  return runAgentActivity(
    {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      task_run_id: input.task_run_id,
      workflow_id: input.workflow_id ?? `task-${input.tenant_id}-${input.task_run_id}`,
      request_id: input.request_id,
    },
    input.agent_id,
    { input_ref: input.input_ref, input: input.input ?? {} },
    ['knowledge.search'],
  );
}
