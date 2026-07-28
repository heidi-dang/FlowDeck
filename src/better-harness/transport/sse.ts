import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import type { EventBus, HarnessEvent, HarnessEventType } from "../runtime/event-bus";

interface StoredSseEvent {
  id: number;
  type: string;
  timestamp: string;
  data: string;
}

export interface SseClient {
  id: string;
  lastEventId: string | null;
  serverKey?: string;
  projectKey?: string;
  runId?: string;
  send: (event: HarnessEvent, sequenceId: number) => void;
}

export interface SseTimingOptions {
  heartbeatIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  now?: () => Date;
}

export class SseManager {
  private clients = new Map<string, SseClient>();
  private sequenceCounter = 0;
  private heartbeatIntervalMs: number;
  private eventLogPath: string | null = null;
  private heartbeats: Map<string, ReturnType<typeof setInterval>> = new Map();
  private eventBus: EventBus;
  private setIntervalFn: typeof setInterval;
  private clearIntervalFn: typeof clearInterval;
  private now: () => Date;

  constructor(
    eventBus: EventBus,
    eventLogDir?: string,
    private projectFilter?: string,
    timing: SseTimingOptions = {},
  ) {
    this.eventBus = eventBus;
    this.heartbeatIntervalMs = timing.heartbeatIntervalMs ?? 15_000;
    this.setIntervalFn = timing.setIntervalFn ?? setInterval;
    this.clearIntervalFn = timing.clearIntervalFn ?? clearInterval;
    this.now = timing.now ?? (() => new Date());
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
        this.broadcastEvent(event);
      });
    }
  }

  /**
   * Assign one monotonic sequence ID to a runtime event, persist it once,
   * then broadcast the same sequence ID and canonical envelope to all matching clients.
   */
  private broadcastEvent(event: HarnessEvent): void {
    const sequenceId = this.nextSequence();
    // Persist once with the assigned ID
    this.persistEvent(sequenceId, event);
    // Broadcast same ID to all clients
    for (const client of this.clients.values()) {
      try {
        this.filterAndSend(client, event, sequenceId);
      } catch { /* client disconnected */ }
    }
  }

  /**
   * Build the canonical envelope and send to a single client.
   * Respects projectKey and runId filters on the client.
   */
  private filterAndSend(client: SseClient, event: HarnessEvent, sequenceId: number): void {
    // Filter by server/project/run if configured on the client
    if (client.projectKey || client.runId) {
      const eventData = event.data || {};
      if (client.projectKey && (eventData as Record<string, unknown>).projectKey !== client.projectKey) {
        return;
      }
      if (client.runId && (eventData as Record<string, unknown>).runId !== client.runId) {
        return;
      }
    }

    client.send(event, sequenceId);
  }

  addClient(client: SseClient): void {
    // Replay from file-based event log (single source of truth)
    if (client.lastEventId && this.eventLogPath && existsSync(this.eventLogPath)) {
      const lastSeq = parseInt(client.lastEventId, 10);
      if (!isNaN(lastSeq)) {
        try {
          const lines = readFileSync(this.eventLogPath, "utf-8").split("\n").filter(Boolean);
          for (const line of lines) {
            const stored: StoredSseEvent = JSON.parse(line);
            // Last-Event-ID is exclusive — only replay events with ID > lastSeq
            if (stored.id > lastSeq) {
              // Reconstruct HarnessEvent for sending
              const replayEvent: HarnessEvent = {
                type: stored.type as HarnessEventType,
                timestamp: stored.timestamp,
                data: stored.data ? JSON.parse(stored.data) : undefined,
              };
              this.filterAndSend(client, replayEvent, stored.id);
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
      this.clearIntervalFn(hb);
      this.heartbeats.delete(clientId);
    }
  }

  handleSseRequest(
    req: IncomingMessage,
    res: ServerResponse,
    serverKey?: string,
    projectKey?: string,
    runId?: string,
  ): void {
    const clientId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const lastEventId = req.headers["last-event-id"] as string | undefined;

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send initial connected event with canonical envelope
    const connectedSeq = this.nextSequence();
    const connectedTimestamp = this.now().toISOString();
    const connectedEnvelope = JSON.stringify({
      type: "connected",
      timestamp: connectedTimestamp,
      data: { clientId },
    });
    res.write(`id: ${connectedSeq}\nevent: connected\ndata: ${connectedEnvelope}\n\n`);
    this.persistEvent(connectedSeq, {
      type: "connected",
      timestamp: connectedTimestamp,
      data: { clientId },
    });

    // Create a client bound to this response
    const client: SseClient = {
      id: clientId,
      lastEventId: lastEventId ?? null,
      serverKey,
      projectKey,
      runId,
      send: (event: HarnessEvent, sequenceId: number) => {
        try {
          // Build canonical envelope
          const envelope = {
            type: event.type,
            timestamp: event.timestamp,
            data: event.data,
          };
          res.write(`id: ${sequenceId}\nevent: ${event.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
        } catch { /* client disconnected */ }
      },
    };

    this.addClient(client);

    // Start heartbeats with canonical envelope
    const hb = this.setIntervalFn(() => {
      try {
        const hbSeq = this.nextSequence();
        const hbTimestamp = this.now().toISOString();
        const hbEnvelope = JSON.stringify({
          type: "heartbeat",
          timestamp: hbTimestamp,
          data: { time: hbTimestamp },
        });
        res.write(`id: ${hbSeq}\nevent: heartbeat\ndata: ${hbEnvelope}\n\n`);
        this.persistEvent(hbSeq, {
          type: "heartbeat",
          timestamp: hbTimestamp,
          data: { time: hbTimestamp },
        });
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
}
