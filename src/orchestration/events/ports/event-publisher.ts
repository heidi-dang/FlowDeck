/**
 * Event publisher port.
 *
 * Publication is behind a port so the domain does not depend on
 * a specific event bus implementation.
 */

import type { DomainEvent } from "../domain/event-definitions"

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>
  publishMany(events: DomainEvent[]): Promise<void>
}
