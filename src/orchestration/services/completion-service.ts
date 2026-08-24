import { randomUUID } from "crypto";
import type { Completion, CreateCompletionInput, UpdateCompletionInput } from "../types";
import { CompletionStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import { createEvent } from "../types/events";
import type { ICompletionRepository, IEventBus } from "./ports";

export class CompletionService {
  constructor(
    private readonly completionRepo: ICompletionRepository,
    private readonly eventBus: IEventBus,
  ) {}

  async createCompletion(input: CreateCompletionInput): Promise<Completion> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const completion: Completion = {
      id, runId: input.runId, status: CompletionStatus.PENDING,
      summary: "", outcome: "success", assignmentResults: [],
      correlationId: input.correlationId, causationId: input.causationId,
      createdAt: now, updatedAt: now,
    };
    const saved = await this.completionRepo.create(completion);
    await this.eventBus.publish(createEvent(
      OrchestrationEventType.COMPLETION_STARTED,
      {
        correlationId: input.correlationId,
        causationId: input.causationId,
        aggregateId: id,
        aggregateVersion: 1,
        runId: input.runId,
        data: {},
      },
    ));
    return saved;
  }

  async updateCompletion(id: string, input: UpdateCompletionInput): Promise<Completion> {
    const existing = await this.completionRepo.findById(id);
    if (!existing) throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);
    const updated = await this.completionRepo.update(id, input);
    if (!updated) throw OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR);
    return updated;
  }

  async getCompletion(id: string): Promise<Completion> {
    const c = await this.completionRepo.findById(id);
    if (!c) throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);
    return c;
  }

  /**
   * Kept only as an explicit compatibility rejection for the legacy endpoint.
   * CompletionPolicy owns the Run phase transition and durable review/event
   * record; arbitrary summaries and outcomes can never finalize a Run.
   */
  async completeRun(_id: string, _summary: string, _outcome: "success" | "failure" | "partial"): Promise<Completion> {
    throw OrchestrationError.fromCode(ErrorCodes.COMPLETION_POLICY_REQUIRED, {
      message: "Run completion is exclusively authorized by CompletionPolicy after durable state-bound verification.",
    });
  }
}
