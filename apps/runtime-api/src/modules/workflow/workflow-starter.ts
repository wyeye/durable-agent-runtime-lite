import { randomUUID } from 'node:crypto';
import { Connection, Client } from '@temporalio/client';
import type { RuntimeConfig } from '@dar/config';
import { loadConfig } from '@dar/config';
import {
  workflowStartRequestSchema,
  workflowStartResponseSchema,
  type WorkflowStartRequest,
  type WorkflowStartResponse,
} from '@dar/contracts';
import { TASK_QUEUES, WORKFLOW_SIGNALS, type HumanTaskDecisionSignalInput } from '@dar/temporal';

export interface WorkflowStarter {
  start(request: WorkflowStartRequest): Promise<WorkflowStartResponse>;
}

export class MockWorkflowStarter implements WorkflowStarter {
  async start(request: WorkflowStartRequest): Promise<WorkflowStartResponse> {
    const parsed = workflowStartRequestSchema.parse(request);
    return workflowStartResponseSchema.parse({
      workflow_id: parsed.workflow_id,
      run_id: `mock_${randomUUID()}`,
      task_run_id: parsed.task_run_id,
      started: true,
      mode: 'mock',
    });
  }
}

export class TemporalWorkflowStarter implements WorkflowStarter {
  private readonly clientPromise: Promise<Client>;

  constructor(config: RuntimeConfig = loadConfig()) {
    this.clientPromise = createTemporalClient(config);
  }

  async start(request: WorkflowStartRequest): Promise<WorkflowStartResponse> {
    const parsed = workflowStartRequestSchema.parse(request);
    const client = await this.clientPromise;
    const workflowName = parsed.workflow_type === 'ConfigDrivenWorkflow'
      ? 'configDrivenWorkflow'
      : 'genericAgentWorkflow';
    const handle = await client.workflow.start(workflowName, {
      taskQueue: TASK_QUEUES.runtimeWorkerMain,
      workflowId: parsed.workflow_id,
      args: [parsed],
    });

    return workflowStartResponseSchema.parse({
      workflow_id: handle.workflowId,
      run_id: handle.firstExecutionRunId,
      task_run_id: parsed.task_run_id,
      started: true,
      mode: 'temporal',
    });
  }
}

export class TemporalHumanTaskSignalSender {
  private readonly clientPromise: Promise<Client>;

  constructor(config: RuntimeConfig = loadConfig()) {
    this.clientPromise = createTemporalClient(config);
  }

  async send(input: HumanTaskDecisionSignalInput): Promise<void> {
    const client = await this.clientPromise;
    const workflowId = input.workflow_id;
    if (!workflowId) {
      throw new Error(`HumanTask ${input.human_task_id} is missing workflow_id`);
    }
    await client.workflow.getHandle(workflowId).signal(WORKFLOW_SIGNALS.humanTaskDecision, input);
  }
}

export function createWorkflowStarter(config: RuntimeConfig = loadConfig()): WorkflowStarter {
  if (config.RUNTIME_API_WORKFLOW_STARTER === 'temporal') {
    return new TemporalWorkflowStarter(config);
  }
  return new MockWorkflowStarter();
}

async function createTemporalClient(config: RuntimeConfig): Promise<Client> {
  const connection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
  return new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
}
