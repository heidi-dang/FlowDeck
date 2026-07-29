/**
 * DomainEventAppender — transactional event store port.
 *
 * Appends events inside the domain transaction. External delivery
 * happens after commit, managed by runtime infrastructure.
 * Do NOT call HTTP, SSE, WebSocket, or non-transactional delivery here.
 */

import type { DomainEvent } from "../domain/event-definitions"

export interface DomainEventAppender {
  append(event: DomainEvent): Promise<void>
  appendMany(events: DomainEvent[]): Promise<void>
}
