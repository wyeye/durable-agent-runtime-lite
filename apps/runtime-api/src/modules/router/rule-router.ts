import type { CandidateFlow, RouteDecision, RouteSpec, TaskInput } from '@dar/contracts';
import { DEFAULT_AGENT_ID } from './route-registry.js';
import { mockRouteDecisionAdapter } from './mock-decision-adapter.js';
import { mockVectorRecallAdapter } from './vector-recall.js';

export interface RuleRouterInput {
  input: TaskInput;
  channel?: string | undefined;
  roles?: string[] | undefined;
}

export interface RuleRouterResult {
  route_decision: RouteDecision;
  candidates: CandidateFlow[];
}

function normalizeText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function hasRoleIntersection(requiredRoles: string[], actualRoles: string[]): boolean {
  if (requiredRoles.length === 0) {
    return true;
  }

  const actual = new Set(actualRoles);
  return requiredRoles.some((role) => actual.has(role));
}

function isChannelAllowed(route: RouteSpec, channel: string | undefined): boolean {
  const channels = route.route.supported_channels;
  return channels.length === 0 || !channel || channels.includes(channel);
}

function isRoleAllowed(route: RouteSpec, roles: string[]): boolean {
  return hasRoleIntersection(route.route.role_constraints, roles);
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function scoreRoute(route: RouteSpec, input: TaskInput): number {
  if (input.action_id && input.action_id === route.flow_id) {
    return 1;
  }

  const text = normalizeText(input.text);
  if (!text) {
    return 0;
  }

  if (containsAny(text, route.route.negative_examples)) {
    return 0;
  }

  const keywordHits = route.route.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
  const exampleHits = route.route.examples.filter((example) => text.includes(example.toLowerCase())).length;

  const keywordScore = Math.min(keywordHits * 0.65, 0.9);
  const exampleScore = Math.min(exampleHits * 0.35, 0.7);
  const priorityBonus = Math.min(route.route.priority / 1000, 0.1);

  return Math.min(keywordScore + exampleScore + priorityBonus, 1);
}

export function routeByRules(input: RuleRouterInput, routes: RouteSpec[]): RuleRouterResult {
  const roles = input.roles ?? [];
  const candidates = routes
    .filter((route) => route.status !== 'disabled')
    .filter((route) => isChannelAllowed(route, input.channel))
    .filter((route) => isRoleAllowed(route, roles))
    .map((route) => ({
      route,
      score: scoreRoute(route, input.input),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.route.route.priority - left.route.route.priority;
    });

  const candidateFlows: CandidateFlow[] = candidates.map(({ route, score }) => ({
    flow_id: route.flow_id,
    version: route.version,
    score,
    reason: 'rule_match',
  }));

  const top = candidates[0];

  if (!top) {
    const recalledCandidates = mockVectorRecallAdapter.recall(input.input, routes);
    return {
      route_decision: mockRouteDecisionAdapter.decide(input.input),
      candidates: recalledCandidates,
    };
  }

  if (top.score >= top.route.route.confidence_threshold) {
    return {
      route_decision: {
        decision: 'matched',
        flow_id: top.route.flow_id,
        flow_version: top.route.version,
        confidence: top.score,
        slots: {},
      },
      candidates: candidateFlows,
    };
  }

  if (top.score >= top.route.route.ambiguous_threshold) {
    return {
      route_decision: {
        decision: 'need_clarify',
        question: '请确认要执行的流程。',
        candidates: candidateFlows,
      },
      candidates: candidateFlows,
    };
  }

  return {
    route_decision: {
      decision: 'agent_fallback',
      agent_id: DEFAULT_AGENT_ID,
      reason: 'low_confidence_rule_match',
    },
    candidates: candidateFlows,
  };
}
