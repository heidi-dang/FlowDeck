import type { OrchestrationEvent } from "../types";
import { EVENT_VERSION } from "../types/events";

interface WsClient {
  id: string;
  send: (data: string) => void;
  close: () => void;
  filters?: { types?: string[]; runId?: string };
  createdAt: number;
}

const MAX_CLIENTS = 500;
const CLIENT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — force renew

export class WebSocketManager {
  private readonly clients = new Map<string, WsClient>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly heartbeatMs: number = 30000) {
    this.startHeartbeat();
  }

  addClient(
    id: string,
    send: (data: string) => void,
    close: () => void,
    filters?: { types?: string[]; runId?: string },
  ): { accepted: boolean; reason?: string } {
    // Reconnect: clean up old connection
    const existing = this.clients.get(id);
    if (existing) {
      try {
        existing.send(JSON.stringify({ type: "replaced", timestamp: new Date().toISOString() }));
        existing.close();
      } catch { /* ignore */ }
      this.clients.delete(id);
    }

    // Enforce maximum client limit
    if (this.clients.size >= MAX_CLIENTS) {
      return { accepted: false, reason: "max_clients_reached" };
    }

    this.clients.set(id, { id, send, close, filters, createdAt: Date.now() });

    // Send connected message
    send(JSON.stringify({
      type: "connected",
      timestamp: new Date().toISOString(),
      data: { clientId: id },
    }));

    return { accepted: true };
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      try { client.close(); } catch { /* ignore */ }
      this.clients.delete(id);
    }
  }

  broadcast(event: OrchestrationEvent): void {
    if (this.clients.size === 0) return;

    const message = JSON.stringify({
      type: event.type,
      eventVersion: EVENT_VERSION,
      timestamp: new Date().toISOString(),
      data: event.data,
      correlationId: event.correlationId,
      runId: event.runId,
      causationId: event.causationId,
      aggregateId: event.aggregateId,
    });

    for (const [id, client] of this.clients) {
      if (client.filters?.types && !client.filters.types.includes(event.type)) continue;
      if (client.filters?.runId && event.runId !== client.filters.runId) continue;

      try {
        client.send(message);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  handleMessage(clientId: string, message: string): void {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === "subscribe" && parsed.filters) {
        const client = this.clients.get(clientId);
        if (client) {
          client.filters = parsed.filters;
        }
      }
      if (parsed.type === "pong") {
        // heartbeat response acknowledged — could refresh TTL here
      }
    } catch {
      // ignore invalid messages
    }
  }

  dispose(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const [id, client] of this.clients) {
      try {
        client.send(JSON.stringify({ type: "shutdown", reason: "server_shutdown" }));
        client.close();
      } catch { /* ignore */ }
      this.clients.delete(id);
    }
  }

  /** Cleans up clients that have exceeded the max age (heartbeat-driven). */
  private pruneStaleClients(): void {
    const cutoff = Date.now() - CLIENT_MAX_AGE_MS;
    for (const [id, client] of this.clients) {
      if (client.createdAt < cutoff) {
        try {
          client.send(JSON.stringify({ type: "session_expired", reason: "max_session_duration" }));
          client.close();
        } catch { /* ignore */ }
        this.clients.delete(id);
      }
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      if (this.clients.size === 0) return;

      // Prune stale clients once per heartbeat cycle
      this.pruneStaleClients();

      for (const [id, client] of this.clients) {
        try {
          client.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
        } catch {
          this.clients.delete(id);
        }
      }
    }, this.heartbeatMs);
  }
}
