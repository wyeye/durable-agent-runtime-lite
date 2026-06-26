import { describe, expect, it } from 'vitest';

describe('export temporal replay fixtures smoke result compatibility', () => {
  it('parses chat smoke runs into task and agent workflow fixture requests', async () => {
    const module = await import('../src/scripts/export-temporal-replay-fixtures.ts');
    const parseSmokeResult = (module as { parseSmokeResult?: (value: string) => unknown }).parseSmokeResult;

    expect(typeof parseSmokeResult).toBe('function');

    const requests = parseSmokeResult?.(JSON.stringify({
      ok: true,
      scenario: 'chat-mvp',
      runs: [
        {
          name: 'chat-turn-1',
          workflow_id: 'task-workflow-1',
          workflow_run_id: 'task-run-1',
          agent_workflow_id: 'agent-workflow-1',
          agent_workflow_run_id: 'agent-run-1',
        },
        {
          name: 'chat-turn-2',
          workflow_id: 'task-workflow-2',
          workflow_run_id: 'task-run-2',
        },
      ],
    })) as Array<{ name: string; workflowId: string; runId?: string }>;

    expect(requests).toEqual([
      { name: 'chat-chat-turn-1-task', workflowId: 'task-workflow-1', runId: 'task-run-1' },
      { name: 'chat-chat-turn-1-agent', workflowId: 'agent-workflow-1', runId: 'agent-run-1' },
      { name: 'chat-chat-turn-2-task', workflowId: 'task-workflow-2', runId: 'task-run-2' },
    ]);
  });
});
