import { describe, expect, it, vi } from 'vitest';
import type { FlowSpec } from '@dar/contracts';

const dbFlow: FlowSpec = {
  flow_id: 'db_route_flow',
  version: 2,
  status: 'published',
  runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
  steps: [
    { id: 'retrieve_context', type: 'tool', tool: 'knowledge.search', input: { query: '${input.query}' } },
  ],
};

vi.mock('@dar/config', () => ({
  getToolGatewayUrl: () => 'http://localhost:3003',
  loadConfig: () => ({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    TOOL_GATEWAY_BASE_URL: 'http://localhost:3003',
  }),
}));

vi.mock('@dar/db', async (importActual) => {
  const actual = await importActual<typeof import('@dar/db')>();
  return {
    ...actual,
    createDb: vi.fn(() => ({ fake: true })),
    closeDb: vi.fn(async () => undefined),
    FlowDefinitionRepository: class {
      async getPublished(flowId: string, version: number) {
        return flowId === 'db_route_flow' && version === 2 ? dbFlow : undefined;
      }
    },
  };
});

describe('loadFlowSpecByRefActivity DB refs', () => {
  it('loads a DB FlowSpec by immutable db:// flow version ref', async () => {
    const { loadFlowSpecByRefActivity } = await import('../src/activities/index.js');
    const loaded = await loadFlowSpecByRefActivity('db://flow/db_route_flow/versions/2');

    expect(loaded).toMatchObject({
      flow_id: 'db_route_flow',
      version: 2,
      status: 'published',
    });
  });

  it('fails honestly when DB ref version is missing', async () => {
    const { loadFlowSpecByRefActivity } = await import('../src/activities/index.js');
    await expect(loadFlowSpecByRefActivity('db://flow/missing_flow/versions/9')).rejects.toThrow(
      'FlowSpec not found or not executable',
    );
  });
});
