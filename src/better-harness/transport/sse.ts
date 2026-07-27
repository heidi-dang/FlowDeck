import type { EventBus, HarnessEvent, HarnessEventType } from "../runtime/event-bus";

export interface SseClient {
  id: string;
  lastEventId: string | null;
  send: (event: HarnessEvent) => void;
}

export class SseManager {
  private clients = new Map<string, SseClient>();
  private eventHistory: HarnessEvent[] = [];
  private maxHistorySize = 100;

  constructor(eventBus: EventBus) {
    const types: HarnessEventType[] = [
      "run.queued", "run.started", "collector.started", "collector.completed",
      "analysis.started", "finding.created", "run.progress", "report.completed",
      "run.cancelled", "run.failed",
    ];

    for (const type of types) {
      eventBus.subscribe(type, (event) => {
        this.eventHistory.push(event);
        if (this.eventHistory.length > this.maxHistorySize) {
          this.eventHistory.shift();
        }
        this.broadcast(event);
      });
    }
  }

  addClient(client: SseClient): void {
    // Replay missed events
    if (client.lastEventId) {
      const replayFrom = this.eventHistory.findIndex((e) => e.timestamp > client.lastEventId!);
      if (replayFrom >= 0) {
        for (let i = replayFrom; i < this.eventHistory.length; i++) {
          client.send(this.eventHistory[i]);
        }
      }
    }
    this.clients.set(client.id, client);
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  private broadcast(event: HarnessEvent): void {
    for (const client of this.clients.values()) {
      try {
        client.send(event);
      } catch { /* client disconnected */ }
    }
  }
}
