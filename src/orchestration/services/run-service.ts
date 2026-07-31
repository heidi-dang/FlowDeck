import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import type { Run, CreateRunInput, UpdateRunInput, RunFilter } from "../types";
import { RunStatus, isTerminalRunStatus, OrchestrationError, ErrorCodes, OrchestrationEventType, assertNever } from "../types";
import { createEvent } from "../types/events";
import type { OrchestrationEvent } from "../types/events";
import type { OutboxEntry } from "../types/outbox";
import type { IRunRepository, IEventBus, PaginatedResult } from "./ports";
import type { PagePaginationRequest } from "../types/pagination";
import type { ExecutionRegistry } from "./execution-registry";
import type { UnitOfWork } from "../persistence/unit-of-work";
import type { TransactionalRunWriter } from "../persistence/transactional-run-writer";

export class RunService {
  constructor(
    private readonly runRepo: IRunRepository,
    private readonly eventBus: IEventBus,
    private readonly executionRegistry: ExecutionRegistry,
    private readonly unitOfWork: UnitOfWork,
    private readonly writer: TransactionalRunWriter,
    private readonly db: Database,
  ) {}

  async createRun(input: CreateRunInput, correlationId?: string): Promise<Run> {
    const now = new Date().toISOString();
    const runId = randomUUID();
    const corrId = correlationId ?? input.correlationId ?? randomUUID();

    // Canonicalize QUEUED to PENDING at the API boundary.
    // QUEUED is a deprecated input alias only — the domain and repository layers
    // receive and produce only PENDING for the initial non-terminal status.
    const canonicalStatus = RunStatus.PENDING;
    const run: Run = {
      id: runId,
      status: canonicalStatus,
      runType: input.runType,
      correlationId: corrId,
      causationId: input.causationId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      aggregateId: input.aggregateId,
      contractId: input.contractId,
      assignmentId: input.assignmentId,
      metadata: input.metadata ?? {},
      progressPercent: 0,
      stage: "queued",
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const event = createEvent(
      OrchestrationEventType.RUN_QUEUED,
      {
        correlationId: corrId,
        causationId: input.causationId,
        aggregateId: runId,
        aggregateVersion: 1,
        sessionId: input.sessionId,
        agentId: input.agentId,
        runId,
        data: { runType: input.runType },
      },
    );

    const outboxEntry: OutboxEntry = {
      id: randomUUID(),
      eventId: event.id,
      eventType: event.type,
      status: "pending" as const,
      correlationId: corrId,
      causationId: input.causationId,
      aggregateId: runId,
      attemptCount: 0,
      payload: event.data as Record<string, unknown>,
      retryCount: 0,
      maxRetries: 3,
      createdAt: now,
    };

    // Atomic: persist run, event, and outbox inside UnitOfWork transaction
    const saved = await this.unitOfWork.execute((ctx) => {
      return this.writer.createRunWithEventAndOutbox(ctx.tx, this.db, run, event, outboxEntry);
    });

    return saved;
  }

  async updateRun(id: string, input: UpdateRunInput): Promise<Run> {
    const existing = await this.runRepo.findById(id);
    if (!existing) {
      throw OrchestrationError.fromCode(ErrorCodes.RUN_NOT_FOUND, { message: `Run ${id} not found` });
    }

    if (input.status && isTerminalRunStatus(existing.status)) {
      throw OrchestrationError.fromCode(ErrorCodes.RUN_IN_TERMINAL_STATE, {
        message: `Run ${id} is in terminal state ${existing.status}`,
      });
    }

    const now = new Date().toISOString();

    // Build event + outbox for the status change
    let event: OrchestrationEvent | undefined;
    let outboxEntry: OutboxEntry | undefined;

    if (input.status) {
      const eventType = this.getStatusEventType(input.status);
      event = createEvent(
        eventType,
        {
          correlationId: existing.correlationId,
          causationId: existing.correlationId,
          aggregateId: id,
          aggregateVersion: undefined,
          sessionId: existing.sessionId,
          agentId: existing.agentId,
          runId: id,
          data: { previousStatus: existing.status, newStatus: input.status, stage: input.stage },
        },
      );

      outboxEntry = {
        id: randomUUID(),
        eventId: event.id,
        eventType: event.type,
        status: "pending" as const,
        correlationId: existing.correlationId,
        causationId: existing.correlationId,
        aggregateId: id,
        attemptCount: 0,
        payload: event.data as Record<string, unknown>,
        retryCount: 0,
        maxRetries: 3,
        createdAt: now,
      };
    }

    // Atomic: update run state, insert event, insert outbox inside transaction
    const updated = await this.unitOfWork.execute((ctx) => {
      if (event && outboxEntry) {
        return this.writer.updateRunState(ctx.tx, this.db, id, input, event, outboxEntry);
      }
      // No status change — just do a trivial update via the writer
      return this.writer.updateRunState(ctx.tx, this.db, id, input, createEvent(
        OrchestrationEventType.RUN_PROGRESS,
        {
          correlationId: existing.correlationId,
          causationId: existing.correlationId,
          aggregateId: id,
          sessionId: existing.sessionId,
          agentId: existing.agentId,
          runId: id,
          data: { stage: input.stage, progress: input.progress },
        },
      ), {
        id: randomUUID(),
        eventId: randomUUID(),
        eventType: OrchestrationEventType.RUN_PROGRESS,
        status: "pending" as const,
        correlationId: existing.correlationId,
        causationId: existing.correlationId,
        aggregateId: id,
        attemptCount: 0,
        payload: { stage: input.stage, progress: input.progress } as Record<string, unknown>,
        retryCount: 0,
        maxRetries: 3,
        createdAt: now,
      });
    });

    if (!updated) {
      throw OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR, { message: `Failed to update run ${id}` });
    }

    return updated;
  }

