import { randomUUID } from "crypto";
import type { OrchestrationEvent, EventFilter } from "../types";
import { OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import type { IEventRepository, IOutboxRepository, IEventBus, PaginatedResult } from "./ports";
import type { PaginationRequestDTO } from "../types/pagination";
import type { OutboxEntry, OutboxStatus } from "../types/outbox";

export class EventService {
  constructor(
    private readonly eventRepo: IEventRepository,
    private readonly outboxRepo: IOutboxRepository,
    private readonly eventBus: IEventBus,
  ) {}

  async getEvent(id: string): Promise<OrchestrationEvent> {
    const ev = await this.eventRepo.findById(id);
    if (!ev) throw OrchestrationError.fromCode(ErrorCodes.EVENT_NOT_FOUND);
    return ev;
  }

  async listEvents(filter: EventFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<OrchestrationEvent>> {
    return this.eventRepo.findMany(filter, pagination);
  }

  async publishEvent(event: Omit<OrchestrationEvent, "id" | "timestamp">): Promise<OrchestrationEvent> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const fullEvent: OrchestrationEvent = { ...event, id, timestamp: now };

    // Store in event repo
    const saved = await this.eventRepo.store(fullEvent);

    // Write to outbox for reliable delivery
    const outboxEntry: OutboxEntry = {
      id: randomUUID(),
      destination: "internal",
      eventId: id,
      eventType: fullEvent.type,
      payload: fullEvent as unknown as Record<string, unknown>,
      correlationId: fullEvent.correlationId,
      causationId: fullEvent.causationId,
      aggregateId: fullEvent.aggregateId,
      status: "pending" as OutboxStatus,
      attemptCount: 0,
      retryCount: 0,
      maxRetries: 3,
      createdAt: now,
    };
    await this.outboxRepo.create(outboxEntry);

    // Publish to event bus (for live subscribers)
    await this.eventBus.publish(fullEvent);

    return saved;
  }
}
