import {
  auditEventSchema,
  humanTaskDecisionRequestSchema,
  humanTaskDecisionResponseSchema,
  humanTaskGetRequestSchema,
  humanTaskGetResponseSchema,
  humanTaskListRequestSchema,
  humanTaskListResponseSchema,
  humanTaskSchema,
  type AuditEvent,
  type HumanTask,
  type HumanTaskDecisionResponse,
  type HumanTaskGetResponse,
  type HumanTaskListResponse,
  type ToolCallLog,
} from '@dar/contracts';
import type { HumanTaskDecisionInput, ListHumanTasksOptions, ToolCallLogUpdateInput } from '@dar/db';
import type { HumanTaskDecisionSignalInput } from '@dar/temporal';

export interface HumanTaskStore {
  get(humanTaskId: string): Promise<HumanTask | undefined>;
  list(options?: ListHumanTasksOptions): Promise<HumanTask[]>;
  approve(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined>;
  reject(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined>;
}

export interface HumanTaskAuditStore {
  append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): Promise<AuditEvent>;
}

export interface HumanTaskToolCallLogStore {
  update(toolCallId: string, input: ToolCallLogUpdateInput): Promise<ToolCallLog | undefined>;
}

export interface HumanTaskDecisionSignalSender {
  send(input: HumanTaskDecisionSignalInput): Promise<void>;
}

export interface HumanTaskServiceOptions {
  store?: HumanTaskStore;
  auditStore?: HumanTaskAuditStore;
  toolCallLogStore?: HumanTaskToolCallLogStore;
  signalSender?: HumanTaskDecisionSignalSender;
}

export class HumanTaskService {
  private readonly store: HumanTaskStore;
  private readonly auditStore: HumanTaskAuditStore;
  private readonly toolCallLogStore: HumanTaskToolCallLogStore | undefined;
  private readonly signalSender: HumanTaskDecisionSignalSender | undefined;

  constructor(options: HumanTaskServiceOptions = {}) {
    this.store = options.store ?? new InMemoryHumanTaskStore();
    this.auditStore = options.auditStore ?? new InMemoryHumanTaskAuditStore();
    this.toolCallLogStore = options.toolCallLogStore;
    this.signalSender = options.signalSender;
  }

  async list(input: unknown): Promise<HumanTaskListResponse> {
    const parsed = humanTaskListRequestSchema.parse(input);
    const humanTasks = await this.store.list({
      tenantId: parsed.tenant_id,
      ...(parsed.task_run_id ? { taskRunId: parsed.task_run_id } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      limit: parsed.page_size,
      offset: (parsed.page - 1) * parsed.page_size,
    });

    return humanTaskListResponseSchema.parse({ human_tasks: humanTasks });
  }

  async get(humanTaskId: string, input: unknown): Promise<HumanTaskGetResponse | undefined> {
    const parsed = humanTaskGetRequestSchema.parse(input);
    const humanTask = await this.store.get(humanTaskId);
    if (!humanTask || humanTask.tenant_id !== parsed.tenant_id) {
      return undefined;
    }

    return humanTaskGetResponseSchema.parse({ human_task: humanTask });
  }

  async approve(humanTaskId: string, input: unknown): Promise<HumanTaskDecisionResponse | undefined> {
    return this.decide(humanTaskId, input, 'approved');
  }

  async reject(humanTaskId: string, input: unknown): Promise<HumanTaskDecisionResponse | undefined> {
    return this.decide(humanTaskId, input, 'rejected');
  }

  private async decide(
    humanTaskId: string,
    input: unknown,
    status: 'approved' | 'rejected',
  ): Promise<HumanTaskDecisionResponse | undefined> {
    const parsed = humanTaskDecisionRequestSchema.parse(input);
    const before = await this.store.get(humanTaskId);
    const wasPending = before?.status === 'pending' || before?.status === 'created' || before?.status === 'assigned';
    const decisionInput: HumanTaskDecisionInput = {
      tenantId: parsed.tenant_id,
      decidedBy: parsed.user_id,
      payload: parsed.payload,
      ...(parsed.decision_reason ? { decisionReason: parsed.decision_reason } : {}),
    };
    const humanTask = status === 'approved'
      ? await this.store.approve(humanTaskId, decisionInput)
      : await this.store.reject(humanTaskId, decisionInput);

    if (!humanTask) {
      return undefined;
    }

    const toolCallId = stringValue(humanTask.payload.tool_call_id);
    if (wasPending && toolCallId && this.toolCallLogStore) {
      await this.toolCallLogStore.update(toolCallId, { status });
    }

    if (wasPending && this.signalSender && humanTask.workflow_id) {
      await this.signalSender.send({
        human_task_id: humanTask.human_task_id,
        tenant_id: humanTask.tenant_id,
        task_run_id: humanTask.task_run_id,
        workflow_id: humanTask.workflow_id,
        status,
        ...(humanTask.decision ? { decision: humanTask.decision } : {}),
        ...(humanTask.decided_by ? { decided_by: humanTask.decided_by } : {}),
        ...(humanTask.decided_at ? { decided_at: humanTask.decided_at } : {}),
        ...(humanTask.decision_reason ? { decision_reason: humanTask.decision_reason } : {}),
      });
    }

    const auditEvent = wasPending
      ? await this.auditStore.append({
          tenant_id: humanTask.tenant_id,
          actor_id: parsed.user_id,
          action: status === 'approved' ? 'human_task.approve' : 'human_task.reject',
          target_type: 'human_task',
          target_id: humanTask.human_task_id,
          result: status === 'approved' ? 'allowed' : 'denied',
          ...(parsed.decision_reason ? { reason: parsed.decision_reason } : {}),
          ...(parsed.request_id ? { trace_id: parsed.request_id } : {}),
          payload: {
            task_run_id: humanTask.task_run_id,
            tool_call_id: toolCallId,
            decision_payload: parsed.payload,
            ...(humanTask.workflow_id ? { workflow_id: humanTask.workflow_id } : {}),
          },
        })
      : undefined;

    return humanTaskDecisionResponseSchema.parse({
      human_task: humanTask,
      audit_event_id: auditEvent?.event_id,
    });
  }
}

export class InMemoryHumanTaskStore implements HumanTaskStore {
  private readonly tasks = new Map<string, HumanTask>();