  async getRun(id: string): Promise<Run> {
    const run = await this.runRepo.findById(id);
    if (!run) {
      throw OrchestrationError.fromCode(ErrorCodes.RUN_NOT_FOUND, { message: `Run ${id} not found` });
    }
    return run;
  }

  async listRuns(filter: RunFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<Run>> {
    return this.runRepo.findMany(filter, pagination);
  }

  async cancelRun(id: string, reason?: string): Promise<Run> {
    const existing = await this.runRepo.findById(id);
    if (!existing) {
      throw OrchestrationError.fromCode(ErrorCodes.RUN_NOT_FOUND, { message: `Run ${id} not found` });
    }
    if (isTerminalRunStatus(existing.status)) {
      throw OrchestrationError.fromCode(ErrorCodes.RUN_IN_TERMINAL_STATE, {
        message: `Run ${id} is already in terminal state ${existing.status}`,
      });
    }

    // 1. Signal cancellation to active child execution & execute registered cleanup callbacks within bounded timeout
    await this.executionRegistry.cancelRunExecution(id, reason);

    // 2. Re-check status for completion-versus-cancellation races
    const latest = await this.runRepo.findById(id);
    if (latest && isTerminalRunStatus(latest.status) && latest.status !== RunStatus.CANCELLED) {
      return latest;
    }

    // 3. Update status to CANCELLED atomically — this goes through updateRun which uses the writer
    const cancelledRun = await this.updateRun(id, {
      status: RunStatus.CANCELLED,
      stage: "cancelled",
      errorMessage: reason,
      metadata: { cancelledAt: new Date().toISOString(), reason },
    });

    this.executionRegistry.unregisterRun(id);

    return cancelledRun;
  }

  async pauseRun(id: string): Promise<Run> {
    const existing = await this.runRepo.findById(id);
    if (!existing) {
      throw OrchestrationError.fromCode(ErrorCodes.RUN_NOT_FOUND, { message: `Run ${id} not found` });
    }
    if (existing.status !== RunStatus.RUNNING) {
      throw OrchestrationError.fromCode(ErrorCodes.RUN_IN_TERMINAL_STATE, {
        message: `Cannot pause run ${id} in state ${existing.status}`,
      });
    }
    return this.updateRun(id, { status: RunStatus.PAUSED, stage: "paused" });
  }

  /** Maps status → event type via exhaustive switch. Adding a new RunStatus triggers a compile-time error. */
  private getStatusEventType(status: string): string {
    switch (status) {
      case RunStatus.RUNNING: return OrchestrationEventType.RUN_STARTED;
      case RunStatus.COMPLETED: return OrchestrationEventType.RUN_COMPLETED;
      case RunStatus.FAILED: return OrchestrationEventType.RUN_FAILED;
      case RunStatus.CANCELLED: return OrchestrationEventType.RUN_CANCELLED;
      case RunStatus.PAUSED: return OrchestrationEventType.RUN_PAUSED;
      case RunStatus.QUEUED:
      case RunStatus.PENDING:
      case RunStatus.TIMEOUT:
      default:
        return assertNever(status as unknown as never, `Unhandled run status event mapping: ${status}`);
    }
  }
}