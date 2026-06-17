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
  const state: Record<string, unknown> = { input, steps: {} };

  for (const step of flowSpec.steps) {
    if (!evaluateCondition(step.when, state)) {
      continue;
    }

    if (step.type === 'activity') {
      setStepResult(state, step.id, await activities.normalizeInput(resolveStepInput(step.input, state, input)));
      continue;
    }

    if (step.type === 'tool') {
      if (!step.tool) {
        throw new Error(`tool step ${step.id} missing tool`);
      }
      setStepResult(
        state,
        step.id,
        await activities.invokeTool(context, step.tool, resolveToolArguments(step.input, state, input)),
      );
      continue;
    }

    if (step.type === 'agent') {
      setStepResult(
        state,
        step.id,
        await activities.runAgent(context, step.agent_id ?? 'sample-agent', resolveStepInput(step.input, state, input)),
      );
      continue;
    }

    if (step.type === 'human_task') {
      setStepResult(state, step.id, await activities.createHumanTask(context));
      continue;
    }

    if (step.type === 'condition') {
      setStepResult(state, step.id, { passed: evaluateCondition(step.when, state) });
    }
  }

  return { status: 'completed', steps: state };
}

export function resolveToolArguments(
  mapping: Record<string, unknown> | undefined,
  state: Record<string, unknown>,
  input: unknown,
): Record<string, unknown> {
  const resolved = resolveStepInput(mapping, state, input);
  return isRecord(resolved) ? resolved : { value: resolved };
}

export function resolveStepInput(
  mapping: Record<string, unknown> | undefined,
  state: Record<string, unknown>,
  input: unknown,
): Record<string, unknown> {
  if (!mapping) {
    return state;
  }

  const scope = { input, state };
  return resolveValue(mapping, scope) as Record<string, unknown>;
}

function resolveValue(value: unknown, scope: { input: unknown; state: Record<string, unknown> }): unknown {
  if (typeof value === 'string') {
    const expression = /^\$\{(.+)\}$/u.exec(value);
    return expression ? resolvePath(expression[1] ?? '', scope) : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, scope));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, resolveValue(entryValue, scope)]),
    );
  }

  return value;
}

function resolvePath(path: string, scope: { input: unknown; state: Record<string, unknown> }): unknown {
  if (path === 'input') {
    return scope.input;
  }
  if (path === 'state') {
    return scope.state;
  }

  const [root, ...segments] = path.split('.');
  let current: unknown;
  if (root === 'input') {
    current = scope.input;
  } else if (root === 'state') {
    current = scope.state;
  } else {
    throw new Error(`Unsupported input expression root: ${root}`);
  }

  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function setStepResult(state: Record<string, unknown>, stepId: string, result: unknown): void {
  state[stepId] = result;
  const steps = isRecord(state.steps) ? state.steps : {};
  steps[stepId] = { result };
  state.steps = steps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
