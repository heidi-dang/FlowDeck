import type {
  Run, UpdateRunInput, RunFilter,
  Contract, UpdateContractInput, ContractFilter,
  Assignment, UpdateAssignmentInput, AssignmentFilter,
  VerificationResult, VerificationFilter,
  Completion, UpdateCompletionInput,
  Replay,
  OrchestrationEvent, EventFilter,
  OutboxEntry, OutboxFilter,
  PagePaginationRequest,
} from "../types";
import type { OrchestrationEventType } from "../types/events";
import type { CursorPaginationResponse } from "../types/pagination";

// ── Paginated result (internal — page-based) ──────────────────────────────

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Convert an internal PagePaginationRequest + PaginatedResult into a
 * cursor-based API response. Uses page number as the cursor token.
 */
export function toCursorResponse<T>(result: PaginatedResult<T>): CursorPaginationResponse<T> {
  const hasMore = result.page * result.limit < result.total;
  return {
    items: result.items,
    nextCursor: hasMore ? String(result.page + 1) : null,
    hasMore,
  };
}

// ── Run repository ────────────────────────────────────────────────────────

export interface IRunRepository {
  create(run: Run): Promise<Run>;
  update(id: string, input: UpdateRunInput): Promise<Run | null>;
  findById(id: string): Promise<Run | null>;
  findMany(filter: RunFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<Run>>;
  count(filter: RunFilter): Promise<number>;
}

// ── Contract repository ───────────────────────────────────────────────────

export interface IContractRepository {
  create(contract: Contract): Promise<Contract>;
  update(id: string, input: UpdateContractInput): Promise<Contract | null>;
  findById(id: string): Promise<Contract | null>;
  findMany(filter: ContractFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<Contract>>;
  count(filter: ContractFilter): Promise<number>;
}

// ── Assignment repository ─────────────────────────────────────────────────

export interface IAssignmentRepository {
  create(assignment: Assignment): Promise<Assignment>;
  update(id: string, input: UpdateAssignmentInput): Promise<Assignment | null>;
  findById(id: string): Promise<Assignment | null>;
  findMany(filter: AssignmentFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<Assignment>>;
  count(filter: AssignmentFilter): Promise<number>;
}

// ── Verification repository ───────────────────────────────────────────────

export interface IVerificationRepository {
  create(verification: VerificationResult): Promise<VerificationResult>;
  update(id: string, input: Partial<VerificationResult>): Promise<VerificationResult | null>;
  findById(id: string): Promise<VerificationResult | null>;
  findMany(filter: VerificationFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<VerificationResult>>;
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
  findMany(filter: EventFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<OrchestrationEvent>>;
  count(filter: EventFilter): Promise<number>;
  findByRunId(runId: string): Promise<OrchestrationEvent[]>;
}

// ── Outbox repository ─────────────────────────────────────────────────────

export interface IOutboxRepository {
  create(entry: OutboxEntry): Promise<OutboxEntry>;
  update(id: string, input: Partial<OutboxEntry>): Promise<OutboxEntry | null>;
  findById(id: string): Promise<OutboxEntry | null>;
  findMany(filter: OutboxFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<OutboxEntry>>;
  findPending(): Promise<OutboxEntry[]>;
  count(filter: OutboxFilter): Promise<number>;

  /** Atomically claim a batch of pending entries for processing */
  claimNextBatch(batchSize: number): Promise<OutboxEntry[]>;

  /** Mark an entry as delivered with idempotency key check */
  markDelivered(id: string, idempotencyKey: string): Promise<void>;

  /** Mark an entry as failed with error details */
  markFailed(id: string, attemptCount: number, lastError: string): Promise<void>;
}

// ── Durable delivery sink ─────────────────────────────────────────────────
// Single, idempotent, lease-based delivery path for outbox entries. The
// OutboxWorker uses this exclusively; the sink owns claiming, lease expiry,
// idempotent delivery and retry/failure accounting.

export type DeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export interface DeliveryLease {
  workerId: string;
  leaseUntil: number;
}

export interface DeliveryRecord {
  id: string;
  eventId: string;
  eventType: string;
  destination?: string;
  payload: Record<string, unknown>;
  correlationId: string;
  causationId?: string;
  aggregateId?: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxRetries: number;
  lastError?: string;
  idempotencyKey?: string;
  lease?: DeliveryLease | null;
  createdAt: string;
  updatedAt: string;
}

export interface IDeliverySink {
  /** Atomically claim up to batchSize due entries (pending or expired lease) for delivery. */
  claimDue(workerId: string, batchSize: number, leaseSeconds: number): Promise<DeliveryRecord[]>;
  /** Idempotently mark a claimed entry delivered. False when already delivered by another worker. */
  markDelivered(id: string, idempotencyKey?: string): Promise<boolean>;
  /** Record a failed attempt; requeues to pending until maxRetries, then transitions to failed. */
  markFailed(id: string, attemptCount: number, lastError: string, maxRetries: number): Promise<void>;
  /** Requeue entries whose delivery lease expired (crash recovery). Returns requeued count. */
  requeueExpiredLeases(nowSeconds?: number): Promise<number>;
  /** Count entries in a given status (monitoring). */
  countByStatus(status: DeliveryStatus): Promise<number>;
}

// ── Replay repository ─────────────────────────────────────────────────────

export interface IReplayRepository {
  create(replay: Replay): Promise<Replay>;
  update(id: string, patch: Partial<Replay>): Promise<Replay | null>;
  findById(id: string): Promise<Replay | null>;
  findMany(pagination: PagePaginationRequest): Promise<PaginatedResult<Replay>>;
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
