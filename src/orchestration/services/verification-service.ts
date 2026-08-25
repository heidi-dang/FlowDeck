import { createHash, randomUUID } from "crypto";
import type { VerificationResult, VerificationFilter } from "../types";
import { VerificationStatus, OrchestrationError, ErrorCodes, OrchestrationEventType, assertNever } from "../types";
import { createEvent } from "../types/events";
import type { IVerificationRepository, IEventBus, PaginatedResult } from "./ports";
import type { PagePaginationRequest } from "../types/pagination";
import type { FdxCapabilitySnapshot, FdxChangeIntelligence, FdxVerificationBlocker } from "../../services/fdx-vci-adapter";
import { runFdxVerification, type FdxVerificationSession } from "../verification/fdx-verification-provider";

export interface LiveVerificationRequest {
  runId: string;
  stateVersion: number;
  stateFingerprint: string;
  checkType: string;
  correlationId: string;
  causationId?: string;
  targetSha?: string;
  evidenceIds: string[];
}

export interface LiveVerificationEvaluation {
  requiredChecksComplete: boolean;
  requiredChecksPassed: boolean;
  evidenceIds: string[];
  failureReasons: string[];
}

export class VerificationService {
  constructor(
    private readonly verificationRepo: IVerificationRepository,
    private readonly eventBus: IEventBus,
  ) {}

