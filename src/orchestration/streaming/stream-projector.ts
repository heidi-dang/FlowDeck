import { FlowDeckStreamEvent, createStreamEvent } from "./stream-event";

export class StreamProjector {
  project(domainEvent: any, sequence: number): FlowDeckStreamEvent {
    return createStreamEvent({
      eventId: domainEvent.eventId || String(sequence),
      sequence,
      runId: domainEvent.runId || "unknown",
      type: domainEvent.type || "agent.progress",
      stage: domainEvent.stage || "execute",
      importance: domainEvent.importance || "normal",
      title: domainEvent.title || domainEvent.type || "Event",
      payload: domainEvent.payload || {},
    });
  }
}

