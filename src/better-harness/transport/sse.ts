import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import type { EventBus, HarnessEvent, HarnessEventType } from "../runtime/event-bus";

interface StoredSseEvent {
  id: number;
  type: string;
  timestamp: string;
  data: string;
  /** Routing metadata for replay filtering. Persisted alongside the event
   *  so that filterAndSend can match clients by server/project/run without
   *  guessing from the event payload (which may lack projectKey). */
  routing?: {
    serverKey?: string;
    projectKey?: string;
    runId?: string;
  };
}

export interface SseClient {
  id: string;
  lastEventId: string | null;
  serverKey?: string;
  projectKey?: string;
  runId?: string;
  send: (event: HarnessEvent, sequenceId: number) => void;
}

export class SseManager {
  private clients = new Map<string, SseClient>();
  private sequenceCounter = 0;
  private heartbeatIntervalMs = 15_000;
  private eventLogPath: string | null = null;
  private heartbeats: Map<string, ReturnType<typeof setInterval>> = new Map();
  private eventBus: EventBus;

  constructor(eventBus: EventBus, eventLogDir?: string, private projectFilter?: string) {
    this.eventBus = eventBus;
    if (eventLogDir) {
      this.eventLogPath = join(eventLogDir, "sse-events.jsonl");
      const dir = dirname(this.eventLogPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      } else {
        // Recover the maximum persisted sequence ID so that new events
        // never reuse an ID from a previous process lifetime.  Without
        // this recovery, a browser holding Last-Event-ID from the earlier
        // session would silently discard newly emitted events.
        this.recoverSequenceCounter();
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
   * Scan the existing event log for the maximum persisted sequence ID and
   * initialise sequenceCounter above it, guaranteeing that new events never
   * collide with IDs from a previous process lifetime.
   */
  private recoverSequenceCounter(): void {
    if (!this.eventLogPath || !existsSync(this.eventLogPath)) return;
    try {
      const lines = readFileSync(this.eventLogPath, "utf-8").split("\n").filter(Boolean);
      let maxId = 0;
      for (const line of lines) {
        try {
          const stored: StoredSseEvent = JSON.parse(line);
          if (stored.id > maxId) maxId = stored.id;
        } catch { /* skip corrupt lines */ }
      }
      if (maxId > 0) {
        this.sequenceCounter = maxId;
      }
    } catch { /* best-effort recovery */ }
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
   * Filters by runId when the client is scoped to a specific run.
   * The projectKey filter is intentionally NOT applied because runtime
   * events (run.progress, run.queued, etc.) never carry projectKey in
   * their payload — only runId, which is sufficient for correct routing.
   */
  private filterAndSend(client: SseClient, event: HarnessEvent, sequenceId: number): void {
    if (client.runId) {
      const eventData = (event.data || {}) as Record<string, unknown>;
      // Events without a runId (connected, heartbeat) pass through to all clients.
      // Events with a mismatched runId are filtered out.
      if (eventData.runId !== undefined && eventData.runId !== client.runId) {
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
            // Last-Event-ID is exclusive — only replay events with ID > lastSeq.
            // This guarantees every replayed event ID appears exactly once.
            if (stored.id > lastSeq) {
              // Use stored routing metadata for client-level filtering.
              // This is more reliable than parsing the payload, because
              // routing is extracted at persist time when context is known.
              if (client.runId && stored.routing?.runId && stored.routing.runId !== client.runId) {
                continue;
              }

              // Reconstruct HarnessEvent for sending
              const replayEvent: HarnessEvent = {
                type: stored.type as HarnessEventType,
                timestamp: stored.timestamp,
                data: stored.data ? JSON.parse(stored.data) : undefined,
              };
              client.send(replayEvent, stored.id);
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

    // Create a client bound to this response BEFORE sending the connected
    // frame, so that addClient() replays durable events first.  Replay must
    // precede connected because the UI uses the first received id to
    // initialise its deduplication watermark (lastValidEventId).  If
    // connected carried an id the UI would discard all replayed events with
    // lower IDs.
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

    // 1. Replay durable events (if any) so the UI processes them before
    //    the connected frame and never discards them due to an id watermark.
    this.addClient(client);

    // 2. Send connected frame.  It omits the SSE `id: ` field on purpose:
    //    the UI's deduplication logic uses the first received id as its
    //    watermark.  If connected supplied an id, all replayed events with
    //    lower ids would be silently discarded.
    const connectedTimestamp = new Date().toISOString();
    const connectedEnvelope = JSON.stringify({
      type: "connected",
      timestamp: connectedTimestamp,
      data: { clientId },
    });
    res.write(`event: connected\ndata: ${connectedEnvelope}\n\n`);

    // 3. Start heartbeats — also without an `id:` field.
    const hb = setInterval(() => {
      try {
        const hbTimestamp = new Date().toISOString();
        const hbEnvelope = JSON.stringify({
          type: "heartbeat",
          timestamp: hbTimestamp,
          data: { time: hbTimestamp },
        });
        res.write(`event: heartbeat\ndata: ${hbEnvelope}\n\n`);
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
      // Extract routing from the event payload (runId is always present for
      // runtime events like run.progress, run.queued, etc.)
      const eventData = (event.data || {}) as Record<string, unknown>;
      const extractedRunId = typeof eventData.runId === "string" ? eventData.runId : undefined;
      const stored: StoredSseEvent = {
        id,
        type: event.type,
        timestamp: event.timestamp,
        data: event.data ? JSON.stringify(event.data) : "",
        routing: extractedRunId ? { runId: extractedRunId } : undefined,
      };
      writeFileSync(this.eventLogPath, JSON.stringify(stored) + "\n", { flag: "a" });
    } catch { /* best-effort persist */ }
  }
}
