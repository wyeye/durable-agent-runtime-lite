import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@dar/contracts';
import { AuditEventRepository } from '@dar/db';

export interface AuditStore {
  append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): AuditEvent | Promise<AuditEvent>;
  list(): AuditEvent[] | Promise<AuditEvent[]>;
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

  list(): AuditEvent[] {
    return [...this.events];
  }
}

export class DbAuditStore implements AuditStore {
  constructor(private readonly repository: AuditEventRepository) {}

  async append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): Promise<AuditEvent> {
    return this.repository.append(event);
  }

  async list(): Promise<AuditEvent[]> {
    return this.repository.list();
  }
}