  constructor(initialTasks: HumanTask[] = []) {
    for (const task of initialTasks) {
      const parsed = humanTaskSchema.parse(task);
      this.tasks.set(parsed.human_task_id, parsed);
    }
  }

  async get(humanTaskId: string): Promise<HumanTask | undefined> {
    return this.tasks.get(humanTaskId);
  }

  async list(options: ListHumanTasksOptions = {}): Promise<HumanTask[]> {
    return [...this.tasks.values()]
      .filter((task) => {
        if (options.tenantId && task.tenant_id !== options.tenantId) {
          return false;
        }
        if (options.taskRunId && task.task_run_id !== options.taskRunId) {
          return false;
        }
        if (options.status && task.status !== options.status) {
          return false;
        }
        return true;
      })
      .slice(options.offset ?? 0, (options.offset ?? 0) + Math.min(Math.max(options.limit ?? 20, 1), 100));
  }

  async approve(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'approved', input);
  }

  async reject(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'rejected', input);
  }

  private decide(
    humanTaskId: string,
    status: 'approved' | 'rejected',
    input: HumanTaskDecisionInput,
  ): HumanTask | undefined {
    const existing = this.tasks.get(humanTaskId);
    if (!existing || (input.tenantId && existing.tenant_id !== input.tenantId)) {
      return undefined;
    }
    if (existing.status !== 'pending' && existing.status !== 'created' && existing.status !== 'assigned') {
      return existing;
    }

    const decidedAt = new Date().toISOString();
    const updated = humanTaskSchema.parse({
      ...existing,
      status,
      decision: {
        status,
        reason: input.decisionReason,
        payload: input.payload ?? {},
      },
      decided_by: input.decidedBy,
      decided_at: decidedAt,
      decision_reason: input.decisionReason,
      completed_at: decidedAt,
    });
    this.tasks.set(humanTaskId, updated);
    return updated;
  }
}

export class InMemoryHumanTaskAuditStore implements HumanTaskAuditStore {
  readonly events: AuditEvent[] = [];

  async append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): Promise<AuditEvent> {
    const auditEvent = auditEventSchema.parse({
      ...event,
      event_id: `audit_${this.events.length + 1}`,
      occurred_at: new Date().toISOString(),
    });
    this.events.push(auditEvent);
    return auditEvent;
  }
}

export class InMemoryHumanTaskToolCallLogStore implements HumanTaskToolCallLogStore {
  readonly updates: Array<{ toolCallId: string; input: ToolCallLogUpdateInput }> = [];

  async update(toolCallId: string, input: ToolCallLogUpdateInput): Promise<ToolCallLog | undefined> {
    this.updates.push({ toolCallId, input });
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
