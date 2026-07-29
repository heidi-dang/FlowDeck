import type {
  Run, CreateRunInput, UpdateRunInput, RunFilter, RunDTO,
  Contract, CreateContractInput, UpdateContractInput, ContractFilter, ContractDTO,
  Assignment, CreateAssignmentInput, UpdateAssignmentInput, AssignmentFilter, AssignmentDTO,
  VerificationResult, VerificationFilter, VerificationResultDTO,
  Evidence, EvidenceDTO,
  Completion, CreateCompletionInput, UpdateCompletionInput, CompletionDTO,
  Replay, CreateReplayInput, ReplayDTO,
  OrchestrationEvent, EventFilter, OrchestrationEventDTO,
  OutboxEntry, OutboxFilter, OutboxEntryDTO,
  PaginationRequestDTO,
} from "../types";
import type { OrchestrationEventType } from "../types/events";

// ── Paginated result ──────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

// ── Run repository ────────────────────────────────────────────────────────

export interface IRunRepository {
  create(run: Run): Promise<Run>;
  update(id: string, input: UpdateRunInput): Promise<Run | null>;
  findById(id: string): Promise<Run | null>;
  findMany(filter: RunFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Run>>;
  count(filter: RunFilter): Promise<number>;
}

// ── Contract repository ───────────────────────────────────────────────────

export interface IContractRepository {
  create(contract: Contract): Promise<Contract>;
  update(id: string, input: UpdateContractInput): Promise<Contract | null>;
  findById(id: string): Promise<Contract | null>;
  findMany(filter: ContractFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Contract>>;
  count(filter: ContractFilter): Promise<number>;
}

// ── Assignment repository ─────────────────────────────────────────────────

export interface IAssignmentRepository {
  create(assignment: Assignment): Promise<Assignment>;
  update(id: string, input: UpdateAssignmentInput): Promise<Assignment | null>;
  findById(id: string): Promise<Assignment | null>;
  findMany(filter: AssignmentFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Assignment>>;
  count(filter: AssignmentFilter): Promise<number>;
}

// ── Verification repository ───────────────────────────────────────────────

export interface IVerificationRepository {
  create(verification: VerificationResult): Promise<VerificationResult>;
  update(id: string, input: Partial<VerificationResult>): Promise<VerificationResult | null>;
  findById(id: string): Promise<VerificationResult | null>;
  findMany(filter: VerificationFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<VerificationResult>>;
  count(filter: VerificationFilter): Promise<number>;
  findByRunId(runId: string): Promise<VerificationResult[]>;
}

// ── Completion repository ─────────────────────────────────────────────────

export interface ICompletionRepository {
  create(completion: Completion): Promise<Completion>;
  update(id: string, input: UpdateCompletionInput): Promise<Completion | null>;
  findById(id: string): Promise<Completion | null>;
  findByRunId(runId: string): Promise<Completion | null>;
}

// ── Event repository ──────────────────────────────────────────────────────

export interface IEventRepository {
  store(event: OrchestrationEvent): Promise<OrchestrationEvent>;
  findById(id: string): Promise<OrchestrationEvent | null>;
  findMany(filter: EventFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<OrchestrationEvent>>;
  count(filter: EventFilter): Promise<number>;
  findByRunId(runId: string): Promise<OrchestrationEvent[]>;
}

// ── Outbox repository ─────────────────────────────────────────────────────

export interface IOutboxRepository {
  create(entry: OutboxEntry): Promise<OutboxEntry>;
  update(id: string, input: Partial<OutboxEntry>): Promise<OutboxEntry | null>;
  findById(id: string): Promise<OutboxEntry | null>;
  findMany(filter: OutboxFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<OutboxEntry>>;
  findPending(): Promise<OutboxEntry[]>;
  count(filter: OutboxFilter): Promise<number>;
}

// ── Replay repository ─────────────────────────────────────────────────────

export interface IReplayRepository {
  create(replay: Replay): Promise<Replay>;
  findById(id: string): Promise<Replay | null>;
  findMany(pagination: PaginationRequestDTO): Promise<PaginatedResult<Replay>>;
  count(): Promise<number>;
}

// ── Idempotency store ─────────────────────────────────────────────────────

export interface IIdempotencyStore {
  isDuplicate(key: string): Promise<boolean>;
  markProcessed(key: string, ttlMs?: number): Promise<void>;
  getResult(key: string): Promise<Record<string, unknown> | null>;
}

// ── Authorization service ─────────────────────────────────────────────────

export interface IAuthorizationService {
  authorize(action: string, resource: string, context: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }>;
}

// ── Event bus ─────────────────────────────────────────────────────────────

export type EventHandler = (event: OrchestrationEvent) => void | Promise<void>;

export interface IEventBus {
  publish(event: OrchestrationEvent): Promise<void>;
  subscribe(type: OrchestrationEventType | string, handler: EventHandler): () => void;
  subscribeAll(handler: EventHandler): () => void;
  getSubscriberCount(): number;
}
