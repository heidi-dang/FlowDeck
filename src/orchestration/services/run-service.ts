import { randomUUID } from "crypto";
import type { Run, CreateRunInput, UpdateRunInput, RunFilter } from "../types";
import { RunStatus, isTerminalRunStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import type { IRunRepository, IEventBus, PaginatedResult } from "./ports";
import type { PaginationRequestDTO } from "../types/pagination";

export class RunService {
  constructor(
    private readonly runRepo: IRunRepository,
    private readonly eventBus: IEventBus,
  ) {}

  async createRun(input: CreateRunInput, correlationId?: string): Promise<Run> {
    const now = new Date().toISOString();
    const runId = randomUUID();
    const corrId = correlationId ?? randomUUID();

    const run: Run = {
      id: runId,
      status: RunStatus.QUEUED,
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

    const saved = await this.runRepo.create(run);

    await this.eventBus.publish({
      id: randomUUID(),
      type: OrchestrationEventType.RUN_QUEUED,
      timestamp: now,
      correlationId: corrId,
      causationId: input.causationId,
      runId: runId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      aggregateId: input.aggregateId,
      data: { runType: input.runType },
      metadata: {},
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

    const updated = await this.runRepo.update(id, input);
    if (!updated) {
      throw OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR, { message: `Failed to update run ${id}` });
    }

    if (input.status) {
      const eventType = this.getStatusEventType(input.status);
      if (eventType) {
        await this.eventBus.publish({
          id: randomUUID(),
          type: eventType,
          timestamp: new Date().toISOString(),
          correlationId: existing.correlationId,
          causationId: existing.correlationId,
          runId: id,
          sessionId: existing.sessionId,
          agentId: existing.agentId,
          data: { previousStatus: existing.status, newStatus: input.status, stage: input.stage },
          metadata: {},
        });
      }
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

  async listRuns(filter: RunFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Run>> {
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

    return this.updateRun(id, {
      status: RunStatus.CANCELLED,
      stage: "cancelled",
      errorMessage: reason,
      metadata: { cancelledAt: new Date().toISOString(), reason },
    });
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

  private getStatusEventType(status: string): string | null {
    switch (status) {
      case RunStatus.RUNNING: return OrchestrationEventType.RUN_STARTED;
      case RunStatus.COMPLETED: return OrchestrationEventType.RUN_COMPLETED;
      case RunStatus.FAILED: return OrchestrationEventType.RUN_FAILED;
      case RunStatus.CANCELLED: return OrchestrationEventType.RUN_CANCELLED;
      case RunStatus.PAUSED: return OrchestrationEventType.RUN_PAUSED;
      default: return null;
    }
  }
}
