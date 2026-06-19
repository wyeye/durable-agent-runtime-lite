import {
  ActivityCancellationType,
  type ActivityOptions,
  condition,
  continueAsNew,
  defineSignal,
  executeChild,
  patched,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  HumanTaskDecisionSignalInput,
  PiDurableAgentWorkflowInput,
  UserInputResponseSignalInput,
} from '@dar/temporal';
import { WORKFLOW_SIGNALS } from '@dar/temporal';
import type {
  AgentAuthoritativeToolResult,
  AgentBudget,
  AgentBudgetLedger,
  AgentExecutionPlan,
  AgentRunRecord,
  AgentToolExecutionIdentity,
  AgentToolResultReference,
  EffectiveTenantPolicy,
  FlowExecutionPlan,
  FlowExecutionPlanTool,
  HumanTask,
  PiContextSnapshotRef,
  PiDurableAgentWorkflowResult,
  PiSegmentResult,
  ProposedToolCall,
} from '@dar/contracts';
import type {
  ActivityContext,
  AppendUserInputActivityInput,
  CreateAgentRunActivityInput,
  CreateHumanTaskActivityInput,
  PiRuntimeConfigActivityResult,
  PersistToolResultsActivityInput,
  UpdateAgentRunActivityInput,
  UpdateAgentStepActivityInput,
} from '../activities/index.js';
import type { FlowExecutionActivities } from '../interpreter/flow-interpreter.js';
import type { configDrivenWorkflow } from './config-driven-workflow.js';

const humanTaskDecisionSignal = defineSignal<[HumanTaskDecisionSignalInput]>(WORKFLOW_SIGNALS.humanTaskDecision);
const userInputResponseSignal = defineSignal<[UserInputResponseSignalInput]>(WORKFLOW_SIGNALS.userInputResponse);

type PiActivities = {
  createAgentRunActivity(input: CreateAgentRunActivityInput): Promise<AgentRunRecord>;
  loadAgentExecutionPlanByRefActivity(executionPlanRef: string, tenantId?: string): Promise<AgentExecutionPlan>;
  loadExecutionPlanByRefActivity(executionPlanRef: string, tenantId?: string): Promise<FlowExecutionPlan>;
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
  loadPiRuntimeConfigActivity(): Promise<PiRuntimeConfigActivityResult>;
  runPiSegmentActivity(input: {
    agent_run_id: string;
    execution_plan_ref: string;
    context_snapshot_ref?: PiContextSnapshotRef;
    initial_user_input?: string;
    resume_reason: string;
    segment_index: number;
    budget_remaining: AgentBudget;
    request_context: ActivityContext;
  }): Promise<PiSegmentResult>;
  updateAgentRunActivity(input: UpdateAgentRunActivityInput): Promise<AgentRunRecord>;
  updateTaskRunStatusActivity(input: ActivityContext & { status: 'running' | 'waiting_human' | 'completed' | 'failed'; error_code?: string; error_message?: string }): Promise<void>;
  updateAgentStepActivity(input: UpdateAgentStepActivityInput): Promise<unknown>;
  invokeToolActivity(
    context: ActivityContext,
    tool: FlowExecutionPlanTool,
    args: Record<string, unknown>,
    identity?: AgentToolExecutionIdentity,
  ): ReturnType<FlowExecutionActivities['invokeTool']>;
  previewToolActivity(
    context: ActivityContext,
    tool: FlowExecutionPlanTool,
    args: Record<string, unknown>,
    identity?: AgentToolExecutionIdentity,
  ): ReturnType<FlowExecutionActivities['previewTool']>;
  commitToolActivity(
    context: ActivityContext,
    toolCallId: string,
    tool: FlowExecutionPlanTool,
    args: Record<string, unknown>,
    identity?: AgentToolExecutionIdentity,
  ): ReturnType<FlowExecutionActivities['commitTool']>;
  createHumanTaskActivity(context: ActivityContext, input?: CreateHumanTaskActivityInput): Promise<HumanTask>;
  persistToolResultsToPiContextActivity(input: PersistToolResultsActivityInput): Promise<PiContextSnapshotRef>;
  appendUserInputToPiContextActivity(input: AppendUserInputActivityInput): Promise<PiContextSnapshotRef>;
};

export const PI_ACTIVITY_OPTIONS = {
  read: {
    startToCloseTimeout: '30 seconds',
    scheduleToCloseTimeout: '2 minutes',
    retry: {
      maximumAttempts: 3,
      initialInterval: '1 second',
      maximumInterval: '10 seconds',
      nonRetryableErrorTypes: [
        'VALIDATION_FAILED',
        'AUTH_FAILED',
        'POLICY_DENIED',
        'NOT_FOUND',
      ],
    },
  },
  piSegment: {
    startToCloseTimeout: '2 minutes',
    scheduleToCloseTimeout: '6 minutes',
    heartbeatTimeout: '15 seconds',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      maximumAttempts: 3,
      initialInterval: '2 seconds',
      maximumInterval: '30 seconds',
      nonRetryableErrorTypes: [
        'VALIDATION_FAILED',
        'AUTH_FAILED',
        'POLICY_DENIED',
        'PI_SEGMENT_NON_RETRYABLE',
      ],
    },
  },
  dbWrite: {
    startToCloseTimeout: '30 seconds',
    scheduleToCloseTimeout: '2 minutes',
    retry: {
      maximumAttempts: 4,
      initialInterval: '1 second',
      maximumInterval: '10 seconds',
      nonRetryableErrorTypes: [
        'VALIDATION_FAILED',
        'AUTH_FAILED',
        'POLICY_DENIED',
        'NOT_FOUND',
      ],
    },
  },
  toolInvoke: {
    startToCloseTimeout: '45 seconds',
    scheduleToCloseTimeout: '3 minutes',
    heartbeatTimeout: '15 seconds',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      maximumAttempts: 3,
      initialInterval: '1 second',
      maximumInterval: '15 seconds',
      nonRetryableErrorTypes: [
        'VALIDATION_FAILED',
        'AUTH_FAILED',
        'POLICY_DENIED',
        'TOOL_ARGUMENT_VALIDATION_FAILED',
        'TOOL_POLICY_DENIED',
        'TOOL_HASH_MISMATCH',
        'TOOL_RISK_MISMATCH',
      ],
    },
  },
  toolCommit: {
    startToCloseTimeout: '45 seconds',
    scheduleToCloseTimeout: '2 minutes',
    heartbeatTimeout: '15 seconds',
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      maximumAttempts: 2,
      initialInterval: '2 seconds',
      maximumInterval: '10 seconds',
      nonRetryableErrorTypes: [
        'VALIDATION_FAILED',
        'AUTH_FAILED',
        'POLICY_DENIED',
        'TOOL_ARGUMENT_VALIDATION_FAILED',
        'TOOL_POLICY_DENIED',
        'TOOL_HASH_MISMATCH',
        'TOOL_RISK_MISMATCH',
        'HUMAN_CONFIRMATION_REQUIRED',
        'IDEMPOTENCY_CONFLICT',
      ],
    },
  },
} satisfies Record<string, ActivityOptions>;

