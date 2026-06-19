import { Agent, type AgentEvent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import {
  type AgentBudget,
  type AgentExecutionPlan,
  type AgentUsage,
  type ProposedToolCall,
  agentUsageSchema,
  proposedToolCallSchema,
} from '@dar/contracts';
import {
  buildDeferredPiTools,
  HANDOFF_TO_WORKFLOW_TOOL,
  REQUEST_USER_INPUT_TOOL,
} from './deferred-pi-tool.js';
import {
  type SerializedPiContext,
  restorePiMessages,
  safeSummary,
  serializePiContext,
} from './pi-context-codec.js';

export interface PiAgentAdapterInput {
  executionPlan: AgentExecutionPlan;
  model: Model<string>;
  streamFn: StreamFn;
  contextMessages?: unknown[];
  initialUserInput?: string;
  segmentIndex: number;
  budgetRemaining: AgentBudget;
  maxContextBytes: number;
  abortSignal?: AbortSignal;
}

export type PiSegmentResultWithoutSnapshot =
  | { status: 'completed'; final_answer?: string; usage: AgentUsage; model_turn_count: number }
  | { status: 'tool_requested'; proposed_tool_calls: ProposedToolCall[]; usage: AgentUsage; model_turn_count: number }
  | { status: 'user_input_required'; question: string; requested_schema: Record<string, unknown>; usage: AgentUsage; model_turn_count: number }
  | { status: 'handoff_requested'; call_id: string; target_execution_plan_ref: string; arguments: Record<string, unknown>; usage: AgentUsage; model_turn_count: number }
  | { status: 'stopped_by_budget'; error_code: string; error_message: string; usage: AgentUsage; model_turn_count: number }
  | { status: 'failed'; error_code: string; error_message: string; usage: AgentUsage; model_turn_count: number }
  | { status: 'cancelled'; error_code: string; error_message: string; usage: AgentUsage; model_turn_count: number };

export interface PiAgentAdapterResult {
  segmentResult: PiSegmentResultWithoutSnapshot;
  context: SerializedPiContext;
  messages: AgentMessage[];
}

export async function runPiAgentSegment(input: PiAgentAdapterInput): Promise<PiAgentAdapterResult> {
  const restoredMessages = input.contextMessages
    ? restorePiMessages({ schema_version: 'pi-context/v1', messages: input.contextMessages })
    : [];
  const tools = buildDeferredPiTools(input.executionPlan.allowed_tools, input.executionPlan.allowed_handoffs);
  const proposals: ProposedToolCall[] = [];
  const usage: AgentUsage = agentUsageSchema.parse({});
  let modelTurnCount = 0;
  let finalAnswer: string | undefined;
  let errorMessage: string | undefined;

  const agent = new Agent({
    initialState: {
      systemPrompt: input.executionPlan.plan.system_prompt,
      model: input.model,
      tools,
      messages: restoredMessages,
      thinkingLevel: 'off',
    },
    streamFn: input.streamFn,
    toolExecution: 'sequential',
    afterToolCall: async (context) => {
      const details = extractProposalDetails(context.result.details);
      if (details) {
        proposals.push({
          ...details,
          source_order: proposals.length,
        });
      }
      return { terminate: true };
    },
    transformContext: async (messages) => messages,
  });

  const unsubscribe = agent.subscribe((event) => {
    collectAgentEvent(event, usage);
    if (event.type === 'turn_end') {
      modelTurnCount += 1;
      if (isAssistantMessage(event.message)) {
        if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
          errorMessage = event.message.errorMessage ?? `Pi segment ended with ${event.message.stopReason}`;
        } else {
          finalAnswer = assistantText(event.message);
        }
      }
    }
  });

  const abortListener = () => agent.abort();
  input.abortSignal?.addEventListener('abort', abortListener, { once: true });

  try {
    if (input.contextMessages && input.contextMessages.length > 0) {
      await agent.continue();
    } else {
      await agent.prompt(input.initialUserInput ?? '');
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Pi Agent segment failed';
  } finally {
    unsubscribe();
    input.abortSignal?.removeEventListener('abort', abortListener);
  }

  const context = serializePiContext(agent.state.messages, { maxBytes: input.maxContextBytes });
  const messages = agent.state.messages;
  const resultInput: Parameters<typeof buildSegmentResult>[0] = {
    proposals,
    context,
    usage,
    modelTurnCount,
    budgetRemaining: input.budgetRemaining,
  };
  if (finalAnswer) {
    resultInput.finalAnswer = finalAnswer;
  }
  if (errorMessage) {
    resultInput.errorMessage = errorMessage;
  }
  const statusResult = buildSegmentResult(resultInput);

  return {
    segmentResult: statusResult,
    context,
    messages,
  };
}

function buildSegmentResult(input: {
  proposals: ProposedToolCall[];
  finalAnswer?: string;
  errorMessage?: string;
  context: SerializedPiContext;
  usage: AgentUsage;
  modelTurnCount: number;
  budgetRemaining: AgentBudget;
}): PiSegmentResultWithoutSnapshot {
  if (input.errorMessage) {
    return {
      status: 'failed',
      error_code: 'PI_SEGMENT_FAILED',
      error_message: input.errorMessage,
      usage: input.usage,
      model_turn_count: input.modelTurnCount,
    };
  }

  if (input.modelTurnCount > input.budgetRemaining.max_model_turns || input.usage.total_tokens > input.budgetRemaining.max_total_tokens) {
    return {
      status: 'stopped_by_budget',
      error_code: 'AGENT_BUDGET_EXCEEDED',
      error_message: 'Pi segment exceeded remaining budget',
      usage: input.usage,
      model_turn_count: input.modelTurnCount,
    };
  }

  if (input.proposals.length > 0) {
    const boundaryKinds = new Set(input.proposals.map((proposal) => proposal.tool_name));
    const hasUserInput = boundaryKinds.has(REQUEST_USER_INPUT_TOOL);
    const hasHandoff = boundaryKinds.has(HANDOFF_TO_WORKFLOW_TOOL);
    const hasBusinessTool = input.proposals.some(
      (proposal) => proposal.tool_name !== REQUEST_USER_INPUT_TOOL && proposal.tool_name !== HANDOFF_TO_WORKFLOW_TOOL,
    );
    if ([hasUserInput, hasHandoff, hasBusinessTool].filter(Boolean).length > 1) {
      return {
        status: 'failed',
        error_code: 'INVALID_BOUNDARY_BATCH',
        error_message: 'Pi requested mixed durable boundary types in one segment',
        usage: input.usage,
        model_turn_count: input.modelTurnCount,
      };
    }
    if (hasUserInput) {
      const request = input.proposals[0]?.arguments ?? {};
      return {
        status: 'user_input_required',
        question: typeof request.question === 'string' ? request.question : 'Additional input is required.',
        requested_schema: isRecord(request.requested_schema) ? request.requested_schema : {},
        usage: input.usage,
        model_turn_count: input.modelTurnCount,
      };
    }
    if (hasHandoff) {
      const request = input.proposals[0]?.arguments ?? {};
      const proposal = input.proposals[0];
      return {
        status: 'handoff_requested',
        call_id: proposal?.call_id ?? 'handoff_call',
        target_execution_plan_ref: typeof request.target_execution_plan_ref === 'string' ? request.target_execution_plan_ref : '',
        arguments: isRecord(request.arguments) ? request.arguments : {},
        usage: input.usage,
        model_turn_count: input.modelTurnCount,
      };
    }
    return {
      status: 'tool_requested',
      proposed_tool_calls: input.proposals,
      usage: input.usage,
      model_turn_count: input.modelTurnCount,
    };
  }

  const completed: PiSegmentResultWithoutSnapshot = {
    status: 'completed',
    usage: input.usage,
    model_turn_count: input.modelTurnCount,
  };
  return input.finalAnswer ? { ...completed, final_answer: input.finalAnswer } : completed;
}

function collectAgentEvent(event: AgentEvent, usage: AgentUsage): void {
  if (event.type !== 'turn_end' || !isAssistantMessage(event.message)) {
    return;
  }
  addUsage(usage, event.message.usage);
}

function addUsage(total: AgentUsage, usage: Usage): void {
  total.input_tokens += usage.input;
  total.output_tokens += usage.output;
  total.cache_read_tokens = (total.cache_read_tokens ?? 0) + usage.cacheRead;
  total.cache_write_tokens = (total.cache_write_tokens ?? 0) + usage.cacheWrite;
  total.total_tokens += usage.totalTokens;
  total.estimated_cost = (total.estimated_cost ?? 0) + usage.cost.total;
}

function extractProposalDetails(value: unknown): ProposedToolCall | undefined {
  if (!isRecord(value) || value.kind !== 'deferred_tool_proposal') {
    return undefined;
  }
  return proposedToolCallSchema.parse(value);
}

function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: 'assistant' }> {
  return isRecord(message) && message.role === 'assistant';
}

function assistantText(message: Extract<AgentMessage, { role: 'assistant' }>): string | undefined {
  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
  return text.length > 0 ? text : undefined;
}

export function toolResultReferenceFromMessage(message: ToolResultMessage): {
  tool_call_id: string;
  tool_name: string;
  result_summary: string;
  is_error: boolean;
} {
  return {
    tool_call_id: message.toolCallId,
    tool_name: message.toolName,
    result_summary: safeSummary(message.content),
    is_error: message.isError,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
