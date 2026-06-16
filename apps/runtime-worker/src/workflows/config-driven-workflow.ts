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
} = proxyActivities<{
  normalizeInput: FlowExecutionActivities['normalizeInput'];
  invokeToolActivity: FlowExecutionActivities['invokeTool'];
  runAgentActivity: FlowExecutionActivities['runAgent'];
  createHumanTaskActivity: FlowExecutionActivities['createHumanTask'];
  loadFlowSpecByRefActivity(flowSnapshotRef: string): Promise<FlowSpec>;
}>({
  startToCloseTimeout: '1 minute',
});

export async function configDrivenWorkflow(input: ConfigDrivenWorkflowArgs): Promise<FlowExecutionResult> {
  const flowSpec = input.flow_spec_snapshot ?? (await loadFlowSpecByRefActivity(input.flow_snapshot_ref));

  return executeFlowSpec(
    flowSpec,
    {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      task_run_id: input.task_run_id,
      workflow_id: input.workflow_id ?? `task-${input.tenant_id}-${input.task_run_id}`,
      request_id: input.request_id,
    },
    input.input ?? {},
    {
      normalizeInput,
      invokeTool: invokeToolActivity,
      runAgent: runAgentActivity,
      createHumanTask: createHumanTaskActivity,
    },
  );
}
