import {
  type AssistantMessage,
  type Context,
  type Model,
  type StreamOptions,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
} from '@earendil-works/pi-ai';
import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  HANDOFF_TO_WORKFLOW_TOOL,
  REQUEST_USER_INPUT_TOOL,
} from '../../src/agent/deferred-pi-tool.js';

export type DeterministicPiScenario =
  | 'final_only'
  | 'readonly_tool'
  | 'l3_tool'
  | 'need_user'
  | 'handoff'
  | 'repeated_tool'
  | 'endless_turns'
  | 'excessive_tokens'
  | 'invalid_tool'
  | 'l4_tool'
  | 'malformed_output'
  | 'stream_error'
  | 'aborted';

export interface DeterministicPiStream {
  model: Model<string>;
  streamFn: StreamFn;
  unregister(): void;
}

export function createDeterministicPiStream(scenario: DeterministicPiScenario): DeterministicPiStream {
  const registration = registerFauxProvider({
    api: `dar-deterministic-${scenario}`,
    provider: 'dar-deterministic',
    models: [{ id: `dar-deterministic-${scenario}`, name: `DAR deterministic ${scenario}` }],
    tokensPerSecond: 0,
  });

  const streamFn: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const message = responseForScenario(scenario, context, options, model);
    queueMicrotask(() => {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'error', reason: message.stopReason, error: message });
        stream.end(message);
        return;
      }
      stream.push({ type: 'start', partial: message });
      for (const [index, block] of message.content.entries()) {
        if (block.type === 'text') {
          stream.push({ type: 'text_start', contentIndex: index, partial: message });
          stream.push({ type: 'text_delta', contentIndex: index, delta: block.text, partial: message });
          stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: message });
        }
        if (block.type === 'toolCall') {
          stream.push({ type: 'toolcall_start', contentIndex: index, partial: message });
          stream.push({ type: 'toolcall_delta', contentIndex: index, delta: JSON.stringify(block.arguments), partial: message });
          stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial: message });
        }
      }
      stream.push({
        type: 'done',
        reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
        message,
      });
      stream.end(message);
    });
    return stream;
  };

  return {
    model: registration.getModel(),
    streamFn,
    unregister: registration.unregister,
  };
}

function responseForScenario(
  scenario: DeterministicPiScenario,
  context: Context,
  options: StreamOptions | undefined,
  model: Model<string>,
): AssistantMessage {
  const toolResults = context.messages.filter((message) => message.role === 'toolResult');
  if (options?.signal?.aborted || scenario === 'aborted') {
    return fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'Pi segment aborted' });
  }
  if (scenario === 'stream_error') {
    return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Deterministic stream error' });
  }
  if (toolResults.length > 0) {
    if (scenario === 'readonly_tool') {
      return withModel(
        fauxAssistantMessage(
          `Final answer after ${toolResults.length} durable boundary result(s). ${toolResultSummary(toolResults)}`
        ),
        model,
      );
    }
    return withModel(fauxAssistantMessage(`Final answer after ${toolResults.length} durable boundary result(s).`), model);
  }

  switch (scenario) {
    case 'readonly_tool':
      return withModel(fauxAssistantMessage(
        [fauxToolCall(firstToolName(context, 'knowledge.search'), { query: 'deterministic lookup' }, { id: 'call_readonly_1' })],
        { stopReason: 'toolUse' },
      ), model);
    case 'l3_tool':
      return withModel(fauxAssistantMessage(
        [fauxToolCall(preferredToolName(context, 'record.write.mock'), { record: { summary: 'deterministic write' } }, { id: 'call_l3_1' })],
        { stopReason: 'toolUse' },
      ), model);
    case 'need_user':
      return withModel(fauxAssistantMessage(
        [fauxToolCall(REQUEST_USER_INPUT_TOOL, {
          question: 'Please provide the missing value.',
          requested_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          reason_summary: 'Need one required field',
        }, { id: 'call_user_1' })],
        { stopReason: 'toolUse' },
      ), model);
    case 'handoff':
      return withModel(fauxAssistantMessage(
        [fauxToolCall(HANDOFF_TO_WORKFLOW_TOOL, {
          target_execution_plan_ref: 'db://flow-execution-plan/plan_handoff',
          arguments: { source: 'deterministic' },
          reason_summary: 'Need workflow handoff',
        }, { id: 'call_handoff_1' })],
        { stopReason: 'toolUse' },
      ), model);
    case 'repeated_tool':
      return withModel(fauxAssistantMessage(
        [
          fauxToolCall(firstToolName(context, 'knowledge.search'), { query: 'first' }, { id: 'call_repeat_1' }),
          fauxToolCall(firstToolName(context, 'knowledge.search'), { query: 'second' }, { id: 'call_repeat_2' }),
        ],
        { stopReason: 'toolUse' },
      ), model);
    case 'endless_turns':
      return withModel(fauxAssistantMessage(
        [fauxToolCall(firstToolName(context, 'knowledge.search'), { query: `loop_${toolResults.length}` }, { id: `call_loop_${toolResults.length}` })],
        { stopReason: 'toolUse' },
      ), model);
    case 'excessive_tokens':
      return withModel(fauxAssistantMessage('x'.repeat(20_000)), model);
    case 'invalid_tool':
      return withModel(fauxAssistantMessage(
        [fauxToolCall('not.allowed.tool', { value: true }, { id: 'call_invalid_1' })],
        { stopReason: 'toolUse' },
      ), model);
    case 'l4_tool':
      return withModel(fauxAssistantMessage(
        [fauxToolCall(firstToolName(context, 'dangerous.l4'), { value: true }, { id: 'call_l4_1' })],
        { stopReason: 'toolUse' },
      ), model);
    case 'malformed_output':
      return withModel(fauxAssistantMessage(
        [fauxThinking('hidden deterministic thought'), fauxText('Malformed structured output')],
      ), model);
    case 'final_only':
      return withModel(fauxAssistantMessage('Deterministic final answer.'), model);
  }
}

function withModel(message: AssistantMessage, model: Model<string>): AssistantMessage {
  return {
    ...message,
    api: model.api,
    provider: model.provider,
    model: model.id,
  };
}

function firstToolName(context: Context, fallback: string): string {
  return context.tools?.find((tool) => tool.name !== REQUEST_USER_INPUT_TOOL && tool.name !== HANDOFF_TO_WORKFLOW_TOOL)?.name ?? fallback;
}

function preferredToolName(context: Context, preferred: string): string {
  return context.tools?.some((tool) => tool.name === preferred) ? preferred : firstToolName(context, preferred);
}

function toolResultSummary(toolResults: AgentMessage[]): string {
  const text = toolResults
    .flatMap((message) => ('content' in message && Array.isArray(message.content) ? (message.content as unknown[]) : []))
    .flatMap((block) => (isTextContent(block) ? [block.text] : []))
    .join(' ')
    .trim();
  return text.length > 0 ? text.slice(0, 300) : 'Received readonly tool result.';
}

function isTextContent(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object'
    && block !== null
    && 'type' in block
    && block.type === 'text'
    && 'text' in block
    && typeof block.text === 'string'
  );
}
