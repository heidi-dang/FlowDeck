import type { OrchestrationEvent } from "../types";

interface WsClient {
  id: string;
  send: (data: string) => void;
  close: () => void;
  filters?: { types?: string[]; runId?: string };
  createdAt: number;
}

export class WebSocketManager {
  private readonly clients = new Map<string, WsClient>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly heartbeatMs: number = 30000) {
    this.startHeartbeat();
  }

  addClient(id: string, send: (data: string) => void, close: () => void, filters?: { types?: string[]; runId?: string }): void {
    this.clients.set(id, { id, send, close, filters, createdAt: Date.now() });

    // Send connected message
    send(JSON.stringify({
      type: "connected",
      timestamp: new Date().toISOString(),
      data: { clientId: id },
    }));
  }

  removeClient(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.close();
      this.clients.delete(id);
    }
  }

  broadcast(event: OrchestrationEvent): void {
    const message = JSON.stringify({
      type: event.type,
      timestamp: new Date().toISOString(),
      data: event.data,
      correlationId: event.correlationId,
      runId: event.runId,
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
        // heartbeat response
      }
    } catch {
      // ignore invalid messages
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      for (const [id, client] of this.clients) {
        try {
          client.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
        } catch {
          this.clients.delete(id);
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