const readActivities = proxyActivities<Pick<PiActivities,
  'loadAgentExecutionPlanByRefActivity'
  | 'loadExecutionPlanByRefActivity'
  | 'loadTenantPolicySnapshotActivity'
  | 'deriveTenantPolicySnapshotActivity'
  | 'loadPiRuntimeConfigActivity'
>>(PI_ACTIVITY_OPTIONS.read);

const dbActivities = proxyActivities<Pick<PiActivities,
  'createAgentRunActivity'
  | 'updateAgentRunActivity'
  | 'updateTaskRunStatusActivity'
  | 'updateAgentStepActivity'
  | 'createHumanTaskActivity'
  | 'persistToolResultsToPiContextActivity'
  | 'appendUserInputToPiContextActivity'
>>(PI_ACTIVITY_OPTIONS.dbWrite);

const piActivities = proxyActivities<Pick<PiActivities, 'runPiSegmentActivity'>>(PI_ACTIVITY_OPTIONS.piSegment);

const toolInvokeActivities = proxyActivities<Pick<PiActivities,
  'invokeToolActivity'
  | 'previewToolActivity'
>>(PI_ACTIVITY_OPTIONS.toolInvoke);

const toolCommitActivities = proxyActivities<Pick<PiActivities, 'commitToolActivity'>>(PI_ACTIVITY_OPTIONS.toolCommit);

const {
  loadAgentExecutionPlanByRefActivity,
  loadExecutionPlanByRefActivity,
  loadTenantPolicySnapshotActivity,
  deriveTenantPolicySnapshotActivity,
  loadPiRuntimeConfigActivity,
} = readActivities;

const {
  createAgentRunActivity,
  updateAgentRunActivity,
  updateTaskRunStatusActivity,
  updateAgentStepActivity,
  createHumanTaskActivity,
  persistToolResultsToPiContextActivity,
  appendUserInputToPiContextActivity,
} = dbActivities;

const { runPiSegmentActivity } = piActivities;
const { invokeToolActivity, previewToolActivity } = toolInvokeActivities;
const { commitToolActivity } = toolCommitActivities;

