import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@dar/contracts';
import { AuditEventRepository, type ListAuditEventsOptions } from '@dar/db';

export interface AuditStore {
  append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): AuditEvent | Promise<AuditEvent>;
  list(options?: ListAuditEventsOptions): AuditEvent[] | Promise<AuditEvent[]>;
}

export class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];

  append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): AuditEvent {
    const auditEvent: AuditEvent = {
      ...event,
      event_id: `audit_${randomUUID()}`,
      occurred_at: new Date().toISOString(),
    };
    this.events.push(auditEvent);
    return auditEvent;
  }

  list(options: ListAuditEventsOptions = {}): AuditEvent[] {
    return [...this.events].filter((event) => {
      if (options.tenantId && event.tenant_id !== options.tenantId) {
        return false;
      }
      if (options.targetType && event.target_type !== options.targetType) {
        return false;
      }
      if (options.targetId && event.target_id !== options.targetId) {
        return false;
      }
      if (options.action && event.action !== options.action) {
        return false;
      }
      if (options.taskRunId && event.payload.task_run_id !== options.taskRunId) {
        return false;
      }
      if (options.toolName && event.target_id !== options.toolName) {
        return false;
      }
      return true;
    }).slice(options.offset ?? 0, (options.offset ?? 0) + Math.min(Math.max(options.limit ?? 20, 1), 100));
  }
}

export class DbAuditStore implements AuditStore {
  constructor(private readonly repository: AuditEventRepository) {}

  async append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): Promise<AuditEvent> {
    return this.repository.append(event);
  }

  async list(options: ListAuditEventsOptions = {}): Promise<AuditEvent[]> {
    return this.repository.list(options);
  }
}
