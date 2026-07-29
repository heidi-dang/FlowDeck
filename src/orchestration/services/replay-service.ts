import { randomUUID } from "crypto";
import type { Replay, CreateReplayInput } from "../types";
import { ReplayStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import type { IReplayRepository, IEventBus, PaginatedResult } from "./ports";
import type { PaginationRequestDTO } from "../types/pagination";

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
    await this.eventBus.publish({
      id: randomUUID(), type: OrchestrationEventType.REPLAY_STARTED,
      timestamp: now, correlationId: input.correlationId,
      causationId: input.causationId, data: { sourceRunId: input.sourceRunId },
      metadata: {},
    });
    return saved;
  }

  async getReplay(id: string): Promise<Replay> {
    const r = await this.replayRepo.findById(id);
    if (!r) throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);
    return r;
  }

  async listReplays(pagination: PaginationRequestDTO): Promise<PaginatedResult<Replay>> {
    return this.replayRepo.findMany(pagination);
  }
}