export async function piDurableAgentWorkflow(
  input: PiDurableAgentWorkflowInput,
): Promise<PiDurableAgentWorkflowResult> {
  const humanDecisions = new Map<string, HumanTaskDecisionSignalInput>();
  const userInputs = new Map<string, UserInputResponseSignalInput>();
  setHandler(humanTaskDecisionSignal, (decision) => {
    if (decision.task_run_id === input.task_run_id && !humanDecisions.has(decision.human_task_id)) {
      humanDecisions.set(decision.human_task_id, decision);
    }
  });
  setHandler(userInputResponseSignal, (response) => {
    if (response.task_run_id === input.task_run_id && !userInputs.has(response.human_task_id)) {
      userInputs.set(response.human_task_id, response);
    }
  });

  const info = workflowInfo();
  const workflowRunId = info.runId;
  const currentWorkflowId = info.workflowId;
  const startedAtMs = input.started_at_ms ?? Date.now();
  const context: ActivityContext = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    task_run_id: input.task_run_id,
    workflow_id: input.workflow_id ?? currentWorkflowId,
    request_id: input.request_id,
    ...(input.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: input.tenant_policy_snapshot_ref } : {}),
    ...(input.tenant_policy_hash ? { tenant_policy_hash: input.tenant_policy_hash } : {}),
    ...(input.tenant_admission_id ? { tenant_admission_id: input.tenant_admission_id } : {}),
  };
  const executionPlan = await loadAgentExecutionPlanByRefActivity(input.agent_execution_plan_ref, input.tenant_id);
  const executionContext: ActivityContext = {
    ...context,
    execution_plan_ref: executionPlan.execution_plan_ref,
    execution_plan_hash: executionPlan.execution_plan_hash,
  };
  const policy = context.tenant_policy_snapshot_ref && context.tenant_policy_hash && patched('pi-effective-tenant-policy-v1')
    ? await loadTenantPolicySnapshotActivity({
        ...executionContext,
        execution_plan_ref: executionPlan.execution_plan_ref,
        execution_plan_hash: executionPlan.execution_plan_hash,
        execution_plan_type: 'agent',
      })
    : undefined;
  const activeBudget = policy?.budget ?? executionPlan.budget;
  const runtimeConfig = await loadPiRuntimeConfigActivity();
  const continueAsNewSegmentThreshold = input.continue_as_new_segment_threshold
    ?? runtimeConfig.max_segments_before_continue_as_new;
  const agentRun = await createAgentRunActivity({
    ...executionContext,
    ...(input.agent_run_id ? { agent_run_id: input.agent_run_id } : {}),
    workflow_run_id: workflowRunId,
    execution_plan_ref: executionPlan.execution_plan_ref,
    ...(input.parent_workflow_id ? { parent_workflow_id: input.parent_workflow_id } : {}),
    execution_mode: input.execution_mode ?? 'mediated_tool_call',
  });
  if (policy && !modelAllowedByPolicy(policy, executionPlan.model_policy)) {
    return await failAgentRun(
      agentRun.agent_run_id,
      'AGENT_MODEL_DENIED_BY_TENANT_POLICY',
      `Agent model is not allowed by tenant policy snapshot: ${executionPlan.model_policy}`,
      undefined,
      usageFromLedger(normalizeLedger(input.budget_ledger)),
      executionContext,
    );
  }

  let contextSnapshotRef = input.context_snapshot_ref;
  let segmentIndex = input.segment_index ?? 0;
  let ledger = normalizeLedger(input.budget_ledger);

  await updateAgentRunActivity({
    agent_run_id: agentRun.agent_run_id,
    workflow_run_id: workflowRunId,
    status: 'running',
    current_segment_index: segmentIndex,
    model_turn_count: ledger.model_turn_count,
    tool_call_count: ledger.tool_call_count,
    handoff_count: ledger.handoff_count,
    usage: usageFromLedger(ledger),
  });

  while (segmentIndex < activeBudget.max_segments) {
    ledger = { ...ledger, elapsed_duration_ms: elapsedMs(startedAtMs) };
    const exhaustedBeforeSegment = budgetExceededForLedger(activeBudget, ledger);
    if (exhaustedBeforeSegment) {
      return await budgetExceeded(agentRun.agent_run_id, exhaustedBeforeSegment.code, exhaustedBeforeSegment.message, contextSnapshotRef, ledger, executionContext);
    }
    const remainingBeforeSegment = remainingBudget(activeBudget, ledger);

    const segment = await runPiSegmentActivity({
      agent_run_id: agentRun.agent_run_id,
      execution_plan_ref: executionPlan.execution_plan_ref,
      ...(contextSnapshotRef ? { context_snapshot_ref: contextSnapshotRef } : {}),
      ...(!contextSnapshotRef && input.initial_user_input ? { initial_user_input: input.initial_user_input } : {}),
      resume_reason: segmentIndex === 0 ? 'initial_prompt' : 'durable_boundary_resolved',
      segment_index: segmentIndex,
      budget_remaining: remainingBeforeSegment,
      request_context: executionContext,
    });

    const beforeSnapshotRef = contextSnapshotRef;
    contextSnapshotRef = 'context_snapshot_ref' in segment ? segment.context_snapshot_ref : contextSnapshotRef;
    ledger = applySegmentLedger(ledger, segment, contextSnapshotRef);

    await updateAgentRunActivity({
      agent_run_id: agentRun.agent_run_id,
      status: statusForSegment(segment),
      current_segment_index: segmentIndex,
      model_turn_count: ledger.model_turn_count,
      tool_call_count: ledger.tool_call_count,
      handoff_count: ledger.handoff_count,
      usage: usageFromLedger(ledger),
    });
    await updateAgentStepActivity({
      stable_step_key: stableStepKey(agentRun.agent_run_id, segmentIndex),
      ...(beforeSnapshotRef ? { context_snapshot_before: beforeSnapshotRef } : {}),
      ...(contextSnapshotRef ? { context_snapshot_after: contextSnapshotRef, context_snapshot_ref: contextSnapshotRef } : {}),
      usage: segment.usage,
    });

    const postSegmentBudget = budgetExceededForLedger(activeBudget, ledger);
    if (postSegmentBudget && segment.status !== 'completed') {
        return await budgetExceeded(agentRun.agent_run_id, postSegmentBudget.code, postSegmentBudget.message, contextSnapshotRef, ledger, executionContext);
    }

    if (segment.status === 'completed') {
      await updateAgentRunActivity({
        agent_run_id: agentRun.agent_run_id,
        status: 'completed',
        completed: true,
        usage: usageFromLedger(ledger),
      });
      await updateTaskRunStatusActivity({ ...executionContext, status: 'completed' });
      await updateAgentStepActivity({
        stable_step_key: stableStepKey(agentRun.agent_run_id, segmentIndex),
        segment_status: 'completed',
        ...(segment.final_answer_ref ? { output_ref: segment.final_answer_ref } : {}),
      });
      return {
        status: 'completed',
        agent_run_id: agentRun.agent_run_id,
        ...(segment.final_answer ? { final_answer: segment.final_answer } : {}),
        ...(contextSnapshotRef ? { context_snapshot_ref: contextSnapshotRef } : {}),
        usage: usageFromLedger(ledger),
      };
    }

    if (segment.status === 'tool_requested') {
      await updateAgentRunActivity({ agent_run_id: agentRun.agent_run_id, status: 'waiting_tool' });
      const toolOutcome = await executeProposedTools({
        context: executionContext,
        executionPlan,
        agentRunId: agentRun.agent_run_id,
        segmentIndex,
        proposals: segment.proposed_tool_calls,
        currentToolCallCount: ledger.tool_call_count,
        decisions: humanDecisions,
        ...(policy ? { policy } : {}),
      });
      ledger = {
        ...ledger,
        tool_call_count: ledger.tool_call_count + toolOutcome.chargedToolCallCount,
      };
      const afterToolSnapshotRef = await persistToolResultsToPiContextActivity({
        agent_run_id: agentRun.agent_run_id,
        previous_context_snapshot_ref: segment.context_snapshot_ref,
        tool_results: toolOutcome.results,
        max_context_bytes: activeBudget.max_context_bytes,
        request_context: executionContext,
      });
      contextSnapshotRef = afterToolSnapshotRef;
      ledger = { ...ledger, context_bytes: afterToolSnapshotRef.byte_size };
      const refs = toolOutcome.results.map(toolResultRef);
      await updateAgentStepActivity({
        stable_step_key: stableStepKey(agentRun.agent_run_id, segmentIndex),
        segment_status: 'tool_resolved',
        authoritative_tool_result_refs: refs,
        tool_result_refs: refs,
        human_task_ids: toolOutcome.humanTaskIds,
        context_snapshot_after: afterToolSnapshotRef,
        context_snapshot_ref: afterToolSnapshotRef,
      });
      await updateAgentRunActivity({
        agent_run_id: agentRun.agent_run_id,
        status: 'running',
        tool_call_count: ledger.tool_call_count,
        usage: usageFromLedger(ledger),
      });
      segmentIndex += 1;
      await maybeContinueAsNew(input, executionContext, agentRun.agent_run_id, contextSnapshotRef, ledger, segmentIndex, continueAsNewSegmentThreshold, startedAtMs);
      continue;
    }

    if (segment.status === 'user_input_required') {
      const humanTask = await createHumanTaskActivity(executionContext, {
        kind: 'user_input',
        payload: {
          agent_run_id: agentRun.agent_run_id,
          segment_index: segmentIndex,
          question: segment.question,
        },
        requested_schema: segment.requested_schema,
        candidate_groups: [],
      });
      await updateAgentRunActivity({ agent_run_id: agentRun.agent_run_id, status: 'waiting_user' });
      await updateAgentStepActivity({
        stable_step_key: stableStepKey(agentRun.agent_run_id, segmentIndex),
        segment_status: 'waiting_user',
        human_task_ids: [humanTask.human_task_id],
      });
      await condition(() => userInputs.has(humanTask.human_task_id));
      const response = userInputs.get(humanTask.human_task_id);
      if (!response) {
        throw new Error(`User input signal missing after wait: ${humanTask.human_task_id}`);
      }
      const afterUserSnapshotRef = await appendUserInputToPiContextActivity({
        agent_run_id: agentRun.agent_run_id,
        previous_context_snapshot_ref: segment.context_snapshot_ref,
        human_task_id: humanTask.human_task_id,
        response: response.response,
        responded_by: response.responded_by,
        max_context_bytes: activeBudget.max_context_bytes,
        request_context: executionContext,
      });
      contextSnapshotRef = afterUserSnapshotRef;
      ledger = { ...ledger, context_bytes: afterUserSnapshotRef.byte_size };
      await updateAgentStepActivity({
        stable_step_key: stableStepKey(agentRun.agent_run_id, segmentIndex),
        segment_status: 'completed',
        human_task_ids: [humanTask.human_task_id],
        context_snapshot_after: afterUserSnapshotRef,
        context_snapshot_ref: afterUserSnapshotRef,
      });
      await updateAgentRunActivity({ agent_run_id: agentRun.agent_run_id, status: 'running' });
      segmentIndex += 1;
      await maybeContinueAsNew(input, executionContext, agentRun.agent_run_id, contextSnapshotRef, ledger, segmentIndex, continueAsNewSegmentThreshold, startedAtMs);
      continue;
    }

    if (segment.status === 'handoff_requested') {
      const beforeHandoffLedger = ledger;
      ledger = { ...ledger, handoff_count: ledger.handoff_count + 1 };
      if (beforeHandoffLedger.handoff_count >= activeBudget.max_handoffs) {
        return await budgetExceeded(agentRun.agent_run_id, 'AGENT_HANDOFF_BUDGET_EXCEEDED', 'Handoff budget exceeded', contextSnapshotRef, ledger, executionContext);
      }
      if (!executionPlan.allowed_handoffs.includes(segment.target_execution_plan_ref)) {
        return await failAgentRun(agentRun.agent_run_id, 'HANDOFF_DENIED', `Unauthorized handoff target: ${segment.target_execution_plan_ref}`, contextSnapshotRef, usageFromLedger(ledger), executionContext);
      }
      if (policy && !handoffAllowedByPolicy(policy, segment.target_execution_plan_ref)) {
        return await failAgentRun(
          agentRun.agent_run_id,
          'HANDOFF_DENIED_BY_TENANT_POLICY',
          `Workflow handoff is not allowed by tenant policy snapshot: ${segment.target_execution_plan_ref}`,
          contextSnapshotRef,
          usageFromLedger(ledger),
          executionContext,
        );
      }

      await updateAgentRunActivity({ agent_run_id: agentRun.agent_run_id, status: 'handing_off', handoff_count: ledger.handoff_count });
      const handoff = await executeWorkflowHandoff({
        context: executionContext,
        agentRunId: agentRun.agent_run_id,
        segmentIndex,
        handoffIndex: ledger.handoff_count,
        targetExecutionPlanRef: segment.target_execution_plan_ref,
        arguments: segment.arguments,
        chain: input.handoff_chain ?? [executionPlan.execution_plan_ref],
        ...(policy ? { policy } : {}),
      });
      await updateAgentStepActivity({
        stable_step_key: stableStepKey(agentRun.agent_run_id, segmentIndex),
        segment_status: handoff.status === 'completed' ? 'handoff_completed' : 'failed',
        handoff_refs: [handoff],
        ...(handoff.status === 'failed'
          ? { error_code: handoff.error_code ?? 'HANDOFF_FAILED', error_message: handoff.error_message ?? 'Workflow handoff failed' }
          : {}),
      });
      if (handoff.status !== 'completed') {
        return await failAgentRun(
          agentRun.agent_run_id,
          handoff.error_code ?? 'HANDOFF_FAILED',
          handoff.error_message ?? 'Workflow handoff failed',
          contextSnapshotRef,
          usageFromLedger(ledger),
          executionContext,
        );
      }
      const handoffResult = handoffToolResult(segment, handoff);
      const afterHandoffSnapshotRef = await persistToolResultsToPiContextActivity({
        agent_run_id: agentRun.agent_run_id,
        previous_context_snapshot_ref: segment.context_snapshot_ref,
        tool_results: [handoffResult],
        max_context_bytes: activeBudget.max_context_bytes,
        request_context: executionContext,
      });
      contextSnapshotRef = afterHandoffSnapshotRef;
      ledger = { ...ledger, context_bytes: afterHandoffSnapshotRef.byte_size };
      await updateAgentStepActivity({
        stable_step_key: stableStepKey(agentRun.agent_run_id, segmentIndex),
        segment_status: 'handoff_completed',
        context_snapshot_after: afterHandoffSnapshotRef,
        context_snapshot_ref: afterHandoffSnapshotRef,
      });
      await updateAgentRunActivity({ agent_run_id: agentRun.agent_run_id, status: 'running', handoff_count: ledger.handoff_count });
      segmentIndex += 1;
      await maybeContinueAsNew(
        input,
        executionContext,
        agentRun.agent_run_id,
        contextSnapshotRef,
        ledger,
        segmentIndex,
        continueAsNewSegmentThreshold,
        startedAtMs,
        [
          ...(input.handoff_chain ?? [executionPlan.execution_plan_ref]),
          segment.target_execution_plan_ref,
        ],
      );
      continue;
    }

    if (segment.status === 'stopped_by_budget') {
      return await budgetExceeded(agentRun.agent_run_id, segment.error_code, segment.error_message, contextSnapshotRef, ledger, executionContext);
    }

    if (segment.status === 'failed' || segment.status === 'cancelled') {
      return await failAgentRun(agentRun.agent_run_id, segment.error_code, segment.error_message, contextSnapshotRef, usageFromLedger(ledger), executionContext);
    }
  }

  return await budgetExceeded(
    agentRun.agent_run_id,
    'AGENT_SEGMENT_BUDGET_EXCEEDED',
    'Pi durable agent workflow exceeded max segment budget',
    contextSnapshotRef,
    ledger,
    executionContext,
  );
}

