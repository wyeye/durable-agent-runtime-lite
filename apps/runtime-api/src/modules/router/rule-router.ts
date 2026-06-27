import type { CandidateFlow, ModelDefinitionRef, RouteDecision, RouteSpec, TaskInput } from '@dar/contracts';
import { mockRouteDecisionAdapter } from './mock-decision-adapter.js';
import { mockVectorRecallAdapter } from './vector-recall.js';

export interface RuleRouterInput {
  input: TaskInput;
  tenantId?: string | undefined;
  channel?: string | undefined;
  roles?: string[] | undefined;
  allowMockFallback?: boolean | undefined;
}

export interface RuleRouterResult {
  route_decision: RouteDecision;
  candidates: CandidateFlow[];
  decision_stage?: 'action' | 'rule' | 'semantic' | 'clarify' | 'reject';
  semantic?: {
    model_ref?: ModelDefinitionRef;
    top_k?: number;
    top_score?: number;
    margin?: number;
  };
}

export interface SemanticRecallResult {
  candidates: CandidateFlow[];
  model_ref?: ModelDefinitionRef;
  top_k: number;
}

export interface SemanticRecallAdapter {
  recall(input: TaskInput, routes: RouteSpec[], context?: { tenantId?: string }): Promise<SemanticRecallResult>;
}

export interface SemanticRoutingOptions {
  enabled: boolean;
  adapter?: SemanticRecallAdapter;
  matchThreshold: number;
  clarifyThreshold: number;
  minMargin: number;
  topK: number;
}

const defaultSemanticOptions: SemanticRoutingOptions = {
  enabled: false,
  matchThreshold: 0.8,
  clarifyThreshold: 0.65,
  minMargin: 0.05,
  topK: 5,
};

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

function isExecutableRoute(route: RouteSpec): boolean {
  return route.status === undefined || route.status === 'published' || route.status === 'gray';
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

function routeId(route: RouteSpec): string {
  return route.route_id ?? `${route.flow_id}@${route.version}`;
}

function isNegativeExcluded(route: RouteSpec, input: TaskInput): boolean {
  const text = normalizeText(input.text);
  return Boolean(text && containsAny(text, route.route.negative_examples));
}

function scoreRuleRoute(route: RouteSpec, input: TaskInput): number {
  const text = normalizeText(input.text);
  if (!text) {
    return 0;
  }

  const keywordHits = route.route.keywords.filter((keyword) => text.includes(keyword.toLowerCase())).length;
  const exampleHits = route.route.examples.filter((example) => text.includes(example.toLowerCase())).length;
  if (keywordHits === 0 && exampleHits === 0) {
    return 0;
  }

  const keywordScore = Math.min(keywordHits * 0.65, 0.9);
  const exampleScore = Math.min(exampleHits * 0.35, 0.7);
  const priorityBonus = Math.min(route.route.priority / 1000, 0.1);

  return Math.min(keywordScore + exampleScore + priorityBonus, 1);
}

function allowedRoutes(input: RuleRouterInput, routes: RouteSpec[]): RouteSpec[] {
  const roles = input.roles ?? [];
  return routes
    .filter(isExecutableRoute)
    .filter((route) => isChannelAllowed(route, input.channel))
    .filter((route) => isRoleAllowed(route, roles))
    .filter((route) => !isNegativeExcluded(route, input.input));
}

function actionCandidates(input: RuleRouterInput, routes: RouteSpec[]): Array<{ route: RouteSpec; score: number }> {
  if (!input.input.action_id) {
    return [];
  }
  return routes
    .filter((route) => input.input.action_id === route.flow_id || input.input.action_id === routeId(route))
    .map((route) => ({ route, score: 1 }));
}

function ruleCandidates(input: RuleRouterInput, routes: RouteSpec[]): Array<{ route: RouteSpec; score: number }> {
  return routes
    .map((route) => ({ route, score: scoreRuleRoute(route, input.input) }))
    .filter((candidate) => candidate.score > 0)
    .sort(compareRouteScore);
}

function compareRouteScore(
  left: { route: RouteSpec; score: number },
  right: { route: RouteSpec; score: number },
): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (right.route.route.priority !== left.route.route.priority) {
    return right.route.route.priority - left.route.route.priority;
  }
  return routeId(left.route).localeCompare(routeId(right.route));
}

