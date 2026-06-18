import { proxyActivities } from '@temporalio/workflow';
import type { ConfigDrivenWorkflowInput } from '@dar/temporal';
import type { FlowSpec } from '@dar/contracts';
import { executeFlowSpec, type FlowExecutionActivities, type FlowExecutionResult } from '../interpreter/flow-interpreter.js';

export interface ConfigDrivenWorkflowArgs extends ConfigDrivenWorkflowInput {
  flow_spec_snapshot?: FlowSpec;
  input?: unknown;
}

const {
  normalizeInput,
  invokeToolActivity,
  runAgentActivity,
  createHumanTaskActivity,
  loadFlowSpecByRefActivity,
  updateTaskRunStatusActivity,
} = proxyActivities<{
  normalizeInput: FlowExecutionActivities['normalizeInput'];
  invokeToolActivity: FlowExecutionActivities['invokeTool'];
  runAgentActivity: FlowExecutionActivities['runAgent'];
  createHumanTaskActivity: FlowExecutionActivities['createHumanTask'];
  loadFlowSpecByRefActivity(flowSnapshotRef: string): Promise<FlowSpec>;
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

export async function configDrivenWorkflow(input: ConfigDrivenWorkflowArgs): Promise<FlowExecutionResult> {
  const context = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    task_run_id: input.task_run_id,
    workflow_id: input.workflow_id ?? `task-${input.tenant_id}-${input.task_run_id}`,
    request_id: input.request_id,
  };

  await updateTaskRunStatusActivity({ ...context, status: 'running' });

  try {
    const flowSpec = input.flow_spec_snapshot ?? (await loadFlowSpecByRefActivity(input.flow_snapshot_ref));
    const result = await executeFlowSpec(flowSpec, context, input.input ?? {}, {
      normalizeInput,
      invokeTool: invokeToolActivity,
      runAgent: runAgentActivity,
      createHumanTask: createHumanTaskActivity,
    });

    await updateTaskRunStatusActivity({ ...context, status: result.status });
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