async function executeProposedTools(input: {
  context: ActivityContext;
  executionPlan: AgentExecutionPlan;
  policy?: EffectiveTenantPolicy;
  agentRunId: string;
  segmentIndex: number;
  proposals: ProposedToolCall[];
  currentToolCallCount: number;
  decisions: Map<string, HumanTaskDecisionSignalInput>;
}): Promise<{ results: AgentAuthoritativeToolResult[]; chargedToolCallCount: number; humanTaskIds: string[] }> {
  const results: AgentAuthoritativeToolResult[] = [];
  const humanTaskIds: string[] = [];
  let chargedToolCallCount = 0;
  const activeBudget = input.policy?.budget ?? input.executionPlan.budget;
  for (const proposal of input.proposals.slice().sort((a, b) => a.source_order - b.source_order)) {
    chargedToolCallCount += 1;
    if (input.currentToolCallCount + chargedToolCallCount > activeBudget.max_tool_calls) {
      results.push(deniedToolResult(proposal, 'AGENT_TOOL_BUDGET_EXCEEDED', 'Tool call budget exceeded'));
      continue;
    }
    const plannedTool = resolvePlannedAgentTool(input.executionPlan, proposal);
    if (!plannedTool) {
      results.push(deniedToolResult(proposal, 'AGENT_TOOL_NOT_ALLOWED', `Tool is not in AgentExecutionPlan: ${proposal.tool_name}`));
      continue;
    }
    if (plannedTool.risk_level === 'L4') {
      results.push(deniedToolResult(proposal, 'AGENT_TOOL_RISK_DENIED', `L4 tool denied: ${proposal.tool_name}`));
      continue;
    }
    if (plannedTool.risk_level === 'L3') {
      const previewPolicyError = toolPolicyError(input.policy, plannedTool, 'preview');
      if (previewPolicyError) {
        results.push(deniedToolResult(proposal, previewPolicyError.code, previewPolicyError.message));
        continue;
      }
      const preview = await previewToolActivity(input.context, plannedTool, proposal.arguments, toolIdentity(input, proposal, 'preview'));
      if (preview.status === 'denied') {
        results.push(deniedToolResult(proposal, preview.error?.code ?? 'TOOL_PREVIEW_DENIED', preview.error?.message ?? 'Tool preview denied', preview.audit_event_id));
        continue;
      }
      const humanTask = await createHumanTaskActivity(input.context, {
        tool_call_id: preview.tool_call_id,
        tool_name: plannedTool.tool_name,
        payload: {
          agent_run_id: input.agentRunId,
          segment_index: input.segmentIndex,
          proposed_tool_call: proposal,
          preview,
        },
      });
      humanTaskIds.push(humanTask.human_task_id);
      await updateAgentRunActivity({ agent_run_id: input.agentRunId, status: 'waiting_human' });
      await updateAgentStepActivity({
        stable_step_key: stableStepKey(input.agentRunId, input.segmentIndex),
        segment_status: 'waiting_human',
        human_task_ids: [...humanTaskIds],
      });
      await condition(() => input.decisions.has(humanTask.human_task_id));
      const decision = input.decisions.get(humanTask.human_task_id);
      if (!decision || decision.status !== 'approved') {
        results.push(deniedToolResult(proposal, 'HUMAN_TASK_REJECTED', `Human task ${decision?.status ?? 'missing'}: ${humanTask.human_task_id}`));
        continue;
      }
      const commitPolicyError = toolPolicyError(input.policy, plannedTool, 'commit');
      if (commitPolicyError) {
        results.push(deniedToolResult(proposal, commitPolicyError.code, commitPolicyError.message));
        continue;
      }
      const commit = await commitToolActivity(input.context, preview.tool_call_id, plannedTool, proposal.arguments, toolIdentity(input, proposal, 'commit'));
      results.push({
        tool_call_id: proposal.call_id,
        tool_name: proposal.tool_name,
        tool_version: proposal.tool_version,
        result_ref: commit.tool_call_id ? `tool-call:${commit.tool_call_id}` : undefined,
        result_summary: summarizeToolResult(commit.result ?? commit.error ?? commit.status),
        status: commit.status,
        audit_event_id: commit.audit_event_id,
        error_code: commit.error?.code,
        is_error: commit.status !== 'committed' && commit.status !== 'replayed',
        content: [{ type: 'text', text: summarizeToolResult(commit.result ?? commit.error ?? commit.status) }],
        details: { status: commit.status, result: commit.result ?? null, error: commit.error ?? null },
      });
      continue;
    }
    const invokePolicyError = toolPolicyError(input.policy, plannedTool, 'invoke');
    if (invokePolicyError) {
      results.push(deniedToolResult(proposal, invokePolicyError.code, invokePolicyError.message));
      continue;
    }
    const invoke = await invokeToolActivity(input.context, plannedTool, proposal.arguments, toolIdentity(input, proposal, 'invoke'));
    results.push({
      tool_call_id: proposal.call_id,
      tool_name: proposal.tool_name,
      tool_version: proposal.tool_version,
      result_ref: invoke.tool_call_id ? `tool-call:${invoke.tool_call_id}` : undefined,
      result_summary: summarizeToolResult(invoke.result ?? invoke.error ?? invoke.status),
      status: invoke.status,
      audit_event_id: invoke.audit_event_id,
      error_code: invoke.error?.code,
      is_error: invoke.status === 'denied' || invoke.status === 'failed' || invoke.status === 'needs_confirmation',
      content: [{ type: 'text', text: summarizeToolResult(invoke.result ?? invoke.error ?? invoke.status) }],
      details: { status: invoke.status, result: invoke.result ?? null, error: invoke.error ?? null },
    });
  }
  return { results, chargedToolCallCount, humanTaskIds };
}

