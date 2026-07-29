import type { ServerResponse } from "http";
import type { OrchestrationEvent } from "../types";

interface SseClient {
  id: string;
  res: ServerResponse;
  filters?: { types?: string[]; runId?: string };
  lastEventId?: string;
  createdAt: number;
}

export class SseManager {
  private readonly clients = new Map<string, SseClient>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private seqId = 0;

  constructor(private readonly heartbeatMs: number = 15000) {
    this.startHeartbeat();
  }

  addClient(id: string, res: ServerResponse, filters?: { types?: string[]; runId?: string }): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send connected event
    this.sendEvent(res, "connected", { clientId: id });

    this.clients.set(id, { id, res, filters, createdAt: Date.now() });

    res.on("close", () => {
      this.clients.delete(id);
    });
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      this.clients.delete(id);
    }
  }

  broadcast(event: OrchestrationEvent): void {
    for (const [id, client] of this.clients) {
      // Apply filters
      if (client.filters?.types && !client.filters.types.includes(event.type)) continue;
      if (client.filters?.runId && event.runId !== client.filters.runId) continue;

      this.sendEvent(client.res, event.type, event.data, event.id);
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private sendEvent(res: ServerResponse, eventType: string, data: unknown, eventId?: string): void {
    const id = eventId ?? String(++this.seqId);
    const payload = JSON.stringify({
      type: eventType,
      timestamp: new Date().toISOString(),
      data,
    });

    res.write(`id: ${id}\n`);
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${payload}\n\n`);
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      for (const [, client] of this.clients) {
        try {
          this.sendEvent(client.res, "heartbeat", { time: new Date().toISOString() });
        } catch {
          this.clients.delete(client.id);
        }
      }
    }, this.heartbeatMs);
  }

  dispose(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [id] of this.clients) {
      this.clients.delete(id);
    }
  }
}
