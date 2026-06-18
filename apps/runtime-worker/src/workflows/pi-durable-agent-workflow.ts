import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type {
  PiDurableAgentWorkflowInput,
  HumanTaskDecisionSignalInput,
  UserInputResponseSignalInput,
} from '@dar/temporal';
import { WORKFLOW_SIGNALS } from '@dar/temporal';
import type {
  AgentAuthoritativeToolResult,
  AgentBudget,
  AgentExecutionPlan,
  AgentRunRecord,
  PiContextSnapshotRef,
  PiDurableAgentWorkflowResult,
  PiSegmentResult,
  ProposedToolCall,
  FlowExecutionPlanTool,
  HumanTask,
} from '@dar/contracts';
import type {
  ActivityContext,
  AppendUserInputActivityInput,
  CreateAgentRunActivityInput,
  CreateHumanTaskActivityInput,
  PersistToolResultsActivityInput,
  UpdateAgentRunActivityInput,
} from '../activities/index.js';
import type { FlowExecutionActivities } from '../interpreter/flow-interpreter.js';

const humanTaskDecisionSignal = defineSignal<[HumanTaskDecisionSignalInput]>(WORKFLOW_SIGNALS.humanTaskDecision);
const userInputResponseSignal = defineSignal<[UserInputResponseSignalInput]>(WORKFLOW_SIGNALS.userInputResponse);