  async createVerification(input: {
    id?: string;
    runId: string; assignmentId?: string; contractId?: string;
    checkType: string; correlationId: string; causationId?: string;
    stateVersion?: number; stateFingerprint?: string; targetSha?: string;
    evidenceIds?: string[]; failureReasons?: string[];
  }): Promise<VerificationResult> {
    const now = new Date().toISOString();
    const verification: VerificationResult = {
      id: input.id ?? randomUUID(),
      runId: input.runId,
      assignmentId: input.assignmentId,
      contractId: input.contractId,
      status: VerificationStatus.PENDING,
      checkType: input.checkType,
      result: "",
      evidenceIds: input.evidenceIds ?? [],
      failureReasons: input.failureReasons ?? [],
      correlationId: input.correlationId,
      causationId: input.causationId,
      stateVersion: input.stateVersion,
      stateFingerprint: input.stateFingerprint,
      targetSha: input.targetSha,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await this.verificationRepo.create(verification);
    // A create-or-get collision is a replay of a prior durable request, not a new start.
    if (saved.id === verification.id) {
      await this.eventBus.publish(createEvent(
        OrchestrationEventType.VERIFICATION_STARTED,
        {
          correlationId: input.correlationId,
          causationId: input.causationId,
          aggregateId: saved.id,
          aggregateVersion: input.stateVersion ?? 1,
          runId: input.runId,
          assignmentId: input.assignmentId,
          contractId: input.contractId,
          data: { checkType: input.checkType, stateFingerprint: input.stateFingerprint },
        },
      ));
    }

    return saved;
  }

  /**
   * Request authoritative FDX VCI verification through the full production pipeline:
   * VerificationService -> FdxVerificationProvider -> FDX Adapter -> native FDX -> M8 evidence -> CompletionPolicy
   */
  async requestFdxVerification(
    runId: string,
    changeIntelligence: FdxChangeIntelligence,
    capabilities: FdxCapabilitySnapshot,
    options: {
      correlationId?: string;
      causationId?: string;
      checkType?: string;
      policyOverlay?: boolean;
      failFast?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {}
  ): Promise<{
    result: VerificationResult;
    session: FdxVerificationSession;
    blockers: FdxVerificationBlocker[];
  }> {
    const checkType = options.checkType ?? "live_orchestration";
    const correlationId = options.correlationId ?? randomUUID();
    const liveReq: LiveVerificationRequest = {
      runId,
      stateVersion: changeIntelligence.stateVersion,
      stateFingerprint: changeIntelligence.stateFingerprint,
      checkType,
      correlationId,
      causationId: options.causationId,
      targetSha: changeIntelligence.headSha,
      evidenceIds: [],
    };

    const pendingResult = await this.requestLiveVerification(liveReq);

    const { result, session, blockers } = await runFdxVerification(
      runId,
      changeIntelligence,
      capabilities,
      {
        ...options,
        correlationId,
        causationId: options.causationId,
        checkType,
      }
    );

    const updated = await this.updateVerification(pendingResult.id, {
      status: result.status,
      result: result.result,
      evidenceIds: result.evidenceIds,
      failureReasons: result.failureReasons,
      metadata: result.metadata,
    });

    return {
      result: updated,
      session,
      blockers,
    };
  }

  /**
   * Creates exactly one durable request for a Run state. The state identity is persisted
   * by the repository, so retries and restart recovery cannot create another request.
   */
  async requestLiveVerification(input: LiveVerificationRequest): Promise<VerificationResult> {
    const existing = await this.verificationRepo.findByLiveIdentity(
      input.runId,
      input.stateVersion,
      input.stateFingerprint,
      input.checkType,
    );
    if (existing) return existing;

    const identity = this.liveIdentity(input);
    return this.createVerification({
      id: identity,
      runId: input.runId,
      checkType: input.checkType,
      correlationId: input.correlationId,
      causationId: input.causationId,
      stateVersion: input.stateVersion,
      stateFingerprint: input.stateFingerprint,
      targetSha: input.targetSha,
      evidenceIds: [...new Set(input.evidenceIds)].sort(),
    });
  }

  /**
   * Evaluates only durable evidence references captured by the request. A caller must
   * revalidate the request's state fingerprint immediately before applying this result.
   */
  async evaluateLiveVerification(id: string, evaluation: LiveVerificationEvaluation): Promise<VerificationResult> {
    const existing = await this.getVerification(id);
    if (existing.isStale || existing.status === VerificationStatus.PASSED || existing.status === VerificationStatus.FAILED) {
      return existing;
    }

    const evidenceIds = [...new Set(evaluation.evidenceIds)].sort();
    const failureReasons = [...new Set(evaluation.failureReasons)];
    if (evidenceIds.length === 0) failureReasons.push("NO_DURABLE_EVIDENCE");
    if (!evaluation.requiredChecksComplete) failureReasons.push("REQUIRED_CHECKS_INCOMPLETE");
    if (!evaluation.requiredChecksPassed) failureReasons.push("REQUIRED_CHECKS_FAILED");

    const passed = failureReasons.length === 0;
    const status = passed ? VerificationStatus.PASSED : VerificationStatus.FAILED;
    const result = passed
      ? "Live verification passed from persisted evidence."
      : `Live verification failed: ${failureReasons.join(", ")}`;

    return this.updateVerification(id, {
      status,
      result,
      evidenceIds,
      failureReasons,
      error: passed ? undefined : failureReasons.join(", "),
    });
  }

  async markLiveVerificationStale(id: string, reason: string): Promise<VerificationResult> {
    const existing = await this.getVerification(id);
    if (existing.isStale) return existing;
    return this.updateVerification(id, {
      isStale: true,
      error: reason,
      failureReasons: [...new Set([...(existing.failureReasons ?? []), reason])],
    });
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
          causationId: existing.causationId ?? existing.correlationId,
          aggregateId: id,
          aggregateVersion: existing.stateVersion ?? 1,
          runId: existing.runId,
          assignmentId: existing.assignmentId,
          contractId: existing.contractId,
          data: {
            status: input.status,
            result: input.result,
            stateVersion: existing.stateVersion,
            stateFingerprint: existing.stateFingerprint,
            evidenceIds: input.evidenceIds,
            failureReasons: input.failureReasons,
          },
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

  private liveIdentity(input: LiveVerificationRequest): string {
    const semanticIdentity = `verification:${input.runId}:${input.stateVersion}:${input.stateFingerprint}:${input.checkType}`;
    return `live-verification-${createHash("sha256").update(semanticIdentity).digest("hex")}`;
  }

  /** Exhaustive verification status → event mapping. */
  private getStatusEvent(status: string): string {
    switch (status) {
      case VerificationStatus.PASSED: return OrchestrationEventType.VERIFICATION_PASSED;
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
