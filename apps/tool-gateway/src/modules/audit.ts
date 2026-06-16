import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@dar/contracts';

export class InMemoryAuditStore {
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