function toCandidateFlows(candidates: Array<{ route: RouteSpec; score: number }>, reason: string): CandidateFlow[] {
  return candidates.map(({ route, score }) => ({
    route_id: routeId(route),
    flow_id: route.flow_id,
    version: route.version,
    score,
    reason,
  }));
}

function fallbackAgentDecision(route: RouteSpec): RouteDecision | undefined {
  const ref = route.route.fallback_agent_ref;
  if (!ref) {
    return undefined;
  }
  const match = /^(.+)@([1-9]\d*)$/u.exec(ref);
  if (!match) {
    return undefined;
  }
  return {
    decision: 'agent_fallback',
    agent_id: match[1] ?? ref,
    agent_version: Number(match[2]),
    reason: `route_fallback:${routeId(route)}`,
  };
}

function selectFallbackRoute(routes: RouteSpec[]): RouteSpec | undefined {
  return routes
    .filter((route) => Boolean(route.route.fallback_agent_ref))
    .sort((left, right) => {
      if (right.route.priority !== left.route.priority) {
        return right.route.priority - left.route.priority;
      }
      return routeId(left).localeCompare(routeId(right));
    })[0];
}

export function routeByRules(input: RuleRouterInput, routes: RouteSpec[]): RuleRouterResult {
  const filtered = allowedRoutes(input, routes);
  const action = actionCandidates(input, filtered).sort(compareRouteScore);
  const actionTop = action[0];
  if (actionTop) {
    return {
      route_decision: {
        decision: 'matched',
        flow_id: actionTop.route.flow_id,
        flow_version: actionTop.route.version,
        confidence: 1,
        slots: {},
      },
      candidates: toCandidateFlows(action, 'action_match'),
      decision_stage: 'action',
    };
  }

  const rules = ruleCandidates(input, filtered);
  const top = rules[0];

  if (!top) {
    const fallback = selectFallbackRoute(filtered);
    const fallbackDecision = fallback ? fallbackAgentDecision(fallback) : undefined;
    if (fallbackDecision) {
      return {
        route_decision: fallbackDecision,
        candidates: [],
        decision_stage: 'reject',
      };
    }
  }

  if (!top && input.allowMockFallback === false) {
    return {
      route_decision: {
        decision: 'reject',
        reason: 'no_published_route_match',
      },
      candidates: [],
      decision_stage: 'reject',
    };
  }

  if (!top) {
    const recalledCandidates = mockVectorRecallAdapter.recall(input.input, routes);
    return {
      route_decision: mockRouteDecisionAdapter.decide(input.input),
      candidates: recalledCandidates,
    };
  }

  const candidateFlows = toCandidateFlows(rules, 'rule_match');
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
      decision_stage: 'rule',
    };
  }

  return {
    route_decision: {
      decision: 'need_clarify',
      question: '请确认要执行的流程。',
      candidates: candidateFlows,
    },
    candidates: candidateFlows,
    decision_stage: 'clarify',
  };
}