async function executeWorkflowHandoff(input: {
  context: ActivityContext;
  agentRunId: string;
  segmentIndex: number;
  handoffIndex: number;
  targetExecutionPlanRef: string;
  arguments: Record<string, unknown>;
  chain: string[];
  policy?: EffectiveTenantPolicy;
}): Promise<Record<string, unknown> & { status: 'completed' | 'failed'; child_workflow_id: string; error_code?: string; error_message?: string }> {
  if (input.chain.includes(input.targetExecutionPlanRef)) {
    return {
      status: 'failed',
      child_workflow_id: '',
      error_code: 'HANDOFF_RECURSION_DENIED',
      error_message: `Recursive workflow handoff denied: ${input.targetExecutionPlanRef}`,
    };
  }
  const targetPlan = await loadExecutionPlanByRefActivity(input.targetExecutionPlanRef, input.context.tenant_id);
  if (targetPlan.flow_spec.runtime.workflow_type !== 'ConfigDrivenWorkflow') {
    return {
      status: 'failed',
      child_workflow_id: '',
      error_code: 'HANDOFF_TARGET_NOT_CONFIG_WORKFLOW',
      error_message: 'Workflow handoff target must be ConfigDrivenWorkflow',
    };
  }
  const childPolicy = input.policy
    ? await deriveTenantPolicySnapshotActivity({
        ...input.context,
        parent_snapshot_ref: input.policy.snapshot_ref,
        target_execution_plan_ref: targetPlan.execution_plan_ref,
        target_execution_plan_hash: targetPlan.execution_plan_hash,
        target_execution_plan_type: 'flow',
        derivation_type: input.policy.derivation_type === 'root' ? 'workflow_handoff' : 'nested_handoff',
        tenant_policy_snapshot_ref: input.policy.snapshot_ref,
        tenant_policy_hash: input.policy.snapshot_hash,
      })
    : undefined;

  const childWorkflowId = [
    sanitizeWorkflowId(input.context.workflow_id),
    'agent',
    sanitizeWorkflowId(input.agentRunId),
    'handoff',
    String(input.handoffIndex),
    sanitizeWorkflowId(targetPlan.execution_plan_id),
  ].join('-');

  try {
    const result = await executeChild<typeof configDrivenWorkflow>('configDrivenWorkflow', {
      workflowId: childWorkflowId,
      args: [{
        tenant_id: input.context.tenant_id,
        user_id: input.context.user_id,
        task_run_id: input.context.task_run_id,
        workflow_id: childWorkflowId,
        flow_id: targetPlan.flow_id,
        flow_version: targetPlan.flow_version,
        execution_plan_ref: targetPlan.execution_plan_ref,
        flow_sha256: targetPlan.flow_sha256,
        request_id: input.context.request_id,
        ...(childPolicy ? { tenant_policy_snapshot_ref: childPolicy.snapshot_ref } : {}),
        ...(childPolicy ? { tenant_policy_hash: childPolicy.snapshot_hash } : {}),
        ...(input.context.tenant_admission_id ? { tenant_admission_id: input.context.tenant_admission_id } : {}),
        input: input.arguments,
      }],
    });
    return {
      status: result.status === 'completed' ? 'completed' : 'failed',
      parent_workflow_id: input.context.workflow_id,
      child_workflow_id: childWorkflowId,
      target_execution_plan_ref: input.targetExecutionPlanRef,
      handoff_arguments_ref: `agent:${input.agentRunId}:segment:${input.segmentIndex}:handoff:${input.handoffIndex}:args`,
      child_result_ref: `workflow:${childWorkflowId}:result`,
      child_status: result.status,
      ...(result.error_code ? { error_code: result.error_code } : {}),
      ...(result.error_message ? { error_message: result.error_message } : {}),
    };
  } catch (error) {
    return {
      status: 'failed',
      parent_workflow_id: input.context.workflow_id,
      child_workflow_id: childWorkflowId,
      target_execution_plan_ref: input.targetExecutionPlanRef,
      error_code: 'HANDOFF_CHILD_FAILED',
      error_message: error instanceof Error ? error.message : 'Handoff child workflow failed',
    };
  }
}

