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
 */
export class SseManager {
  private repository: StreamRepository;
  private broker: SseBroker;
  private publisher: StreamPublisher;
  private replayService: StreamReplayService;
  private sseRouteHandler: (req: any, res: any) => Promise<void>;
  private legacyClients = new Map<string, SseClient>();

  constructor(eventBus: EventBus, dbPathOrRepo?: string | StreamRepository, _projectFilter?: string) {
    if (typeof dbPathOrRepo === 'object' && dbPathOrRepo !== null) {
      this.repository = dbPathOrRepo;
    } else {
      const isTest = process.env.NODE_ENV === 'test';
      const dbPath = (typeof dbPathOrRepo === 'string' && (dbPathOrRepo.endsWith('.db') || dbPathOrRepo === ':memory:'))
        ? dbPathOrRepo
        : (isTest ? ':memory:' : './flowdeck.db');
      this.repository = new StreamRepository(dbPath, { allowInMemory: isTest });
    }

    this.broker = new SseBroker();
    this.publisher = new StreamPublisher(this.repository, this.broker);
    this.replayService = new StreamReplayService(this.repository);
    this.sseRouteHandler = createSseRoute(this.broker, this.replayService, this.repository);

    // Subscribe to EventBus and convert runtime HarnessEvents into canonical SSE v2 publication
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
    const eventData = (event.data || {}) as Record<string, unknown>;
    const runId = typeof eventData.runId === "string" ? eventData.runId : "default_run";

    const mappedType = this.mapHarnessEventType(event.type);

    const committed = this.publisher.publish({
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
    if (runId && !(req as any).params) {
      (req as any).params = { runId };
    }
    this.sseRouteHandler(req, res);
  }

  getStreamRepository(): StreamRepository {
    return this.repository;
  }

  getSseBroker(): SseBroker {
    return this.broker;
  }

  getPublisher(): StreamPublisher {
    return this.publisher;
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
