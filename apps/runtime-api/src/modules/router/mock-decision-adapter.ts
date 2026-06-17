import type { RouteDecision, TaskInput } from '@dar/contracts';
import { DEFAULT_AGENT_ID } from './route-registry.js';

export interface RouteDecisionAdapter {
  decide(input: TaskInput): RouteDecision;
}

export class MockRouteDecisionAdapter implements RouteDecisionAdapter {
  decide(input: TaskInput): RouteDecision {
    if (input.action_id) {
      return {
        decision: 'agent_fallback',
        agent_id: DEFAULT_AGENT_ID,
        reason: 'mock_llm_unknown_action_id',
      };
    }

    return {
      decision: 'agent_fallback',
      agent_id: DEFAULT_AGENT_ID,
      reason: 'mock_llm_no_match',
    };
  }
}

export const mockRouteDecisionAdapter = new MockRouteDecisionAdapter();