function remainingBudget(max: AgentBudget, ledger: AgentBudgetLedger): AgentBudget {
  return {
    max_segments: remainingPositive(max.max_segments, ledger.segment_count),
    max_model_turns: remainingPositive(max.max_model_turns, ledger.model_turn_count),
    max_tool_calls: remainingNonnegative(max.max_tool_calls, ledger.tool_call_count),
    max_input_tokens: remainingNonnegative(max.max_input_tokens, ledger.input_tokens),
    max_output_tokens: remainingNonnegative(max.max_output_tokens, ledger.output_tokens),
    max_total_tokens: remainingPositive(max.max_total_tokens, ledger.total_tokens),
    max_duration_ms: remainingPositive(max.max_duration_ms, ledger.elapsed_duration_ms),
    max_handoffs: remainingNonnegative(max.max_handoffs, ledger.handoff_count),
    max_context_bytes: remainingPositive(max.max_context_bytes, ledger.context_bytes),
    ...(max.max_cost !== undefined ? { max_cost: Math.max(max.max_cost - ledger.estimated_cost, 0) } : {}),
  };
}

function budgetExceededForLedger(max: AgentBudget, ledger: AgentBudgetLedger): { code: string; message: string } | undefined {
  if (ledger.segment_count >= max.max_segments) {
    return { code: 'AGENT_SEGMENT_BUDGET_EXCEEDED', message: 'Segment budget exceeded' };
  }
  if (ledger.model_turn_count >= max.max_model_turns) {
    return { code: 'AGENT_MODEL_TURN_BUDGET_EXCEEDED', message: 'Model turn budget exceeded' };
  }
  if (ledger.total_tokens >= max.max_total_tokens) {
    return { code: 'AGENT_TOKEN_BUDGET_EXCEEDED', message: 'Total token budget exceeded' };
  }
  if (ledger.elapsed_duration_ms >= max.max_duration_ms) {
    return { code: 'AGENT_DURATION_BUDGET_EXCEEDED', message: 'Duration budget exceeded' };
  }
  if (ledger.context_bytes > max.max_context_bytes) {
    return { code: 'AGENT_CONTEXT_BUDGET_EXCEEDED', message: 'Context byte budget exceeded' };
  }
  return undefined;
}