const {
  createAgentRunActivity,
  loadAgentExecutionPlanByRefActivity,
  runPiSegmentActivity,
  updateAgentRunActivity,
  invokeToolActivity,
  previewToolActivity,
  commitToolActivity,
  createHumanTaskActivity,
  persistToolResultsToPiContextActivity,
  appendUserInputToPiContextActivity,
} = proxyActivities<{
  createAgentRunActivity(input: CreateAgentRunActivityInput): Promise<AgentRunRecord>;
  loadAgentExecutionPlanByRefActivity(executionPlanRef: string, tenantId?: string): Promise<AgentExecutionPlan>;
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
  invokeToolActivity: FlowExecutionActivities['invokeTool'];
  previewToolActivity: FlowExecutionActivities['previewTool'];
  commitToolActivity: FlowExecutionActivities['commitTool'];
  createHumanTaskActivity(context: ActivityContext, input?: CreateHumanTaskActivityInput): Promise<HumanTask>;
  persistToolResultsToPiContextActivity(input: PersistToolResultsActivityInput): Promise<PiContextSnapshotRef>;
  appendUserInputToPiContextActivity(input: AppendUserInputActivityInput): Promise<PiContextSnapshotRef>;
}>({
  startToCloseTimeout: '6 minutes',
});

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

  const context: ActivityContext = {
    tenant_id: input.tenant_id,
    user_id: input.user_id,
    task_run_id: input.task_run_id,
    workflow_id: input.workflow_id ?? `agent-${input.tenant_id}-${input.task_run_id}`,
    request_id: input.request_id,
  };
  const executionPlan = await loadAgentExecutionPlanByRefActivity(input.agent_execution_plan_ref, input.tenant_id);
  const agentRun = await createAgentRunActivity({
    ...context,
    execution_plan_ref: executionPlan.execution_plan_ref,
    ...(input.parent_workflow_id ? { parent_workflow_id: input.parent_workflow_id } : {}),
    execution_mode: input.execution_mode ?? 'mediated_tool_call',
  });

  let contextSnapshotRef: PiContextSnapshotRef | undefined;
  let segmentIndex = 0;
  let toolCallCount = 0;
  let handoffCount = 0;
  let totalUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  while (segmentIndex < executionPlan.budget.max_segments) {
    const segmentInput = {
      agent_run_id: agentRun.agent_run_id,
      execution_plan_ref: executionPlan.execution_plan_ref,
      ...(contextSnapshotRef ? { context_snapshot_ref: contextSnapshotRef } : {}),
      ...(!contextSnapshotRef && input.initial_user_input ? { initial_user_input: input.initial_user_input } : {}),
      resume_reason: segmentIndex === 0 ? 'initial_prompt' : 'durable_boundary_resolved',
      segment_index: segmentIndex,
      budget_remaining: executionPlan.budget,
      request_context: context,
    };
    const segment = await runPiSegmentActivity(segmentInput);
    contextSnapshotRef = 'context_snapshot_ref' in segment ? segment.context_snapshot_ref : contextSnapshotRef;
    totalUsage = addUsage(totalUsage, segment.usage);

    await updateAgentRunActivity({
      agent_run_id: agentRun.agent_run_id,
      status: statusForSegment(segment),
      current_segment_index: segmentIndex,
      model_turn_count: segment.model_turn_count,
      tool_call_count: toolCallCount,
      handoff_count: handoffCount,
      usage: totalUsage,
    });

    if (segment.status === 'completed') {
      await updateAgentRunActivity({
        agent_run_id: agentRun.agent_run_id,
        status: 'completed',
        completed: true,
        usage: totalUsage,
      });
      return {
        status: 'completed',
        agent_run_id: agentRun.agent_run_id,
        ...(segment.final_answer ? { final_answer: segment.final_answer } : {}),
        ...(contextSnapshotRef ? { context_snapshot_ref: contextSnapshotRef } : {}),
        usage: totalUsage,
      };
    }

    if (segment.status === 'tool_requested') {
      const authoritativeResults = await executeProposedTools({
        context,
        executionPlan,
        agentRunId: agentRun.agent_run_id,
        segmentIndex,
        proposals: segment.proposed_tool_calls,
        currentToolCallCount: toolCallCount,
        decisions: humanDecisions,
      });
      toolCallCount += segment.proposed_tool_calls.length;
      contextSnapshotRef = await persistToolResultsToPiContextActivity({
        agent_run_id: agentRun.agent_run_id,
        previous_context_snapshot_ref: segment.context_snapshot_ref,
        tool_results: authoritativeResults,
        request_context: context,
      });
      segmentIndex += 1;
      continue;
    }

    if (segment.status === 'user_input_required') {
      const humanTask = await createHumanTaskActivity(context, {
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
      await condition(() => userInputs.has(humanTask.human_task_id));
      const response = userInputs.get(humanTask.human_task_id);
      if (!response) {
        throw new Error(`User input signal missing after wait: ${humanTask.human_task_id}`);
      }
      contextSnapshotRef = await appendUserInputToPiContextActivity({
        agent_run_id: agentRun.agent_run_id,
        previous_context_snapshot_ref: segment.context_snapshot_ref,
        human_task_id: humanTask.human_task_id,
        response: response.response,
        responded_by: response.responded_by,
        request_context: context,
      });
      segmentIndex += 1;
      continue;
    }

    if (segment.status === 'handoff_requested') {
      handoffCount += 1;
      if (!executionPlan.allowed_handoffs.includes(segment.target_execution_plan_ref)) {
        return await failAgentRun(agentRun.agent_run_id, 'HANDOFF_DENIED', `Unauthorized handoff target: ${segment.target_execution_plan_ref}`, contextSnapshotRef, totalUsage);
      }
      return await failAgentRun(agentRun.agent_run_id, 'HANDOFF_NOT_IMPLEMENTED', 'Workflow handoff execution is not implemented in this runtime slice', contextSnapshotRef, totalUsage);
    }

    if (segment.status === 'stopped_by_budget') {
      await updateAgentRunActivity({
        agent_run_id: agentRun.agent_run_id,
        status: 'budget_exceeded',
        completed: true,
        error_code: segment.error_code,
        error_message: segment.error_message,
        usage: totalUsage,
      });
      return {
        status: 'budget_exceeded',
        agent_run_id: agentRun.agent_run_id,
        ...(contextSnapshotRef ? { context_snapshot_ref: contextSnapshotRef } : {}),
        usage: totalUsage,
        error: { code: segment.error_code, message: segment.error_message },
      };
    }

    if (segment.status === 'failed' || segment.status === 'cancelled') {
      return await failAgentRun(agentRun.agent_run_id, segment.error_code, segment.error_message, contextSnapshotRef, totalUsage);
    }
  }

  return await failAgentRun(
    agentRun.agent_run_id,
    'AGENT_SEGMENT_BUDGET_EXCEEDED',
    'Pi durable agent workflow exceeded max segment budget',
    contextSnapshotRef,
    totalUsage,
  );
}

async function executeProposedTools(input: {
  context: ActivityContext;
  executionPlan: AgentExecutionPlan;
  agentRunId: string;
  segmentIndex: number;
  proposals: ProposedToolCall[];
  currentToolCallCount: number;
  decisions: Map<string, HumanTaskDecisionSignalInput>;
}): Promise<AgentAuthoritativeToolResult[]> {
  const results: AgentAuthoritativeToolResult[] = [];
  for (const proposal of input.proposals.slice().sort((a, b) => a.source_order - b.source_order)) {
    if (input.currentToolCallCount + results.length >= input.executionPlan.budget.max_tool_calls) {
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
      const preview = await previewToolActivity(input.context, plannedTool, proposal.arguments);
      if (preview.status === 'denied') {
        results.push(deniedToolResult(proposal, preview.error?.code ?? 'TOOL_PREVIEW_DENIED', preview.error?.message ?? 'Tool preview denied'));
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
      await condition(() => input.decisions.has(humanTask.human_task_id));
      const decision = input.decisions.get(humanTask.human_task_id);
      if (!decision || decision.status !== 'approved') {
        results.push(deniedToolResult(proposal, 'HUMAN_TASK_REJECTED', `Human task ${decision?.status ?? 'missing'}: ${humanTask.human_task_id}`));
        continue;
      }
      const commit = await commitToolActivity(input.context, preview.tool_call_id, plannedTool, proposal.arguments);
      results.push({
        tool_call_id: proposal.call_id,
        tool_name: proposal.tool_name,
        tool_version: proposal.tool_version,
        result_summary: summarizeToolResult(commit.result ?? commit.error ?? commit.status),
        is_error: commit.status !== 'committed' && commit.status !== 'replayed',
        content: [{ type: 'text', text: summarizeToolResult(commit.result ?? commit.error ?? commit.status) }],
        details: { status: commit.status, result: commit.result ?? null, error: commit.error ?? null },
      });
      continue;
    }
    const invoke = await invokeToolActivity(input.context, plannedTool, proposal.arguments);
    results.push({
      tool_call_id: proposal.call_id,
      tool_name: proposal.tool_name,
      tool_version: proposal.tool_version,
      result_summary: summarizeToolResult(invoke.result ?? invoke.error ?? invoke.status),
      is_error: invoke.status === 'denied' || invoke.status === 'failed' || invoke.status === 'needs_confirmation',
      content: [{ type: 'text', text: summarizeToolResult(invoke.result ?? invoke.error ?? invoke.status) }],
      details: { status: invoke.status, result: invoke.result ?? null, error: invoke.error ?? null },
    });
  }
  return results;
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

function deniedToolResult(proposal: ProposedToolCall, code: string, message: string): AgentAuthoritativeToolResult {
  return {
    tool_call_id: proposal.call_id,
    tool_name: proposal.tool_name,
    tool_version: proposal.tool_version,
    result_summary: message,
    is_error: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    details: { status: 'denied', error: { code, message } },
  };
}

async function failAgentRun(
  agentRunId: string,
  code: string,
  message: string,
  contextSnapshotRef: PiContextSnapshotRef | undefined,
  usage: PiDurableAgentWorkflowResult['usage'],
): Promise<PiDurableAgentWorkflowResult> {
  await updateAgentRunActivity({
    agent_run_id: agentRunId,
    status: 'failed',
    completed: true,
    error_code: code,
    error_message: message,
    usage,
  });
  return {
    status: 'failed',
    agent_run_id: agentRunId,
    ...(contextSnapshotRef ? { context_snapshot_ref: contextSnapshotRef } : {}),
    usage,
    error: { code, message },
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

function addUsage(
  left: PiDurableAgentWorkflowResult['usage'],
  right: PiDurableAgentWorkflowResult['usage'],
): PiDurableAgentWorkflowResult['usage'] {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cache_read_tokens: (left.cache_read_tokens ?? 0) + (right.cache_read_tokens ?? 0),
    cache_write_tokens: (left.cache_write_tokens ?? 0) + (right.cache_write_tokens ?? 0),
    total_tokens: left.total_tokens + right.total_tokens,
    estimated_cost: (left.estimated_cost ?? 0) + (right.estimated_cost ?? 0),
  };
}

function summarizeToolResult(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}
