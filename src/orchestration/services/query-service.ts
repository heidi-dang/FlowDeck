import type {
  Run, RunFilter, Contract, ContractFilter, Assignment, AssignmentFilter,
  VerificationResult, VerificationFilter, Evidence, OrchestrationEvent, EventFilter,
  OutboxEntry, OutboxFilter,
} from "../types";
import { OutboxStatus, OrchestrationError, ErrorCodes } from "../types";
import type {
  IRunRepository, IContractRepository, IAssignmentRepository,
  IVerificationRepository, IEventRepository, IOutboxRepository,
} from "./ports";
import type { PagePaginationRequest, CursorPaginationResponse } from "../types/pagination";
import { toCursorResponse } from "./ports";

export class QueryService {
  constructor(
    private readonly runRepo: IRunRepository,
    private readonly contractRepo: IContractRepository,
    private readonly assignmentRepo: IAssignmentRepository,
    private readonly verificationRepo: IVerificationRepository,
    private readonly eventRepo: IEventRepository,
    private readonly outboxRepo: IOutboxRepository,
  ) {}

  // ── Run queries ─────────────────────────────────────────────────────────

  async listRuns(filter: RunFilter, pagination: PagePaginationRequest): Promise<CursorPaginationResponse<Run>> {
    const result = await this.runRepo.findMany(filter, pagination);
    return toCursorResponse(result);
  }

  async getRun(id: string): Promise<Run> {
    const run = await this.runRepo.findById(id);
    if (!run) throw OrchestrationError.fromCode(ErrorCodes.RUN_NOT_FOUND);
    return run;
  }

  // ── Contract queries ────────────────────────────────────────────────────

  async listContracts(filter: ContractFilter, pagination: PagePaginationRequest): Promise<CursorPaginationResponse<Contract>> {
    const result = await this.contractRepo.findMany(filter, pagination);
    return toCursorResponse(result);
  }

  async getContract(id: string): Promise<Contract> {
    const c = await this.contractRepo.findById(id);
    if (!c) throw OrchestrationError.fromCode(ErrorCodes.CONTRACT_NOT_FOUND);
    return c;
  }

  // ── Assignment queries ──────────────────────────────────────────────────

  async listAssignments(filter: AssignmentFilter, pagination: PagePaginationRequest): Promise<CursorPaginationResponse<Assignment>> {
    const result = await this.assignmentRepo.findMany(filter, pagination);
    return toCursorResponse(result);
  }

  async getAssignment(id: string): Promise<Assignment> {
    const a = await this.assignmentRepo.findById(id);
    if (!a) throw OrchestrationError.fromCode(ErrorCodes.ASSIGNMENT_NOT_FOUND);
    return a;
  }

  // ── Verification queries ────────────────────────────────────────────────

  async listVerifications(filter: VerificationFilter, pagination: PagePaginationRequest): Promise<CursorPaginationResponse<VerificationResult>> {
    const result = await this.verificationRepo.findMany(filter, pagination);
    return toCursorResponse(result);
  }

  async getVerification(id: string): Promise<VerificationResult> {
    const v = await this.verificationRepo.findById(id);
    if (!v) throw OrchestrationError.fromCode(ErrorCodes.VERIFICATION_NOT_FOUND);
    return v;
  }

  async listEvidence(_filter: VerificationFilter): Promise<Evidence[]> {
    return []; // Placeholder - depends on evidence repo
  }

  async getEvidence(_id: string): Promise<Evidence> {
    throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);
  }

  // ── Event queries ───────────────────────────────────────────────────────

  async listEvents(filter: EventFilter, pagination: PagePaginationRequest): Promise<CursorPaginationResponse<OrchestrationEvent>> {
    const result = await this.eventRepo.findMany(filter, pagination);
    return toCursorResponse(result);
  }

  async getEvent(id: string): Promise<OrchestrationEvent> {
    const ev = await this.eventRepo.findById(id);
    if (!ev) throw OrchestrationError.fromCode(ErrorCodes.EVENT_NOT_FOUND);
    return ev;
  }

  // ── Outbox queries ──────────────────────────────────────────────────────

  async listOutboxEntries(filter: OutboxFilter, pagination: PagePaginationRequest): Promise<CursorPaginationResponse<OutboxEntry>> {
    const result = await this.outboxRepo.findMany(filter, pagination);
    return toCursorResponse(result);
  }

  async getOutboxEntry(id: string): Promise<OutboxEntry> {
    const entry = await this.outboxRepo.findById(id);
    if (!entry) throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);
    return entry;
  }

  async getDeliveryStatus(_runId: string): Promise<{ delivered: number; pending: number; failed: number }> {
    const pending = await this.outboxRepo.count({ status: OutboxStatus.PENDING });
    const delivered = await this.outboxRepo.count({ status: OutboxStatus.DELIVERED });
    const failed = await this.outboxRepo.count({ status: OutboxStatus.FAILED });
    return { delivered, pending, failed };
  }
}
