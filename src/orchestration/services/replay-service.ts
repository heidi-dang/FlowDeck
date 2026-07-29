import { randomUUID } from "crypto";
import type { Replay, CreateReplayInput } from "../types";
import { ReplayStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import { createEvent } from "../types/events";
import type { IReplayRepository, IEventBus, PaginatedResult } from "./ports";
import type { PagePaginationRequest } from "../types/pagination";

export class ReplayService {
  constructor(
    private readonly replayRepo: IReplayRepository,
    private readonly eventBus: IEventBus,
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
      OrchestrationEventType.REPLAY_STARTED,
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
}
