import { createHash, randomUUID } from "crypto";
import type { Replay, CreateReplayInput } from "../types";
import { ReplayStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import { createEvent } from "../types/events";
import type { OrchestrationEvent } from "../types/events";
import type { IReplayRepository, IEventBus, IEventRepository, PaginatedResult } from "./ports";
import type { PagePaginationRequest } from "../types/pagination";

export interface ReplayValidationResult {
  ok: boolean;
  reason?: string;
  eventCount: number;
}

interface OrderedEvent {
  id: string;
  aggregateId: string;
  aggregateVersion: number;
  timestamp: string;
}

function toOrdered(events: OrchestrationEvent[]): OrderedEvent[] {
  return events.map((e) => ({
    id: e.id,
    aggregateId: e.aggregateId ?? "",
    aggregateVersion: e.aggregateVersion ?? 0,
    timestamp: e.timestamp,
  }));
}

function compareOrdered(a: OrderedEvent, b: OrderedEvent): number {
  if (a.aggregateId !== b.aggregateId) return a.aggregateId < b.aggregateId ? -1 : 1;
  if (a.aggregateVersion !== b.aggregateVersion) return a.aggregateVersion - b.aggregateVersion;
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}

/**
 * Validate that an event stream can be replayed deterministically.
 *
 * Rules (mirror the replay harness expectations):
 *  - Events must carry aggregate identity (aggregateId + aggregateVersion).
 *  - Within a single aggregate, versions must be contiguous starting at 1
 *    (no gaps, no duplicates, no non-monotonic order).
 */
export function validateReplayStream(events: OrchestrationEvent[]): ReplayValidationResult {
  if (events.length === 0) return { ok: true, eventCount: 0 };

  for (const ev of events) {
    if (ev.aggregateId === undefined || ev.aggregateVersion === undefined) {
      return {
        ok: false,
        eventCount: events.length,
        reason: `REPLAY_STREAM_INVALID: event ${ev.id} is missing aggregate identity (aggregateId/aggregateVersion). Deterministic replay requires complete ordering metadata.`,
      };
    }
  }

  const sorted = [...toOrdered(events)].sort(compareOrdered);

  // Group by aggregate id.
  const byAggregate = new Map<string, OrderedEvent[]>();
  for (const ev of sorted) {
    const list = byAggregate.get(ev.aggregateId) ?? [];
    list.push(ev);
    byAggregate.set(ev.aggregateId, list);
  }

  for (const [aggregateId, stream] of byAggregate) {
    let expected = 1;
    for (const ev of stream) {
      if (ev.aggregateVersion !== expected) {
        const problem = ev.aggregateVersion < expected ? "duplicate" : "gap";
        return {
          ok: false,
          eventCount: events.length,
          reason: `REPLAY_STREAM_INVALID: ${problem} in aggregate ${aggregateId} at version ${ev.aggregateVersion} (expected ${expected}). Deterministic replay requires contiguous versions starting at 1.`,
        };
      }
      expected += 1;
    }
  }

  return { ok: true, eventCount: events.length };
}

/** Deterministic fingerprint of a replayed stream: aggregateId:version:eventId per line. */
export function hashReplayStream(events: OrchestrationEvent[]): string {
  const sorted = [...toOrdered(events)].sort(compareOrdered);
  const canonical = sorted.map((e) => `${e.aggregateId}:${e.aggregateVersion}:${e.id}`).join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export class ReplayService {
  constructor(
    private readonly replayRepo: IReplayRepository,
    private readonly eventBus: IEventBus,
    private readonly eventRepo?: IEventRepository,
  ) {}

  async createReplay(input: CreateReplayInput): Promise<Replay> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const replay: Replay = {
      id, sourceRunId: input.sourceRunId, status: ReplayStatus.PENDING,
      eventCount: 0, processedCount: 0, failedCount: 0,
      correlationId: input.correlationId, causationId: input.causationId,
      createdAt: now, updatedAt: now,
    };
    const saved = await this.replayRepo.create(replay);
    await this.eventBus.publish(createEvent(
      OrchestrationEventType.REPLAY_CREATED,
      {
        correlationId: input.correlationId,
        causationId: input.causationId,
        aggregateId: id,
        aggregateVersion: 1,
        runId: input.sourceRunId,
        data: { sourceRunId: input.sourceRunId },
      },
    ));
    return saved;
  }

  async getReplay(id: string): Promise<Replay> {
    const r = await this.replayRepo.findById(id);
    if (!r) throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);
    return r;
  }

  async listReplays(pagination: PagePaginationRequest): Promise<PaginatedResult<Replay>> {
    return this.replayRepo.findMany(pagination);
  }

  /**
   * Execute a deterministic replay of the source run's event stream.
   *
   * The stream is sourced from the replay's embedded events when provided,
   * otherwise from the configured event repository (events whose aggregate id
   * is the source run id). The stream is validated for version continuity and
   * a deterministic content hash is recorded in the result.
   *
   * @throws OrchestrationError(ENTITY_NOT_FOUND) if the replay does not exist.
   * @throws OrchestrationError(REPLAY_IN_PROGRESS) if the replay is already
   *         being executed by another caller.
   */
  async runReplay(id: string): Promise<Replay> {
    const existing = await this.replayRepo.findById(id);
    if (!existing) throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);

    if (existing.status === ReplayStatus.IN_PROGRESS) {
      throw OrchestrationError.fromCode(ErrorCodes.REPLAY_IN_PROGRESS, {
        message: `REPLAY_IN_PROGRESS: replay ${id} is already being executed`,
      });
    }

    const now = new Date().toISOString();
    await this.replayRepo.update(id, { status: ReplayStatus.IN_PROGRESS, updatedAt: now });
    await this.eventBus.publish(createEvent(
      OrchestrationEventType.REPLAY_STARTED,
      {
        correlationId: existing.correlationId,
        causationId: existing.causationId,
        aggregateId: existing.id,
        aggregateVersion: 2,
        runId: existing.sourceRunId,
        data: { sourceRunId: existing.sourceRunId },
      },
    ));

    // Resolve the source stream.
    let stream: OrchestrationEvent[] = existing.events ?? [];
    let streamSource = "provided";
    if (stream.length === 0) {
      if (!this.eventRepo) {
        return this.failReplay(
          existing,
          "REPLAY_STREAM_INVALID: no event source available — provide events at creation time or configure an event repository",
          now,
        );
      }
      stream = await this.eventRepo.findByRunId(existing.sourceRunId);
      streamSource = "event-repository";
    }

    const validation = validateReplayStream(stream);
    if (!validation.ok) {
      return this.failReplay(existing, validation.reason ?? "REPLAY_STREAM_INVALID", now);
    }

    const result: Record<string, unknown> = {
      sourceRunId: existing.sourceRunId,
      replayedEventCount: validation.eventCount,
      streamSource,
      streamHash: hashReplayStream(stream),
      eventIds: stream.map((e) => e.id),
      firstVersion: stream.length > 0 ? Math.min(...stream.map((e) => e.aggregateVersion ?? 0)) : 0,
      lastVersion: stream.length > 0 ? Math.max(...stream.map((e) => e.aggregateVersion ?? 0)) : 0,
    };

    const completed = await this.replayRepo.update(id, {
      status: ReplayStatus.COMPLETED,
      eventCount: validation.eventCount,
      processedCount: validation.eventCount,
      failedCount: 0,
      result,
      updatedAt: now,
      completedAt: now,
    });

    await this.eventBus.publish(createEvent(
      OrchestrationEventType.REPLAY_COMPLETED,
      {
        correlationId: existing.correlationId,
        causationId: existing.causationId,
        aggregateId: existing.id,
        aggregateVersion: 3,
        runId: existing.sourceRunId,
        data: result,
      },
    ));

    return completed ?? existing;
  }

  private async failReplay(existing: Replay, reason: string, now: string): Promise<Replay> {
    const failed = await this.replayRepo.update(existing.id, {
      status: ReplayStatus.FAILED,
      failedCount: 1,
      reason,
      result: { sourceRunId: existing.sourceRunId, reason },
      updatedAt: now,
      completedAt: now,
    });
    await this.eventBus.publish(createEvent(
      OrchestrationEventType.REPLAY_FAILED,
      {
        correlationId: existing.correlationId,
        causationId: existing.causationId,
        aggregateId: existing.id,
        aggregateVersion: 3,
        runId: existing.sourceRunId,
        data: { sourceRunId: existing.sourceRunId, reason },
      },
    ));
    return failed ?? existing;
  }
}
