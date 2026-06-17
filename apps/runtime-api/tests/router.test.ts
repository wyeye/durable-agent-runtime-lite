import { describe, expect, it } from 'vitest';
import type { RouteSpec } from '@dar/contracts';
import { buildServer } from '../src/index.js';
import { routeByRules } from '../src/modules/router/rule-router.js';
import { defaultRouteSpecs } from '../src/modules/router/route-registry.js';
import type { RouteSpecSource } from '../src/modules/router/route-source.js';
import { createRuntimeApiTaskService, TaskService } from '../src/modules/task/task-service.js';

class StaticRouteSource implements RouteSpecSource {
  constructor(private readonly routes: RouteSpec[]) {}

  async listPublished(): Promise<RouteSpec[]> {
    return this.routes;
  }
}

const dbOnlyRoute: RouteSpec = {
  route_id: 'db_only_route',
  flow_id: 'db_route_flow',
  version: 3,
  status: 'published',
  route: {
    priority: 100,
    keywords: ['db-only'],
    examples: [],
    negative_examples: [],
    supported_channels: [],
    role_constraints: [],
    confidence_threshold: 0.5,
    ambiguous_threshold: 0.3,
  },
};

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

  it('uses DB RouteSpec source for preview and task creation without default route fallback', async () => {
    const server = buildServer(
      new TaskService({
        routeSource: new StaticRouteSource([dbOnlyRoute]),
        allowMockRouteFallback: false,
      }),
    );

    const preview = await server.inject({
      method: 'POST',
      url: '/v1/router/preview',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_db_preview',
        input: { text: 'please run db-only path' },
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.route_decision).toMatchObject({
      decision: 'matched',
      flow_id: 'db_route_flow',
      flow_version: 3,
    });

    const task = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_db_task',
        input: { text: 'please run db-only path' },
      },
    });
    expect(task.statusCode).toBe(200);
    expect(task.json().data).toMatchObject({
      flow_id: 'db_route_flow',
      flow_version: 3,
      route_decision: { decision: 'matched', flow_id: 'db_route_flow', flow_version: 3 },
    });
    expect(task.json().data.workflow_start).toMatchObject({
      mode: 'mock',
    });

    const defaultPreview = await server.inject({
      method: 'POST',
      url: '/v1/router/preview',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_no_sample',
        input: { text: '请执行 mvp 示例流程' },
      },
    });
    expect(defaultPreview.json().data.route_decision).toMatchObject({
      decision: 'agent_fallback',
    });
    expect(defaultPreview.json().data.route_decision.flow_id).not.toBe('sample_flow');

    await server.close();
  });

  it('does not fall back to sample route when DB RouteSpec source is empty', async () => {
    const server = buildServer(
      new TaskService({
        routeSource: new StaticRouteSource([]),
        allowMockRouteFallback: false,
      }),
    );

    const preview = await server.inject({
      method: 'POST',
      url: '/v1/router/preview',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        input: { text: '请执行 mvp 示例流程' },
      },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.route_decision).toMatchObject({
      decision: 'agent_fallback',
      reason: 'no_published_route_match',
    });

    await server.close();
  });

  it('uses local sample refs only for memory development source', async () => {
    const workflowStarts: unknown[] = [];
    const server = buildServer(
      new TaskService({
        workflowStarter: {
          async start(request) {
            workflowStarts.push(request);
            return {
              workflow_id: request.workflow_id,
              task_run_id: request.task_run_id,
              started: true,
              mode: 'mock',
            };
          },
        },
      }),
    );

    const task = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        request_id: 'req_memory_task',
        input: { text: '请执行 mvp 示例流程' },
      },
    });

    expect(task.statusCode).toBe(200);
    expect(workflowStarts).toHaveLength(1);
    expect(workflowStarts[0]).toMatchObject({
      flow_snapshot_ref: 'sample_flow@1',
    });

    await server.close();
  });

  it('requires DB RouteSpec source in production', () => {
    expect(() =>
      createRuntimeApiTaskService({
        NODE_ENV: 'production',
        APP_ENV: 'production',
        APP_VERSION: '0.1.5',
        HOST: '0.0.0.0',
        DATABASE_URL: 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime',
        VALKEY_URL: 'redis://localhost:16380',
        TEMPORAL_ADDRESS: 'localhost:7233',
        TEMPORAL_NAMESPACE: 'default',
        MODEL_GATEWAY_BASE_URL: 'http://localhost:4100',
        MODEL_GATEWAY_API_KEY: 'dev-only-placeholder',
        JWT_ISSUER: 'http://localhost:3000',
        JWT_AUDIENCE: 'durable-agent-runtime-lite',
        LOG_LEVEL: 'info',
        CONTROL_PLANE_PORT: 3000,
        RUNTIME_API_PORT: 3001,
        RUNTIME_WORKER_PORT: 3002,
        TOOL_GATEWAY_PORT: 3003,
        RUNTIME_WORKER_MODE: 'mock',
        RUNTIME_API_WORKFLOW_STARTER: 'mock',
        RUNTIME_API_ROUTE_SOURCE: 'memory',
        TOOL_GATEWAY_REGISTRY_SOURCE: 'db',
      }),
    ).toThrow('RUNTIME_API_ROUTE_SOURCE=db is required in production');
  });
});