async function maybeContinueAsNew(
  originalInput: PiDurableAgentWorkflowInput,
  context: ActivityContext,
  agentRunId: string,
  contextSnapshotRef: PiContextSnapshotRef | undefined,
  ledger: AgentBudgetLedger,
  segmentIndex: number,
  maxSegmentsBeforeContinueAsNew: number,
  startedAtMs: number,
  handoffChain = originalInput.handoff_chain,
): Promise<void> {
  if (maxSegmentsBeforeContinueAsNew <= 0 || segmentIndex <= 0 || segmentIndex % maxSegmentsBeforeContinueAsNew !== 0) {
    return;
  }
  if (!contextSnapshotRef) {
    return;
  }
  await updateAgentRunActivity({
    agent_run_id: agentRunId,
    status: 'running',
    current_segment_index: segmentIndex,
    model_turn_count: ledger.model_turn_count,
    tool_call_count: ledger.tool_call_count,
    handoff_count: ledger.handoff_count,
    usage: usageFromLedger(ledger),
  });
  await continueAsNew<typeof piDurableAgentWorkflow>({
    tenant_id: context.tenant_id,
    user_id: context.user_id,
    task_run_id: context.task_run_id,
    workflow_id: context.workflow_id,
    ...(originalInput.parent_workflow_id ? { parent_workflow_id: originalInput.parent_workflow_id } : {}),
    agent_run_id: agentRunId,
    agent_execution_plan_ref: originalInput.agent_execution_plan_ref,
    execution_mode: originalInput.execution_mode ?? 'mediated_tool_call',
    context_snapshot_ref: contextSnapshotRef,
    budget_ledger: ledger,
    segment_index: segmentIndex,
    started_at_ms: startedAtMs,
    continue_as_new_segment_threshold: maxSegmentsBeforeContinueAsNew,
    ...(handoffChain ? { handoff_chain: handoffChain } : {}),
    ...(originalInput.tenant_policy_snapshot_ref ? { tenant_policy_snapshot_ref: originalInput.tenant_policy_snapshot_ref } : {}),
    ...(originalInput.tenant_policy_hash ? { tenant_policy_hash: originalInput.tenant_policy_hash } : {}),
    ...(originalInput.tenant_admission_id ? { tenant_admission_id: originalInput.tenant_admission_id } : {}),
    request_id: context.request_id,
    ...(originalInput.trace_id ? { trace_id: originalInput.trace_id } : {}),
  });
}

async function budgetExceeded(
  agentRunId: string,
  code: string,
  message: string,
  contextSnapshotRef: PiContextSnapshotRef | undefined,
  ledger: AgentBudgetLedger,
  context: ActivityContext,
): Promise<PiDurableAgentWorkflowResult> {
  await updateAgentRunActivity({
    agent_run_id: agentRunId,
    status: 'budget_exceeded',
    completed: true,
    error_code: code,
    error_message: message,
    usage: usageFromLedger(ledger),
  });
  await updateTaskRunStatusActivity({ ...context, status: 'failed', error_code: code, error_message: message });
  return {
    status: 'budget_exceeded',
    agent_run_id: agentRunId,
    ...(contextSnapshotRef ? { context_snapshot_ref: contextSnapshotRef } : {}),
    usage: usageFromLedger(ledger),
    error: { code, message },
  };
}

async function failAgentRun(
  agentRunId: string,
  code: string,
  message: string,
  contextSnapshotRef: PiContextSnapshotRef | undefined,
  usage: PiDurableAgentWorkflowResult['usage'],
  context: ActivityContext,
): Promise<PiDurableAgentWorkflowResult> {
  await updateAgentRunActivity({
    agent_run_id: agentRunId,
    status: 'failed',
    completed: true,
    error_code: code,
    error_message: message,
    usage,
  });
  await updateTaskRunStatusActivity({ ...context, status: 'failed', error_code: code, error_message: message });
  return {
    status: 'failed',
    agent_run_id: agentRunId,
    ...(contextSnapshotRef ? { context_snapshot_ref: contextSnapshotRef } : {}),
    usage,
    error: { code, message },
  };
}

function applySegmentLedger(
  ledger: AgentBudgetLedger,
  segment: PiSegmentResult,
  contextSnapshotRef: PiContextSnapshotRef | undefined,
): AgentBudgetLedger {
  return {
    ...ledger,
    segment_count: ledger.segment_count + 1,
    model_turn_count: ledger.model_turn_count + segment.model_turn_count,
    input_tokens: ledger.input_tokens + segment.usage.input_tokens,
    output_tokens: ledger.output_tokens + segment.usage.output_tokens,
    total_tokens: ledger.total_tokens + segment.usage.total_tokens,
    estimated_cost: ledger.estimated_cost + (segment.usage.estimated_cost ?? 0),
    elapsed_duration_ms: ledger.elapsed_duration_ms,
    context_bytes: contextSnapshotRef?.byte_size ?? ledger.context_bytes,
  };
}

function normalizeLedger(input: AgentBudgetLedger | undefined): AgentBudgetLedger {
  return {
    segment_count: input?.segment_count ?? 0,
    model_turn_count: input?.model_turn_count ?? 0,
    tool_call_count: input?.tool_call_count ?? 0,
    handoff_count: input?.handoff_count ?? 0,
    input_tokens: input?.input_tokens ?? 0,
    output_tokens: input?.output_tokens ?? 0,
    total_tokens: input?.total_tokens ?? 0,
    estimated_cost: input?.estimated_cost ?? 0,
    elapsed_duration_ms: input?.elapsed_duration_ms ?? 0,
    context_bytes: input?.context_bytes ?? 0,
  };
}

