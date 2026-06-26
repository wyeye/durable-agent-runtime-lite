import { condition, defineSignal, executeChild, patched, proxyActivities, setHandler } from '@temporalio/workflow';
import type { ConfigDrivenWorkflowInput, HumanTaskDecisionSignalInput } from '@dar/temporal';
import { WORKFLOW_SIGNALS } from '@dar/temporal';
import type { AgentRunResult, EffectiveTenantPolicy, FlowExecutionPlan, FlowExecutionPlanAgent, FlowExecutionPlanTool, HumanTask, PiDurableAgentWorkflowResult } from '@dar/contracts';
import { executeFlowSpec, type FlowExecutionActivities, type FlowExecutionResult } from '../interpreter/flow-interpreter.js';
import type { piDurableAgentWorkflow } from './pi-durable-agent-workflow.js';

export interface ConfigDrivenWorkflowArgs extends ConfigDrivenWorkflowInput {
  input?: unknown;
}

const humanTaskDecisionSignal = defineSignal<[HumanTaskDecisionSignalInput]>(WORKFLOW_SIGNALS.humanTaskDecision);

const {
  normalizeInput,
  invokeToolActivity,
  previewToolActivity,
  commitToolActivity,
  createHumanTaskActivity,
  loadExecutionPlanByRefActivity,
  loadAgentExecutionPlanByRefActivity,
  loadTenantPolicySnapshotActivity,
  deriveTenantPolicySnapshotActivity,
  finalizeConversationTurnActivity,
  updateTaskRunStatusActivity,
} = proxyActivities<{
  normalizeInput: FlowExecutionActivities['normalizeInput'];
  invokeToolActivity: FlowExecutionActivities['invokeTool'];
  previewToolActivity: FlowExecutionActivities['previewTool'];
  commitToolActivity: FlowExecutionActivities['commitTool'];
  createHumanTaskActivity: FlowExecutionActivities['createHumanTask'];
  loadExecutionPlanByRefActivity(executionPlanRef: string): Promise<FlowExecutionPlan>;
  loadAgentExecutionPlanByRefActivity(executionPlanRef: string, tenantId?: string): Promise<{ execution_plan_ref: string; execution_plan_hash: string }>;
  loadTenantPolicySnapshotActivity(input: {
    tenant_id: string;
    user_id: string;
    task_run_id: string;
    workflow_id: string;
    request_id: string;
    execution_plan_ref: string;
    execution_plan_hash: string;
    execution_plan_type: 'flow' | 'agent';
    tenant_policy_snapshot_ref?: string;
    tenant_policy_hash?: string;
  }): Promise<EffectiveTenantPolicy>;
  deriveTenantPolicySnapshotActivity(input: {
    tenant_id: string;
    user_id: string;
    task_run_id: string;
    workflow_id: string;
    request_id: string;
    parent_snapshot_ref: string;
    target_execution_plan_ref: string;
    target_execution_plan_hash: string;
    target_execution_plan_type: 'flow' | 'agent';
    derivation_type: 'flow_agent_child' | 'workflow_handoff' | 'nested_handoff';
    tenant_policy_snapshot_ref?: string;
    tenant_policy_hash?: string;
  }): Promise<EffectiveTenantPolicy>;
  finalizeConversationTurnActivity(input: {
    tenant_id: string;
    assistant_message_id: string;
    task_run_id: string;
    agent_run_id?: string;
    final_text?: string;
    error_code?: string;
    safe_error_message_key?: string;
  }): Promise<void>;
  updateTaskRunStatusActivity(input: {
    tenant_id: string;
    user_id: string;
    task_run_id: string;
    workflow_id: string;
    request_id: string;
    status: 'running' | 'waiting_human' | 'waiting_user' | 'completed' | 'failed';
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
    ...(input.conversation_runtime ? { conversation_runtime: input.conversation_runtime } : {}),
    ...(input.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: input.tenant_policy_snapshot_ref } : {}),
    ...(input.tenant_policy_hash ? { tenant_policy_hash: input.tenant_policy_hash } : {}),
    ...(input.tenant_admission_id ? { tenant_admission_id: input.tenant_admission_id } : {}),
  };

  await updateOwnedTaskRunStatus(input, { ...context, status: 'running' });

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
    const executionContext = {
      ...context,
      execution_plan_ref: executionPlan.execution_plan_ref,
      execution_plan_hash: executionPlan.execution_plan_hash,
    };
    const policy = context.tenant_policy_snapshot_ref && context.tenant_policy_hash && patched('config-driven-effective-tenant-policy-v1')
      ? await loadTenantPolicySnapshotActivity({
          ...executionContext,
          execution_plan_ref: executionPlan.execution_plan_ref,
          execution_plan_hash: executionPlan.execution_plan_hash,
          execution_plan_type: 'flow',
        })
      : undefined;

    const result = await executeFlowSpec(executionPlan, executionContext, input.input ?? {}, {
      normalizeInput,
      invokeTool: async (toolContext, tool, args) => {
        if (policy) {
          assertEffectivePolicyAllowsTool(policy, tool, 'invoke');
        }
        return invokeToolActivity(toolContext, tool, args);
      },
      previewTool: async (toolContext, tool, args) => {
        if (policy) {
          assertEffectivePolicyAllowsTool(policy, tool, 'preview');
        }
        return previewToolActivity(toolContext, tool, args);
      },
      commitTool: async (toolContext, toolCallId, tool, args) => {
        if (policy) {
          assertEffectivePolicyAllowsTool(policy, tool, 'commit');
        }
        return commitToolActivity(toolContext, toolCallId, tool, args);
      },
      runAgent: async (_context, plannedAgent, agentInput) => runAgentChildWorkflow(executionContext, plannedAgent, agentInput, policy),
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

    await updateOwnedTaskRunStatus(input, {
      ...context,
      status: result.status,
      ...(result.error_code ? { error_code: result.error_code } : {}),
      ...(result.error_message ? { error_message: result.error_message } : {}),
    });

    if (input.conversation_runtime && result.status === 'completed') {
      const finalText = extractConversationFinalText(result);
      if (!finalText) {
        throw new Error('CONVERSATION_FINAL_TEXT_MISSING');
      }
      await finalizeConversationTurnActivity({
        tenant_id: input.tenant_id,
        assistant_message_id: input.conversation_runtime.assistant_message_id,
        task_run_id: input.task_run_id,
        final_text: finalText,
      });
    }

    if (input.conversation_runtime && result.status === 'failed') {
      await finalizeConversationTurnActivity({
        tenant_id: input.tenant_id,
        assistant_message_id: input.conversation_runtime.assistant_message_id,
        task_run_id: input.task_run_id,
        error_code: result.error_code ?? 'WORKFLOW_FAILED',
        safe_error_message_key: conversationErrorMessageKey(result.error_code),
      });
    }
    return result;
  } catch (error) {
    if (input.conversation_runtime) {
      await finalizeConversationTurnActivity({
        tenant_id: input.tenant_id,
        assistant_message_id: input.conversation_runtime.assistant_message_id,
        task_run_id: input.task_run_id,
        error_code: 'WORKFLOW_FAILED',
        safe_error_message_key: conversationErrorMessageKey('WORKFLOW_FAILED'),
      });
    }
    await updateOwnedTaskRunStatus(input, {
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
    kind: 'approval',
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

async function runAgentChildWorkflow(
  context: {
    tenant_id: string;
    user_id: string;
    task_run_id: string;
    workflow_id: string;
    request_id: string;
    conversation_runtime?: ConfigDrivenWorkflowInput['conversation_runtime'];
    execution_plan_ref?: string;
    execution_plan_hash?: string;
    tenant_policy_snapshot_ref?: string;
    tenant_policy_hash?: string;
    tenant_admission_id?: string;
  },
  plannedAgent: FlowExecutionPlanAgent,
  input: Record<string, unknown>,
  policy?: EffectiveTenantPolicy,
): Promise<AgentRunResult> {
  if (!plannedAgent.agent_execution_plan_ref) {
    throw new Error(`FlowExecutionPlan agent missing agent_execution_plan_ref: ${plannedAgent.agent_id}@${plannedAgent.agent_version}`);
  }
  let childPolicy = policy;
  if (policy && patched('flow-agent-child-tenant-policy-snapshot-v1')) {
    const childPlan = await loadAgentExecutionPlanByRefActivity(plannedAgent.agent_execution_plan_ref, context.tenant_id);
    childPolicy = await deriveTenantPolicySnapshotActivity({
      ...context,
      parent_snapshot_ref: policy.snapshot_ref,
      target_execution_plan_ref: childPlan.execution_plan_ref,
      target_execution_plan_hash: childPlan.execution_plan_hash,
      target_execution_plan_type: 'agent',
      derivation_type: 'flow_agent_child',
      tenant_policy_snapshot_ref: policy.snapshot_ref,
      tenant_policy_hash: policy.snapshot_hash,
    });
  }
  const result = await executeChild<typeof piDurableAgentWorkflow>('piDurableAgentWorkflow', {
    workflowId: `${context.workflow_id}-agent-${sanitizeWorkflowId(plannedAgent.step_id)}`,
    args: [{
      tenant_id: context.tenant_id,
      user_id: context.user_id,
      task_run_id: context.task_run_id,
      parent_workflow_id: context.workflow_id,
      agent_execution_plan_ref: plannedAgent.agent_execution_plan_ref,
      task_status_owner: false,
      execution_mode: 'mediated_tool_call',
      initial_user_input:
        typeof input.text === 'string'
          ? input.text
          : JSON.stringify(input),
      ...(context.conversation_runtime ? { conversation_runtime: context.conversation_runtime } : {}),
      ...(childPolicy ? { tenant_policy_snapshot_ref: childPolicy.snapshot_ref } : context.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: context.tenant_policy_snapshot_ref } : {}),
      ...(childPolicy ? { tenant_policy_hash: childPolicy.snapshot_hash } : context.tenant_policy_hash ? { tenant_policy_hash: context.tenant_policy_hash } : {}),
      ...(context.tenant_admission_id ? { tenant_admission_id: context.tenant_admission_id } : {}),
      request_id: context.request_id,
    }],
  });
  return agentResultFromDurableResult(result);
}

function assertEffectivePolicyAllowsTool(policy: EffectiveTenantPolicy, tool: FlowExecutionPlanTool, operation: 'invoke' | 'preview' | 'commit'): void {
  const denied = policy.denied_tools.some((rule) => rule.tool_name === tool.tool_name && ruleMatchesVersion(rule, tool.tool_version));
  if (denied) {
    throw new Error('TOOL_DENIED_BY_TENANT_POLICY');
  }
  const allowed = policy.allowed_tools.some((rule) =>
    rule.tool_name === tool.tool_name
    && ruleMatchesVersion(rule, tool.tool_version)
    && rule.allowed_operations.includes(operation)
    && (!rule.max_risk_level || riskRank(tool.risk_level) <= riskRank(rule.max_risk_level)));
  if (!allowed) {
    throw new Error('TOOL_DENIED_BY_TENANT_POLICY');
  }
}

function ruleMatchesVersion(rule: { versions?: string[] | undefined }, version: string): boolean {
  return !rule.versions?.length || rule.versions.includes(version);
}

function riskRank(riskLevel: string): number {
  return Number(riskLevel.slice(1));
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

async function updateOwnedTaskRunStatus(
  input: ConfigDrivenWorkflowArgs,
  status: Parameters<typeof updateTaskRunStatusActivity>[0],
): Promise<void> {
  if (input.task_status_owner === false) {
    return;
  }
  await updateTaskRunStatusActivity(status);
}

function sanitizeWorkflowId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function workflowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Workflow failed';
}

function extractConversationFinalText(result: FlowExecutionResult): string | undefined {
  let finalText: string | undefined;
  for (const [key, value] of Object.entries(result.steps)) {
    if (key === 'steps' || !isRecord(value)) {
      continue;
    }
    if (value.status === 'final' && typeof value.final_answer === 'string' && value.final_answer.trim().length > 0) {
      finalText = value.final_answer;
    }
  }
  return finalText;
}

function conversationErrorMessageKey(errorCode?: string): string {
  switch (errorCode) {
    case 'AGENT_CANCELLED':
      return 'errors.agentCancelled';
    case 'AGENT_BUDGET_EXCEEDED':
    case 'AGENT_SEGMENT_BUDGET_EXCEEDED':
    case 'AGENT_MODEL_TURN_BUDGET_EXCEEDED':
    case 'AGENT_TOKEN_BUDGET_EXCEEDED':
    case 'AGENT_DURATION_BUDGET_EXCEEDED':
    case 'AGENT_CONTEXT_BUDGET_EXCEEDED':
      return 'errors.agentBudgetExceeded';
    case 'HUMAN_TASK_REJECTED':
      return 'errors.humanTaskRejected';
    case 'PI_SEGMENT_FAILED':
    case 'AGENT_RUN_FAILED':
      return 'errors.agentFailed';
    case 'WORKFLOW_START_FAILED':
      return 'errors.workflowStartFailed';
    default:
      return 'errors.workflowFailed';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
