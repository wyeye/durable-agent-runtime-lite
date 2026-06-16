import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { routeByRules } from '../src/modules/router/rule-router.js';
import { defaultRouteSpecs } from '../src/modules/router/route-registry.js';

describe('runtime-api router and task endpoints', () => {
  it('matches by keyword and priority', () => {
    const result = routeByRules({ input: { text: '请执行 mvp 示例流程', payload: {} }, channel: 'web' }, defaultRouteSpecs);
    expect(result.route_decision.decision).toBe('matched');
    if (result.route_decision.decision === 'matched') {
      expect(result.route_decision.flow_id).toBe('sample_flow');
    }
  });

  it('creates and queries a mock-started task run', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_1',
        input: { text: '请执行 mvp 示例流程' },
      },
    });
    expect(response.statusCode).toBe(200);
    const created = response.json();
    expect(created.data.status).toBe('queued');
    expect(created.data.workflow_start.mode).toBe('mock');

    const queried = await server.inject({ method: 'GET', url: `/v1/tasks/${created.data.task_run_id}` });
    expect(queried.statusCode).toBe(200);
    expect(queried.json().data.task_run_id).toBe(created.data.task_run_id);
    await server.close();
  });
});