export async function routeWithSemanticRecall(
  input: RuleRouterInput,
  routes: RouteSpec[],
  semanticOptions: Partial<SemanticRoutingOptions> = {},
): Promise<RuleRouterResult> {
  const semantic = { ...defaultSemanticOptions, ...semanticOptions };
  const filtered = allowedRoutes(input, routes);
  const action = actionCandidates(input, filtered).sort(compareRouteScore);
  const actionTop = action[0];
  if (actionTop) {
    return {
      route_decision: {
        decision: 'matched',
        flow_id: actionTop.route.flow_id,
        flow_version: actionTop.route.version,
        confidence: 1,
        slots: {},
      },
      candidates: toCandidateFlows(action, 'action_match'),
      decision_stage: 'action',
    };
  }

  const rules = ruleCandidates(input, filtered);
  const topRule = rules[0];
  const ruleFlows = toCandidateFlows(rules, 'rule_match');
  if (topRule && topRule.score >= topRule.route.route.confidence_threshold) {
    return {
      route_decision: {
        decision: 'matched',
        flow_id: topRule.route.flow_id,
        flow_version: topRule.route.version,
        confidence: topRule.score,
        slots: {},
      },
      candidates: ruleFlows,
      decision_stage: 'rule',
    };
  }

  if (semantic.enabled && semantic.adapter && filtered.length > 0) {
    const recall = await semantic.adapter.recall(input.input, filtered, input.tenantId ? { tenantId: input.tenantId } : {});
    const semanticDecision = decideSemantic(recall, semantic);
    if (semanticDecision.route_decision.decision !== 'reject') {
      return semanticDecision;
    }
    const fallback = selectFallbackRoute(filtered);
    const fallbackDecision = fallback ? fallbackAgentDecision(fallback) : undefined;
    if (fallbackDecision) {
      return {
        route_decision: fallbackDecision,
        candidates: semanticDecision.candidates,
        decision_stage: 'reject',
        ...(semanticDecision.semantic ? { semantic: semanticDecision.semantic } : {}),
      };
    }
    return semanticDecision;
  }

  if (topRule) {
    return {
      route_decision: {
        decision: 'need_clarify',
        question: '请确认要执行的流程。',
        candidates: ruleFlows,
      },
      candidates: ruleFlows,
      decision_stage: 'clarify',
    };
  }

  const fallback = selectFallbackRoute(filtered);
  const fallbackDecision = fallback ? fallbackAgentDecision(fallback) : undefined;
  if (fallbackDecision) {
    return {
      route_decision: fallbackDecision,
      candidates: [],
      decision_stage: 'reject',
    };
  }

  if (input.allowMockFallback === false) {
    return {
      route_decision: {
        decision: 'reject',
        reason: 'no_published_route_match',
      },
      candidates: [],
      decision_stage: 'reject',
    };
  }

  const recalledCandidates = mockVectorRecallAdapter.recall(input.input, routes);
  return {
    route_decision: mockRouteDecisionAdapter.decide(input.input),
    candidates: recalledCandidates,
  };
}

function decideSemantic(recall: SemanticRecallResult, options: SemanticRoutingOptions): RuleRouterResult {
  const candidates = recall.candidates
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return (left.route_id ?? left.flow_id).localeCompare(right.route_id ?? right.flow_id);
    });
  const top = candidates[0];
  const second = candidates[1];
  const topScore = top?.score ?? 0;
  const margin = top ? Math.max(0, top.score - (second?.score ?? 0)) : 0;
  const semantic = {
    ...(recall.model_ref ? { model_ref: recall.model_ref } : {}),
    top_k: recall.top_k,
    top_score: topScore,
    margin,
  };

  if (!top || topScore < options.clarifyThreshold) {
    return {
      route_decision: {
        decision: 'reject',
        reason: 'semantic_recall_below_threshold',
      },
      candidates,
      decision_stage: 'reject',
      semantic,
    };
  }

  if (topScore >= options.matchThreshold && margin >= options.minMargin) {
    return {
      route_decision: {
        decision: 'matched',
        flow_id: top.flow_id,
        flow_version: top.version,
        confidence: top.score,
        slots: {},
      },
      candidates,
      decision_stage: 'semantic',
      semantic,
    };
  }

  return {
    route_decision: {
      decision: 'need_clarify',
      question: '我找到了几个可能的流程，请确认你要执行哪一个。',
      candidates: candidates.slice(0, 3),
    },
    candidates,
    decision_stage: 'clarify',
    semantic,
  };
}
