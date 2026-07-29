import { randomUUID } from "crypto";
import type { VerificationResult, VerificationFilter, Evidence, EvidenceDTO } from "../types";
import { VerificationStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import type { IVerificationRepository, IEventBus, PaginatedResult } from "./ports";
import type { PaginationRequestDTO } from "../types/pagination";

export class VerificationService {
  constructor(
    private readonly verificationRepo: IVerificationRepository,
    private readonly eventBus: IEventBus,
  ) {}

  async createVerification(input: {
    runId: string; assignmentId?: string; contractId?: string;
    checkType: string; correlationId: string; causationId?: string;
  }): Promise<VerificationResult> {
    const now = new Date().toISOString();
    const id = randomUUID();

    const verification: VerificationResult = {
      id, runId: input.runId, assignmentId: input.assignmentId,
      contractId: input.contractId, status: VerificationStatus.PENDING,
      checkType: input.checkType, result: "", evidenceIds: [],
      correlationId: input.correlationId, causationId: input.causationId,
      createdAt: now, updatedAt: now,
    };

    const saved = await this.verificationRepo.create(verification);

    await this.eventBus.publish({
      id: randomUUID(), type: OrchestrationEventType.VERIFICATION_STARTED,
      timestamp: now, correlationId: input.correlationId,
      causationId: input.causationId, runId: input.runId,
      assignmentId: input.assignmentId, contractId: input.contractId,
      data: { checkType: input.checkType }, metadata: {},
    });

    return saved;
  }

  async updateVerification(id: string, input: Partial<VerificationResult>): Promise<VerificationResult> {
    const existing = await this.verificationRepo.findById(id);
    if (!existing) throw OrchestrationError.fromCode(ErrorCodes.VERIFICATION_NOT_FOUND);

    const updated = await this.verificationRepo.update(id, input);
    if (!updated) throw OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR);

    if (input.status) {
      const eventType = input.status === VerificationStatus.PASSED
        ? OrchestrationEventType.VERIFICATION_COMPLETED
        : input.status === VerificationStatus.FAILED
          ? OrchestrationEventType.VERIFICATION_FAILED : null;
      if (eventType) {
        await this.eventBus.publish({
          id: randomUUID(), type: eventType, timestamp: new Date().toISOString(),
          correlationId: existing.correlationId, causationId: existing.correlationId,
          runId: existing.runId, assignmentId: existing.assignmentId,
          contractId: existing.contractId, data: { status: input.status, result: input.result },
          metadata: {},
        });
      }
    }
    return updated;
  }

  async getVerification(id: string): Promise<VerificationResult> {
    const v = await this.verificationRepo.findById(id);
    if (!v) throw OrchestrationError.fromCode(ErrorCodes.VERIFICATION_NOT_FOUND);
    return v;
  }

  async listVerifications(filter: VerificationFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<VerificationResult>> {
    return this.verificationRepo.findMany(filter, pagination);
  }
}
