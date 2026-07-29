import type { ServerResponse } from "http";
import type { OrchestrationEvent } from "../types";
import { EVENT_VERSION } from "../types/events";

interface SseClient {
  id: string;
  res: ServerResponse;
  filters?: { types?: string[]; runId?: string };
  lastEventId?: string;
  createdAt: number;
}

const MAX_CLIENTS = 500;

export class SseManager {
  private readonly clients = new Map<string, SseClient>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private seqId = 0;

  constructor(private readonly heartbeatMs: number = 15000) {
    this.startHeartbeat();
  }

  addClient(
    id: string,
    res: ServerResponse,
    filters?: { types?: string[]; runId?: string },
  ): { accepted: boolean; reason?: string } {
    // Reconnect: clean up old connection first if same client reconnects
    const existing = this.clients.get(id);
    if (existing) {
      try { existing.res.end(); } catch { /* ignore — socket may already be dead */ }
      this.clients.delete(id);
    }

    // Enforce maximum client limit
    if (this.clients.size >= MAX_CLIENTS) {
      return { accepted: false, reason: "max_clients_reached" };
    }

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

    return { accepted: true };
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      try { client.res.end(); } catch { /* ignore */ }
      this.clients.delete(client.id);
    }
  }

  broadcast(event: OrchestrationEvent): void {
    if (this.clients.size === 0) return;

    for (const [, client] of this.clients) {
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

    // Ensure data is a plain JSON-serializable object
    const payload = JSON.stringify({
      type: eventType,
      eventVersion: EVENT_VERSION,
      timestamp: new Date().toISOString(),
      data,
    });

    try {
      res.write(`id: ${id}\n`);
      res.write(`event: ${eventType}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch {
      // Write failed — client likely disconnected; caller should remove client
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      if (this.clients.size === 0) return;

      for (const [, client] of this.clients) {
        try {
          this.sendEvent(client.res, "heartbeat", { time: new Date().toISOString() });
        } catch {
          this.clients.delete(client.id);
        }
      }
    }, this.heartbeatMs);
  }

  /** Gracefully shut down: close all client connections and stop heartbeats. */
  dispose(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [, client] of this.clients) {
      try {
        this.sendEvent(client.res, "shutdown", { reason: "server_shutdown" });
        client.res.end();
      } catch { /* ignore */ }
      this.clients.delete(client.id);
    }
  }
}
