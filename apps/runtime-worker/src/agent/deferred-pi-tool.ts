import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentToolPlanEntry, ProposedToolCall } from '@dar/contracts';
import { proposedToolCallSchema } from '@dar/contracts';

export const REQUEST_USER_INPUT_TOOL = 'request_user_input';
export const HANDOFF_TO_WORKFLOW_TOOL = 'handoff_to_workflow';

export interface DeferredToolDetails extends ProposedToolCall {
  kind: 'deferred_tool_proposal';
}

export function buildDeferredPiTools(
  allowedTools: AgentToolPlanEntry[],
  allowedHandoffs: string[],
): AgentTool[] {
  const tools = allowedTools.map((tool) => buildBusinessDeferredTool(tool));
  tools.push(buildRequestUserInputTool());
  tools.push(buildHandoffTool(allowedHandoffs));
  return tools;
}

function buildBusinessDeferredTool(tool: AgentToolPlanEntry): AgentTool {
  return {
    name: tool.tool_name,
    label: tool.tool_name,
    description: tool.description ?? `Deferred Tool Gateway proposal for ${tool.tool_name}`,
    parameters: normalizeJsonSchema(tool.input_schema),
    executionMode: 'sequential',
    execute: async (toolCallId, params) => {
      const proposal = proposedToolCallSchema.parse({
        call_id: toolCallId,
        tool_name: tool.tool_name,
        tool_version: tool.tool_version,
        tool_sha256: tool.tool_sha256,
        arguments: toJsonObject(params),
        reason_summary: `Pi proposed ${tool.tool_name}`,
        risk_level: tool.risk_level,
        requires_confirmation: tool.risk_level === 'L3',
        source_order: 0,
      });
      return deferredResult(proposal);
    },
  };
}

function buildRequestUserInputTool(): AgentTool {
  return {
    name: REQUEST_USER_INPUT_TOOL,
    label: 'Request user input',
    description: 'Request durable user input through a Human Task boundary.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1 },
        requested_schema: { type: 'object', additionalProperties: true },
        reason_summary: { type: 'string', maxLength: 2000 },
      },
    },
    executionMode: 'sequential',
    execute: async (toolCallId, params) => {
      const args = toJsonObject(params);
      const proposal = proposedToolCallSchema.parse({
        call_id: toolCallId,
        tool_name: REQUEST_USER_INPUT_TOOL,
        tool_version: '1',
        tool_sha256: '0'.repeat(64),
        arguments: args,
        reason_summary: typeof args.reason_summary === 'string' ? args.reason_summary : 'Pi requested user input',
        risk_level: 'L0',
        requires_confirmation: false,
        source_order: 0,
      });
      return deferredResult(proposal);
    },
  };
}

function buildHandoffTool(allowedHandoffs: string[]): AgentTool {
  return {
    name: HANDOFF_TO_WORKFLOW_TOOL,
    label: 'Handoff to workflow',
    description: 'Request a durable handoff to an allowed workflow execution plan.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['target_execution_plan_ref'],
      properties: {
        target_execution_plan_ref: { type: 'string', minLength: 1 },
        arguments: { type: 'object', additionalProperties: true },
        reason_summary: { type: 'string', maxLength: 2000 },
      },
    },
    executionMode: 'sequential',
    execute: async (toolCallId, params) => {
      const args = toJsonObject(params);
      const target = typeof args.target_execution_plan_ref === 'string' ? args.target_execution_plan_ref : '';
      if (target && !allowedHandoffs.includes(target)) {
        throw new Error(`Workflow handoff target is not allowed: ${target}`);
      }
      const proposal = proposedToolCallSchema.parse({
        call_id: toolCallId,
        tool_name: HANDOFF_TO_WORKFLOW_TOOL,
        tool_version: '1',
        tool_sha256: '0'.repeat(64),
        arguments: args,
        reason_summary: typeof args.reason_summary === 'string' ? args.reason_summary : 'Pi requested workflow handoff',
        risk_level: 'L0',
        requires_confirmation: false,
        source_order: 0,
      });
      return deferredResult(proposal);
    },
  };
}

function deferredResult(proposal: ProposedToolCall): AgentToolResult<DeferredToolDetails> {
  return {
    content: [{
      type: 'text',
      text: `Deferred tool proposal captured for ${proposal.tool_name}. Temporal supervisor will decide execution.`,
    }],
    details: {
      kind: 'deferred_tool_proposal',
      ...proposal,
    },
    terminate: true,
  };
}

function normalizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === 'object') {
    return schema;
  }
  return {
    type: 'object',
    additionalProperties: true,
    properties: {},
  };
}

function toJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
