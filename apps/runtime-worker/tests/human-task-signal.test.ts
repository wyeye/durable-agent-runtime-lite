import { Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlowExecutionPlan, HumanTask } from '@dar/contracts';
import { TASK_QUEUES, WORKFLOW_SIGNALS } from '@dar/temporal';

let environment: TestWorkflowEnvironment | undefined;

describe('ConfigDrivenWorkflow human task signals', () => {
  afterEach(async () => {
    await environment?.teardown();
    environment = undefined;
  });

  it('waits beyond five minutes and commits after approve signal', async () => {
    const commits: string[] = [];
    const worker = await createWorker({
      commitToolActivity: async (_context, toolCallId) => {
        commits.push(toolCallId);
        return {
          tool_call_id: toolCallId,
          tool_name: 'record.write.mock',
          tool_version: '1.0.0',
          mode: 'commit',
          status: 'committed',
          result: { written: true },
        };
      },
    });

    await worker.runUntil(async () => {
      const handle = await environment!.client.workflow.start('configDrivenWorkflow', {
        taskQueue: TASK_QUEUES.runtimeWorkerMain,
        workflowId: 'wf_signal_approve',
        args: [workflowInput('wf_signal_approve')],
      });
      await environment!.sleep('6 minutes');
      expect(commits).toEqual([]);
      await handle.signal(WORKFLOW_SIGNALS.humanTaskDecision, decisionSignal('approved', 'wf_signal_approve'));
      await handle.signal(WORKFLOW_SIGNALS.humanTaskDecision, decisionSignal('approved', 'wf_signal_approve'));
      const result = await handle.result();
      expect(result.status).toBe('completed');
      expect(commits).toEqual(['tool_call_l3_1']);
    });
  }, 30_000);

  it('does not commit after reject signal', async () => {
    const commits: string[] = [];
    const worker = await createWorker({
      commitToolActivity: async (_context, toolCallId) => {
        commits.push(toolCallId);
        throw new Error('reject should not commit');
      },
    });

    await worker.runUntil(async () => {
      const handle = await environment!.client.workflow.start('configDrivenWorkflow', {
        taskQueue: TASK_QUEUES.runtimeWorkerMain,
        workflowId: 'wf_signal_reject',
        args: [workflowInput('wf_signal_reject')],
      });
      await handle.signal(WORKFLOW_SIGNALS.humanTaskDecision, decisionSignal('rejected', 'wf_signal_reject'));
      const result = await handle.result();
      expect(result.status).toBe('failed');
      expect(result.error_code).toBe('HUMAN_TASK_REJECTED');
      expect(commits).toEqual([]);
    });
  }, 30_000);
});

async function createWorker(overrides: Record<string, unknown>): Promise<Worker> {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  return Worker.create({
    connection: environment.nativeConnection,
    taskQueue: TASK_QUEUES.runtimeWorkerMain,
    workflowsPath: new URL('../src/workflows/index.ts', import.meta.url).pathname,
    activities: {
      normalizeInput: async (input: unknown) => ({ normalized: true, input }),
      loadExecutionPlanByRefActivity: async () => l3Plan(),
      updateTaskRunStatusActivity: async () => undefined,
      invokeToolActivity: async () => {
        throw new Error('L3 should not invoke directly');
      },
      previewToolActivity: async () => ({
        tool_call_id: 'tool_call_l3_1',
        tool_name: 'record.write.mock',
        tool_version: '1.0.0',
        mode: 'preview',
        status: 'pending_confirmation',
        policy: {
          decision: 'require_human_confirm',
          risk_level: 'L3',
          reason: 'side_effect_requires_human_confirm',
          requires_human_confirm: true,
        },
      }),
      createHumanTaskActivity: async () => humanTask('pending'),
      runAgentActivity: async () => ({ status: 'final', final_answer: 'ok', proposed_tool_calls: [], usage: {} }),
      ...overrides,
    },
  });
}

function workflowInput(workflowId: string) {
  return {
    tenant_id: 'tenant_1',
    user_id: 'user_1',
    task_run_id: 'task_signal_1',
    workflow_id: workflowId,
    workflow_type: 'ConfigDrivenWorkflow',
    flow_id: 'flow_signal',
    flow_version: 1,
    execution_plan_ref: 'db://flow-execution-plan/plan_signal',
    flow_sha256: 'b'.repeat(64),
    request_id: 'req_signal',
    input: { text: 'approve later' },
  };
}

function decisionSignal(status: 'approved' | 'rejected', workflowId: string) {
  return {
    human_task_id: 'human_signal_1',
    tenant_id: 'tenant_1',
    task_run_id: 'task_signal_1',
    workflow_id: workflowId,
    status,
    decision: { status },
    decided_by: 'approver_1',
    decided_at: '2026-01-01T00:00:00.000Z',
    decision_reason: status,
  };
}

function humanTask(status: HumanTask['status']): HumanTask {
  return {
    human_task_id: 'human_signal_1',
    tenant_id: 'tenant_1',
    task_run_id: 'task_signal_1',
    workflow_id: 'wf_signal',
    status,
    candidate_groups: [],
    payload: { tool_call_id: 'tool_call_l3_1' },
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function l3Plan(): FlowExecutionPlan {
  return {
    execution_plan_id: 'plan_signal',
    execution_plan_ref: 'db://flow-execution-plan/plan_signal',
    tenant_id: 'tenant_1',
    flow_id: 'flow_signal',
    flow_version: 1,
    flow_sha256: 'b'.repeat(64),
    flow_spec: {
      flow_id: 'flow_signal',
      version: 1,
      runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: TASK_QUEUES.runtimeWorkerMain },
      steps: [
        { id: 'record_write', type: 'tool', tool: 'record.write.mock', tool_version: '1.0.0', risk_level: 'L3' },
      ],
    },
    agents: [],
    tools: [
      {
        step_id: 'record_write',
        tool_name: 'record.write.mock',
        tool_version: '1.0.0',
        tool_sha256: 'a'.repeat(64),
        risk_level: 'L3',
      },
    ],
    allowed_tools: [],
    budget: { max_steps: 0, max_tokens: 0 },
    generated_at: '2026-01-01T00:00:00.000Z',
    execution_plan_hash: 'c'.repeat(64),
  };
}
