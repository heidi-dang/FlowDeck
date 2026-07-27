import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import type { EventBus, HarnessEvent, HarnessEventType } from "../runtime/event-bus";

export interface SseClient {
  id: string;
  lastEventId: string | null;
  projectKey?: string;
  runId?: string;
  send: (event: HarnessEvent) => void;
}

interface StoredSseEvent {
  id: number;
  type: string;
  timestamp: string;
  data: string;
}

export class SseManager {
  private clients = new Map<string, SseClient>();
  private eventHistory: HarnessEvent[] = [];
  private maxHistorySize = 100;
  private sequenceCounter = 0;
  private heartbeatIntervalMs = 15_000;
  private eventLogPath: string | null = null;
  private heartbeats: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(eventBus: EventBus, eventLogDir?: string, private projectFilter?: string) {
    if (eventLogDir) {
      this.eventLogPath = join(eventLogDir, "sse-events.jsonl");
      const dir = dirname(this.eventLogPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

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
    // Replay missed events from history by sequence matching
    if (client.lastEventId) {
      const lastSeq = parseInt(client.lastEventId, 10);
      if (!isNaN(lastSeq)) {
        const replayFrom = this.eventHistory.findIndex((e) => {
          const storedId = (e as unknown as Record<string, unknown>)._sseId;
          return typeof storedId === "number" && storedId > lastSeq;
        });
        if (replayFrom >= 0) {
          for (let i = replayFrom; i < this.eventHistory.length; i++) {
            client.send(this.eventHistory[i]);
          }
        }
      }
    }

    // Replay from file-based event log if available
    if (client.lastEventId && this.eventLogPath && existsSync(this.eventLogPath)) {
      const lastSeq = parseInt(client.lastEventId, 10);
      if (!isNaN(lastSeq)) {
        try {
          const lines = readFileSync(this.eventLogPath, "utf-8").split("\n").filter(Boolean);
          for (const line of lines) {
            const stored: StoredSseEvent = JSON.parse(line);
            if (stored.id > lastSeq) {
              const event: HarnessEvent = {
                type: stored.type as HarnessEventType,
                timestamp: stored.timestamp,
                data: stored.data ? JSON.parse(stored.data) : undefined,
              };
              client.send(event);
            }
          }
        } catch { /* best-effort replay from file */ }
      }
    }

    this.clients.set(client.id, client);
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    const hb = this.heartbeats.get(clientId);
    if (hb) {
      clearInterval(hb);
      this.heartbeats.delete(clientId);
    }
  }

  handleSseRequest(req: IncomingMessage, res: ServerResponse, serverKey?: string, projectKey?: string, runId?: string): void {
    const clientId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lastEventId = req.headers["last-event-id"] as string | undefined;

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connection event
    res.write("id: " + this.nextSequence() + "\nevent: connected\ndata: {\"clientId\":\"" + clientId + "\"}\n\n");

    // Create a client bound to this response
    const client: SseClient = {
      id: clientId,
      lastEventId: lastEventId ?? null,
      projectKey,
      runId,
      send: (event: HarnessEvent) => {
        try {
          // Filter by project/run if configured
          if (projectKey || runId) {
            const eventData = event.data || {};
            if (projectKey && (eventData as Record<string, unknown>).projectKey !== projectKey) {
              return;
            }
            if (runId && (eventData as Record<string, unknown>).runId !== runId) {
              return;
            }
          }
          const sseId = this.nextSequence();
          // Store sequence id on event for replay
          (event as unknown as Record<string, unknown>)._sseId = sseId;
          // Don't replace dots with hyphens per spec requirement
          const sseType = event.type;
          const eventPayload = {
            type: event.type,
            timestamp: event.timestamp,
            data: event.data,
          };
          res.write("id: " + sseId + "\nevent: " + sseType + "\ndata: " + JSON.stringify(eventPayload) + "\n\n");
          this.persistEvent(sseId, event);
        } catch { /* client disconnected */ }
      },
    };

    this.addClient(client);

    // Start heartbeats
    const hb = setInterval(() => {
      try {
        res.write("id: " + this.nextSequence() + "\nevent: heartbeat\ndata: {\"time\":\"" + new Date().toISOString() + "\"}\n\n");
      } catch {
        this.handleClientDisconnect(clientId);
      }
    }, this.heartbeatIntervalMs);
    this.heartbeats.set(clientId, hb);

    // Handle client disconnect
    req.on("close", () => {
      this.handleClientDisconnect(clientId);
    });
  }

  private handleClientDisconnect(clientId: string): void {
    this.removeClient(clientId);
  }

  private nextSequence(): number {
    return ++this.sequenceCounter;
  }

  private persistEvent(id: number, event: HarnessEvent): void {
    if (!this.eventLogPath) return;
    try {
      const stored: StoredSseEvent = {
        id,
        type: event.type,
        timestamp: event.timestamp,
        data: event.data ? JSON.stringify(event.data) : "",
      };
      writeFileSync(this.eventLogPath, JSON.stringify(stored) + "\n", { flag: "a" });
    } catch { /* best-effort persist */ }
  }

  private broadcast(event: HarnessEvent): void {
    for (const client of this.clients.values()) {
      try {
        client.send(event);
      } catch { /* client disconnected */ }
    }
  }
}
