import type { IncomingMessage, ServerResponse } from "http";
import type { EventBus, HarnessEvent } from "../runtime/event-bus";
import {
  StreamRepository,
  SseBroker,
  StreamPublisher,
  StreamReplayService,
  createSseRoute,
} from "../../orchestration/streaming";

export interface SseClient {
  id: string;
  lastEventId: string | null;
  serverKey?: string;
  projectKey?: string;
  runId?: string;
  send: (event: HarnessEvent, sequenceId: number) => void;
}

/**
 * Unified Production SseManager Adapter.
 *
 * Wraps canonical SQLite-backed SSE v2 infrastructure (StreamRepository + SseBroker + StreamPublisher).
 * Replaces the legacy file-backed `sse-events.jsonl` system so that production maintains only:
 * - One sequence counter (SQLite aggregate_version).
 * - One replay store (SQLite canonical `events` table).
 * - One event format (FlowDeckStreamEvent).
 *
 * The SQLite repository is constructed lazily on first SSE use. This keeps the
 * standalone CLI server startable under supported Node versions: the health
 * and API routes never open a SQLite handle, and the packed standalone bundle
 * must not depend on the Bun-only `bun:sqlite` builtin at startup.
 */
export class SseManager {
  private repository: StreamRepository | null = null;
  private broker: SseBroker | null = null;
  private publisher: StreamPublisher | null = null;
  private replayService: StreamReplayService | null = null;
  private sseRouteHandler: ((req: any, res: any) => Promise<void>) | null = null;
  private legacyClients = new Map<string, SseClient>();
  private readonly eventBus: EventBus;
  private readonly dbPathOrRepo?: string | StreamRepository;
  private readonly projectFilter?: string;

  constructor(eventBus: EventBus, dbPathOrRepo?: string | StreamRepository, _projectFilter?: string) {
    this.eventBus = eventBus;
    this.dbPathOrRepo = dbPathOrRepo;
    this.projectFilter = _projectFilter;

    // Subscribe to EventBus and convert runtime HarnessEvents into canonical
    // SSE v2 publication. Subscription itself never opens the repository.
    const types = [
      "run.queued", "run.started", "collector.started", "collector.completed",
      "analysis.started", "finding.created", "run.progress", "report.completed",
      "run.cancelled", "run.failed",
    ];

    for (const type of types) {
      eventBus.subscribe(type as any, (event) => {
        this.broadcastEvent(event);
      });
    }
  }

  /**
   * Lazily initialize the SQLite-backed SSE infrastructure. Only called on
   * the first SSE broadcast or SSE request; the health and API routes never
   * invoke it, so the standalone server can start under Node where the
   * Bun-only `bun:sqlite` builtin is unavailable.
   */
  private ensureInitialized(): void {
    if (this.repository) return;

    if (typeof this.dbPathOrRepo === 'object' && this.dbPathOrRepo !== null) {
      this.repository = this.dbPathOrRepo;
    } else {
      const isTest = process.env.NODE_ENV === 'test';
      const dbPath = (typeof this.dbPathOrRepo === 'string' && (this.dbPathOrRepo.endsWith('.db') || this.dbPathOrRepo === ':memory:'))
        ? this.dbPathOrRepo
        : (isTest ? ':memory:' : './flowdeck.db');
      this.repository = new StreamRepository(dbPath, { allowInMemory: isTest });
    }

    this.broker = new SseBroker();
    this.publisher = new StreamPublisher(this.repository, this.broker);
    this.replayService = new StreamReplayService(this.repository);
    this.sseRouteHandler = createSseRoute(this.broker, this.replayService, this.repository);
  }

  addClient(client: SseClient): void {
    this.legacyClients.set(client.id, client);
  }

  removeClient(clientId: string): void {
    this.legacyClients.delete(clientId);
  }

  /**
   * Broadcast a runtime event by persisting it atomically before live delivery.
   */
  broadcastEvent(event: HarnessEvent): void {
    this.ensureInitialized();
    const eventData = (event.data || {}) as Record<string, unknown>;
    const runId = typeof eventData.runId === "string" ? eventData.runId : "default_run";

    const mappedType = this.mapHarnessEventType(event.type);

    const committed = this.publisher!.publish({
      runId,
      type: mappedType as any,
      stage: event.type.startsWith("run.") ? "intake" : "execute",
      importance: event.type.endsWith(".failed") ? "critical" : "normal",
      title: `Harness Event: ${event.type}`,
      payload: event.data || {},
      occurredAt: event.timestamp || new Date().toISOString(),
    });

    // Mirror to legacy in-memory test clients if any
    for (const client of this.legacyClients.values()) {
      try {
        client.send(event, committed.sequence);
      } catch {
        /* client disconnected */
      }
    }
  }

  handleSseRequest(
    req: IncomingMessage,
    res: ServerResponse,
    _serverKey?: string,
    _projectKey?: string,
    runId?: string,
  ): void {
    this.ensureInitialized();
    if (runId && !(req as any).params) {
      (req as any).params = { runId };
    }
    this.sseRouteHandler!(req, res);
  }

  getStreamRepository(): StreamRepository {
    this.ensureInitialized();
    return this.repository!;
  }

  getSseBroker(): SseBroker {
    this.ensureInitialized();
    return this.broker!;
  }

  getPublisher(): StreamPublisher {
    this.ensureInitialized();
    return this.publisher!;
  }

  /**
   * Shut down all live SSE connections and legacy test clients. Required so a
   * persistent SSE connection cannot block `server.close()` during tests or
   * server shutdown. Safe to call before the repository was ever initialized.
   */
  dispose(): void {
    this.broker?.closeAll();
    for (const client of this.legacyClients.values()) {
      try {
        client.send(
          { type: "shutdown", data: { reason: "server_shutdown" }, timestamp: new Date().toISOString() } as unknown as HarnessEvent,
          0,
        );
      } catch { /* client already disconnected */ }
    }
    this.legacyClients.clear();
  }

  private mapHarnessEventType(type: string): string {
    const map: Record<string, string> = {
      "run.queued": "run.created",
      "run.started": "run.started",
      "collector.started": "agent.started",
      "collector.completed": "agent.completed",
      "analysis.started": "stage.entered",
      "finding.created": "evidence.created",
      "run.progress": "stage.progress",
      "report.completed": "run.completed",
      "run.cancelled": "run.cancelled",
      "run.failed": "run.failed",
    };
    return map[type] || "agent.progress";
  }
}
