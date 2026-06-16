import type { AgentRunResult, FlowSpec, ToolInvokeResponse } from '@dar/contracts';
import type { ActivityContext, HumanTaskPlaceholder } from '../activities/index.js';
import { evaluateCondition } from './condition-evaluator.js';

export interface FlowExecutionActivities {
  normalizeInput(input: unknown): Promise<Record<string, unknown>>;
  invokeTool(context: ActivityContext, toolName: string, args: Record<string, unknown>): Promise<ToolInvokeResponse>;
  runAgent(
    context: ActivityContext,
    agentId: string,
    input: Record<string, unknown>,
    allowedTools?: string[],
  ): Promise<AgentRunResult>;
  createHumanTask(context: ActivityContext): Promise<HumanTaskPlaceholder>;
}

export interface FlowExecutionResult {
  status: 'completed' | 'waiting_human' | 'failed';
  steps: Record<string, unknown>;
}

export async function executeFlowSpec(
  flowSpec: FlowSpec,
  context: ActivityContext,
  input: unknown,
  activities: FlowExecutionActivities,
): Promise<FlowExecutionResult> {
  const state: Record<string, unknown> = { input };

  for (const step of flowSpec.steps) {
    if (!evaluateCondition(step.when, state)) {
      continue;
    }

    if (step.type === 'activity') {
      state[step.id] = await activities.normalizeInput(input);
      continue;
    }

    if (step.type === 'tool') {
      if (!step.tool) {
        throw new Error(`tool step ${step.id} missing tool`);
      }
      state[step.id] = await activities.invokeTool(context, step.tool, { query: 'mock query', record: state });
      continue;
    }

    if (step.type === 'agent') {
      state[step.id] = await activities.runAgent(context, step.agent_id ?? 'sample-agent', state);
      continue;
    }

    if (step.type === 'human_task') {
      state[step.id] = await activities.createHumanTask(context);
      continue;
    }

    if (step.type === 'condition') {
      state[step.id] = { passed: evaluateCondition(step.when, state) };
    }
  }

  return { status: 'completed', steps: state };
}
