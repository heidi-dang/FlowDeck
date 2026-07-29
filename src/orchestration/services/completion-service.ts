import { randomUUID } from "crypto";
import type { Completion, CreateCompletionInput, UpdateCompletionInput } from "../types";
import { CompletionStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
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
    await this.eventBus.publish({
      id: randomUUID(), type: OrchestrationEventType.COMPLETION_STARTED,
      timestamp: now, correlationId: input.correlationId,
      causationId: input.causationId, runId: input.runId,
      data: {}, metadata: {},
    });
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

  async completeRun(id: string, summary: string, outcome: "success" | "failure" | "partial"): Promise<Completion> {
    const now = new Date().toISOString();
    const updated = await this.completionRepo.update(id, {
      status: CompletionStatus.COMPLETED, summary, outcome,
      completedAt: now,
    });
    if (!updated) throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);

    await this.eventBus.publish({
      id: randomUUID(), type: OrchestrationEventType.COMPLETION_COMPLETED,
      timestamp: now, correlationId: updated.correlationId,
      causationId: updated.correlationId, runId: updated.runId,
      data: { outcome, summary }, metadata: {},
    });
    return updated;
  }
}