function usageFromLedger(ledger: AgentBudgetLedger): PiDurableAgentWorkflowResult['usage'] {
  return {
    input_tokens: ledger.input_tokens,
    output_tokens: ledger.output_tokens,
    total_tokens: ledger.total_tokens,
    estimated_cost: ledger.estimated_cost,
  };
}

function statusForSegment(segment: PiSegmentResult): AgentRunRecord['status'] {
  switch (segment.status) {
    case 'completed':
      return 'completed';
    case 'tool_requested':
      return 'waiting_tool';
    case 'user_input_required':
      return 'waiting_user';
    case 'handoff_requested':
      return 'handing_off';
    case 'stopped_by_budget':
      return 'budget_exceeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function resolvePlannedAgentTool(plan: AgentExecutionPlan, proposal: ProposedToolCall): FlowExecutionPlanTool | undefined {
  const entry = plan.allowed_tools.find((tool) =>
    tool.tool_name === proposal.tool_name
    && tool.tool_version === proposal.tool_version
    && tool.tool_sha256 === proposal.tool_sha256
    && tool.risk_level === proposal.risk_level,
  );
  return entry
    ? {
        step_id: `agent:${proposal.call_id}`,
        tool_name: entry.tool_name,
        tool_version: entry.tool_version,
        tool_sha256: entry.tool_sha256,
        risk_level: entry.risk_level,
      }
    : undefined;
}

function modelAllowedByPolicy(policy: EffectiveTenantPolicy, modelPolicy: string): boolean {
  return policy.allowed_models.some((rule) => rule.model_id === modelPolicy);
}

function handoffAllowedByPolicy(policy: EffectiveTenantPolicy, targetExecutionPlanRef: string): boolean {
  return policy.allowed_handoffs.some((rule) =>
    rule.execution_plan_refs?.includes(targetExecutionPlanRef) || rule.flow_id === targetExecutionPlanRef);
}

function toolPolicyError(
  policy: EffectiveTenantPolicy | undefined,
  tool: FlowExecutionPlanTool,
  operation: 'invoke' | 'preview' | 'commit',
): { code: string; message: string } | undefined {
  if (!policy) {
    return undefined;
  }
  const denied = policy.denied_tools.some((rule) => rule.tool_name === tool.tool_name && ruleMatchesVersion(rule, tool.tool_version));
  if (denied) {
    return {
      code: 'TOOL_DENIED_BY_TENANT_POLICY',
      message: `Tool denied by tenant policy snapshot: ${tool.tool_name}@${tool.tool_version}`,
    };
  }
  const allowed = policy.allowed_tools.some((rule) =>
    rule.tool_name === tool.tool_name
    && ruleMatchesVersion(rule, tool.tool_version)
    && rule.allowed_operations.includes(operation)
    && (!rule.max_risk_level || riskRank(tool.risk_level) <= riskRank(rule.max_risk_level)));
  return allowed
    ? undefined
    : {
        code: 'TOOL_DENIED_BY_TENANT_POLICY',
        message: `Tool operation is not allowed by tenant policy snapshot: ${tool.tool_name}@${tool.tool_version}:${operation}`,
      };
}

function ruleMatchesVersion(rule: { versions?: string[] | undefined }, version: string): boolean {
  return !rule.versions?.length || rule.versions.includes(version);
}

function riskRank(riskLevel: string): number {
  return Number(riskLevel.slice(1));
}

function deniedToolResult(proposal: ProposedToolCall, code: string, message: string, auditEventId?: string): AgentAuthoritativeToolResult {
  return {
    tool_call_id: proposal.call_id,
    tool_name: proposal.tool_name,
    tool_version: proposal.tool_version,
    result_summary: message,
    status: 'denied',
    ...(auditEventId ? { audit_event_id: auditEventId } : {}),
    error_code: code,
    is_error: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    details: { status: 'denied', error: { code, message } },
  };
}

function handoffToolResult(segment: Extract<PiSegmentResult, { status: 'handoff_requested' }>, handoff: Record<string, unknown>): AgentAuthoritativeToolResult {
  return {
    tool_call_id: segment.call_id,
    tool_name: 'handoff_to_workflow',
    tool_version: '1',
    result_ref: typeof handoff.child_result_ref === 'string' ? handoff.child_result_ref : undefined,
    result_summary: summarizeToolResult({ status: handoff.status, child_workflow_id: handoff.child_workflow_id }),
    status: String(handoff.status ?? 'completed'),
    is_error: handoff.status !== 'completed',
    content: [{ type: 'text', text: summarizeToolResult({ status: handoff.status, target: segment.target_execution_plan_ref }) }],
    details: { kind: 'authoritative_handoff_result', ...handoff },
  };
}

function toolResultRef(result: AgentAuthoritativeToolResult): AgentToolResultReference {
  return {
    tool_call_id: result.tool_call_id,
    tool_name: result.tool_name,
    tool_version: result.tool_version,
    ...(result.result_ref ? { result_ref: result.result_ref } : {}),
    ...(result.result_summary ? { result_summary: result.result_summary } : {}),
    ...(result.status ? { status: result.status } : {}),
    ...(result.audit_event_id ? { audit_event_id: result.audit_event_id } : {}),
    ...(result.error_code ? { error_code: result.error_code } : {}),
    is_error: result.is_error,
  };
}

function toolIdentity(
  input: { agentRunId: string; segmentIndex: number },
  proposal: ProposedToolCall,
  operation: AgentToolExecutionIdentity['operation'],
): AgentToolExecutionIdentity {
  return {
    agent_run_id: input.agentRunId,
    segment_index: input.segmentIndex,
    call_id: proposal.call_id,
    operation,
    tool_name: proposal.tool_name,
    tool_version: proposal.tool_version,
  };
}

function stableStepKey(agentRunId: string, segmentIndex: number): string {
  return `${agentRunId}:${segmentIndex}`;
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(Date.now() - startedAtMs, 0);
}

function remainingPositive(max: number, used: number): number {
  return Math.max(max - used, 1);
}

function remainingNonnegative(max: number, used: number): number {
  return Math.max(max - used, 0);
}

function sanitizeWorkflowId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, '-');
}

function summarizeToolResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}
