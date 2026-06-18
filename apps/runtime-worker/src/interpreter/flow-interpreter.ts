import type {
  AgentRunResult,
  FlowExecutionPlan,
  FlowExecutionPlanAgent,
  FlowExecutionPlanTool,
  FlowSpec,
  HumanTask,
  ToolCommitResponse,
  ToolInvokeResponse,
  ToolPreviewResponse,
} from '@dar/contracts';
import type { ActivityContext, CreateHumanTaskActivityInput } from '../activities/index.js';
import { evaluateCondition } from './condition-evaluator.js';

export interface FlowExecutionActivities {
  normalizeInput(input: unknown): Promise<Record<string, unknown>>;
  invokeTool(context: ActivityContext, tool: FlowExecutionPlanTool, args: Record<string, unknown>): Promise<ToolInvokeResponse>;
  previewTool(context: ActivityContext, tool: FlowExecutionPlanTool, args: Record<string, unknown>): Promise<ToolPreviewResponse>;
  commitTool(
    context: ActivityContext,
    toolCallId: string,
    tool: FlowExecutionPlanTool,
    args: Record<string, unknown>,
  ): Promise<ToolCommitResponse>;
  runAgent(
    context: ActivityContext,
    agent: FlowExecutionPlanAgent,
    input: Record<string, unknown>,
  ): Promise<AgentRunResult>;
  createHumanTask(context: ActivityContext, input?: CreateHumanTaskActivityInput): Promise<HumanTask>;
  waitForHumanTaskDecision(context: ActivityContext, humanTaskId: string): Promise<HumanTask>;
}

export interface FlowExecutionResult {
  status: 'completed' | 'waiting_human' | 'failed';
  steps: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
}

export async function executeFlowSpec(
  flowSpecOrPlan: FlowSpec | FlowExecutionPlan,
  context: ActivityContext,
  input: unknown,
  activities: FlowExecutionActivities,
): Promise<FlowExecutionResult> {
  const flowSpec = isExecutionPlan(flowSpecOrPlan) ? flowSpecOrPlan.flow_spec : flowSpecOrPlan;
  const plan = isExecutionPlan(flowSpecOrPlan) ? flowSpecOrPlan : undefined;
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
      const plannedTool = resolvePlannedTool(plan, step.id, step.tool);
      const args = resolveToolArguments(step.input, state, input);
      if (plannedTool.risk_level === 'L3') {
        const preview = await activities.previewTool(context, plannedTool, args);
        if (preview.status === 'denied') {
          setStepResult(state, step.id, {
            status: 'failed',
            preview,
          });
          return {
            status: 'failed',
            steps: state,
            error_code: preview.error?.code ?? 'TOOL_PREVIEW_DENIED',
            error_message: preview.error?.message ?? `Tool preview denied: ${step.tool}`,
          };
        }

        const humanTask = await activities.createHumanTask(context, {
          tool_call_id: preview.tool_call_id,
          tool_name: plannedTool.tool_name,
          payload: {
            step_id: step.id,
            tool_call_id: preview.tool_call_id,
            tool_name: plannedTool.tool_name,
            tool_version: plannedTool.tool_version,
            tool_sha256: plannedTool.tool_sha256,
            preview,
            arguments: args,
          },
        });
        setStepResult(state, step.id, {
          status: 'pending_confirmation',
          preview,
          human_task: humanTask,
        });

        const decision = await activities.waitForHumanTaskDecision(context, humanTask.human_task_id);
        if (decision.status === 'approved') {
          const commit = await activities.commitTool(context, preview.tool_call_id, plannedTool, args);
          setStepResult(state, step.id, {
            status: commit.status === 'committed' || commit.status === 'replayed' ? 'committed' : 'failed',
            preview,
            human_task: decision,
            commit,
          });
          if (commit.status !== 'committed' && commit.status !== 'replayed') {
            return {
              status: 'failed',
              steps: state,
              error_code: commit.error?.code ?? 'TOOL_COMMIT_FAILED',
              error_message: commit.error?.message ?? `Tool commit failed: ${plannedTool.tool_name}`,
            };
          }
          continue;
        }

        setStepResult(state, step.id, {
          status: decision.status === 'pending' ? 'pending_confirmation' : 'rejected',
          preview,
          human_task: decision,
        });
        return {
          status: decision.status === 'pending' ? 'waiting_human' : 'failed',
          steps: state,
          ...(decision.status !== 'pending'
            ? {
                error_code: 'HUMAN_TASK_REJECTED',
                error_message: `Human task ${decision.status}: ${decision.human_task_id}`,
              }
            : {}),
        };
      }

      const response = await activities.invokeTool(context, plannedTool, args);
      setStepResult(
        state,
        step.id,
        response,
      );
      if (response.status === 'denied' || response.status === 'failed' || response.status === 'needs_confirmation') {
        return {
          status: 'failed',
          steps: state,
          error_code: response.error?.code ?? 'TOOL_INVOKE_FAILED',
          error_message: response.error?.message ?? `Tool invoke failed: ${plannedTool.tool_name}`,
        };
      }
      continue;
    }

    if (step.type === 'agent') {
      const plannedAgent = resolvePlannedAgent(plan, step.id, step.agent_id);
      setStepResult(
        state,
        step.id,
        await activities.runAgent(context, plannedAgent, resolveStepInput(step.input, state, input)),
      );
      continue;
    }

    if (step.type === 'human_task') {
      const humanTask = await activities.createHumanTask(context, {
        payload: {
          step_id: step.id,
          input: resolveStepInput(step.input, state, input),
        },
      });
      setStepResult(state, step.id, await activities.waitForHumanTaskDecision(context, humanTask.human_task_id));
      continue;
    }

    if (step.type === 'condition') {
      setStepResult(state, step.id, { passed: evaluateCondition(step.when, state) });
    }
  }

  return { status: 'completed', steps: state };
}

function isExecutionPlan(value: FlowSpec | FlowExecutionPlan): value is FlowExecutionPlan {
  return 'execution_plan_ref' in value && 'flow_spec' in value;
}

function resolvePlannedTool(plan: FlowExecutionPlan | undefined, stepId: string, toolName: string): FlowExecutionPlanTool {
  const tool = plan?.tools.find((candidate) => candidate.step_id === stepId)
    ?? plan?.tools.find((candidate) => candidate.tool_name === toolName);
  if (!tool) {
    throw new Error(`FlowExecutionPlan missing tool entry for step ${stepId}: ${toolName}`);
  }
  return tool;
}

function resolvePlannedAgent(
  plan: FlowExecutionPlan | undefined,
  stepId: string,
  agentId: string | undefined,
): FlowExecutionPlanAgent {
  const agent = plan?.agents.find((candidate) => candidate.step_id === stepId)
    ?? plan?.agents.find((candidate) => candidate.agent_id === agentId);
  if (!agent) {
    throw new Error(`FlowExecutionPlan missing agent entry for step ${stepId}: ${agentId ?? 'unknown'}`);
  }
  return agent;
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
