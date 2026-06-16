import type { RouteSpec } from '@dar/contracts';

export const DEFAULT_AGENT_ID = 'generic_agent';

export const defaultRouteSpecs: RouteSpec[] = [
  {
    route_id: 'customer_followup_route',
    flow_id: 'customer_followup_flow',
    version: 1,
    status: 'published',
    route: {
      priority: 80,
      keywords: ['客户跟进', '拜访建议', '跟进话术'],
      examples: ['帮我看看这个客户怎么跟进', '生成一份客户拜访建议'],
      negative_examples: ['查询本月经营指标'],
      supported_channels: [],
      role_constraints: [],
      confidence_threshold: 0.72,
      ambiguous_threshold: 0.55,
    },
  },
];
