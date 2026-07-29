import type {
  Run, RunFilter, Contract, ContractFilter, Assignment, AssignmentFilter,
  VerificationResult, VerificationFilter, Evidence, OrchestrationEvent, EventFilter,
  OutboxEntry, OutboxFilter,
} from "../types";
import { OrchestrationError, ErrorCodes } from "../types";
import type {
  IRunRepository, IContractRepository, IAssignmentRepository,
  IVerificationRepository, IEventRepository, IOutboxRepository,
  PaginatedResult,
} from "./ports";
import type { PaginationRequestDTO } from "../types/pagination";

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

  async listRuns(filter: RunFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Run>> {
    return this.runRepo.findMany(filter, pagination);
  }

  async getRun(id: string): Promise<Run> {
    const run = await this.runRepo.findById(id);
    if (!run) throw OrchestrationError.fromCode(ErrorCodes.RUN_NOT_FOUND);
    return run;
  }

  // ── Contract queries ────────────────────────────────────────────────────

  async listContracts(filter: ContractFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Contract>> {
    return this.contractRepo.findMany(filter, pagination);
  }

  async getContract(id: string): Promise<Contract> {
    const c = await this.contractRepo.findById(id);
    if (!c) throw OrchestrationError.fromCode(ErrorCodes.CONTRACT_NOT_FOUND);
    return c;
  }

  // ── Assignment queries ──────────────────────────────────────────────────

  async listAssignments(filter: AssignmentFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Assignment>> {
    return this.assignmentRepo.findMany(filter, pagination);
  }

  async getAssignment(id: string): Promise<Assignment> {
    const a = await this.assignmentRepo.findById(id);
    if (!a) throw OrchestrationError.fromCode(ErrorCodes.ASSIGNMENT_NOT_FOUND);
    return a;
  }

  // ── Verification queries ────────────────────────────────────────────────

  async listVerifications(filter: VerificationFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<VerificationResult>> {
    return this.verificationRepo.findMany(filter, pagination);
  }

  async getVerification(id: string): Promise<VerificationResult> {
    const v = await this.verificationRepo.findById(id);
    if (!v) throw OrchestrationError.fromCode(ErrorCodes.VERIFICATION_NOT_FOUND);
    return v;
  }

  async listEvidence(filter: VerificationFilter): Promise<Evidence[]> {
    return []; // Placeholder - depends on evidence repo
  }

  async getEvidence(id: string): Promise<Evidence> {
    throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);
  }

  // ── Event queries ───────────────────────────────────────────────────────

  async listEvents(filter: EventFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<OrchestrationEvent>> {
    return this.eventRepo.findMany(filter, pagination);
  }

  async getEvent(id: string): Promise<OrchestrationEvent> {
    const ev = await this.eventRepo.findById(id);
    if (!ev) throw OrchestrationError.fromCode(ErrorCodes.EVENT_NOT_FOUND);
    return ev;
  }

  // ── Outbox queries ──────────────────────────────────────────────────────

  async listOutboxEntries(filter: OutboxFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<OutboxEntry>> {
    return this.outboxRepo.findMany(filter, pagination);
  }

  async getOutboxEntry(id: string): Promise<OutboxEntry> {
    const entry = await this.outboxRepo.findById(id);
    if (!entry) throw OrchestrationError.fromCode(ErrorCodes.ENTITY_NOT_FOUND);
    return entry;
  }

  async getDeliveryStatus(runId: string): Promise<{ delivered: number; pending: number; failed: number }> {
    const pending = await this.outboxRepo.count({ status: "pending" as any });
    const published = await this.outboxRepo.count({ status: "published" as any });
    const failed = await this.outboxRepo.count({ status: "failed" as any });
    return { delivered: published, pending, failed };
  }
}
