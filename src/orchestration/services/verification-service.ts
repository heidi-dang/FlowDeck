import { randomUUID } from "crypto";
import type { VerificationResult, VerificationFilter } from "../types";
import { VerificationStatus, OrchestrationError, ErrorCodes, OrchestrationEventType, assertNever } from "../types";
import { createEvent } from "../types/events";
import type { IVerificationRepository, IEventBus, PaginatedResult } from "./ports";
import type { PagePaginationRequest } from "../types/pagination";

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

    await this.eventBus.publish(createEvent(
      OrchestrationEventType.VERIFICATION_STARTED,
      {
        correlationId: input.correlationId,
        causationId: input.causationId,
        aggregateId: id,
        aggregateVersion: 1,
        runId: input.runId,
        assignmentId: input.assignmentId,
        contractId: input.contractId,
        data: { checkType: input.checkType },
      },
    ));

    return saved;
  }

  async updateVerification(id: string, input: Partial<VerificationResult>): Promise<VerificationResult> {
    const existing = await this.verificationRepo.findById(id);
    if (!existing) throw OrchestrationError.fromCode(ErrorCodes.VERIFICATION_NOT_FOUND);

    const updated = await this.verificationRepo.update(id, input);
    if (!updated) throw OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR);

    if (input.status) {
      const eventType = this.getStatusEvent(input.status);
      await this.eventBus.publish(createEvent(
        eventType,
        {
          correlationId: existing.correlationId,
          causationId: existing.correlationId,
          aggregateId: id,
          runId: existing.runId,
          assignmentId: existing.assignmentId,
          contractId: existing.contractId,
          data: { status: input.status, result: input.result },
        },
      ));
    }
    return updated;
  }

  async getVerification(id: string): Promise<VerificationResult> {
    const v = await this.verificationRepo.findById(id);
    if (!v) throw OrchestrationError.fromCode(ErrorCodes.VERIFICATION_NOT_FOUND);
    return v;
  }

  async listVerifications(filter: VerificationFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<VerificationResult>> {
    return this.verificationRepo.findMany(filter, pagination);
  }

  /** Exhaustive verification status → event mapping. */
  private getStatusEvent(status: string): string {
    switch (status) {
      case VerificationStatus.PASSED: return OrchestrationEventType.VERIFICATION_COMPLETED;
      case VerificationStatus.FAILED: return OrchestrationEventType.VERIFICATION_FAILED;
      case VerificationStatus.PENDING:
      case VerificationStatus.IN_PROGRESS:
      case VerificationStatus.SKIPPED:
      case VerificationStatus.ERROR:
        return OrchestrationEventType.VERIFICATION_CREATED;
      default:
        return assertNever(status as unknown as never, `Unhandled verification status event mapping: ${status}`);
    }
  }
}
