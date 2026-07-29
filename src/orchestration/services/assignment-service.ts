import { randomUUID } from "crypto";
import type { Assignment, CreateAssignmentInput, UpdateAssignmentInput, AssignmentFilter } from "../types";
import { AssignmentStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import type { IAssignmentRepository, IEventBus, PaginatedResult } from "./ports";
import type { PaginationRequestDTO } from "../types/pagination";

export class AssignmentService {
  constructor(
    private readonly assignmentRepo: IAssignmentRepository,
    private readonly eventBus: IEventBus,
  ) {}

  async createAssignment(input: CreateAssignmentInput): Promise<Assignment> {
    const now = new Date().toISOString();
    const id = randomUUID();

    const assignment: Assignment = {
      id,
      runId: input.runId,
      agentId: input.agentId,
      contractId: input.contractId,
      status: AssignmentStatus.PENDING,
      role: input.role,
      correlationId: input.correlationId,
      causationId: input.causationId,
      taskDescription: input.taskDescription,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const saved = await this.assignmentRepo.create(assignment);

    await this.eventBus.publish({
      id: randomUUID(),
      type: OrchestrationEventType.ASSIGNMENT_CREATED,
      timestamp: now,
      correlationId: input.correlationId,
      causationId: input.causationId,
      runId: input.runId,
      assignmentId: id,
      agentId: input.agentId,
      data: { role: input.role },
      metadata: {},
    });

    return saved;
  }

  async updateAssignment(id: string, input: UpdateAssignmentInput): Promise<Assignment> {
    const existing = await this.assignmentRepo.findById(id);
    if (!existing) {
      throw OrchestrationError.fromCode(ErrorCodes.ASSIGNMENT_NOT_FOUND, { message: `Assignment ${id} not found` });
    }

    const updated = await this.assignmentRepo.update(id, input);
    if (!updated) throw OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR);

    if (input.status && input.status !== existing.status) {
      const eventType = this.getStatusEvent(input.status);
      if (eventType) {
        await this.eventBus.publish({
          id: randomUUID(),
          type: eventType,
          timestamp: new Date().toISOString(),
          correlationId: existing.correlationId,
          causationId: existing.correlationId,
          runId: existing.runId,
          assignmentId: id,
          agentId: existing.agentId,
          data: { previousStatus: existing.status, newStatus: input.status },
          metadata: {},
        });
      }
    }

    return updated;
  }

  async getAssignment(id: string): Promise<Assignment> {
    const a = await this.assignmentRepo.findById(id);
    if (!a) throw OrchestrationError.fromCode(ErrorCodes.ASSIGNMENT_NOT_FOUND);
    return a;
  }

  async listAssignments(filter: AssignmentFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Assignment>> {
    return this.assignmentRepo.findMany(filter, pagination);
  }

  async assignAssignment(id: string): Promise<Assignment> {
    return this.updateAssignment(id, { status: AssignmentStatus.ASSIGNED });
  }

  async startAssignment(id: string): Promise<Assignment> {
    return this.updateAssignment(id, { status: AssignmentStatus.IN_PROGRESS });
  }

  async completeAssignment(id: string): Promise<Assignment> {
    return this.updateAssignment(id, { status: AssignmentStatus.COMPLETED });
  }

  async failAssignment(id: string): Promise<Assignment> {
    return this.updateAssignment(id, { status: AssignmentStatus.FAILED });
  }

  private getStatusEvent(status: string): string | null {
    switch (status) {
      case AssignmentStatus.ASSIGNED: return OrchestrationEventType.ASSIGNMENT_ASSIGNED;
      case AssignmentStatus.IN_PROGRESS: return OrchestrationEventType.ASSIGNMENT_STARTED;
      case AssignmentStatus.COMPLETED: return OrchestrationEventType.ASSIGNMENT_COMPLETED;
      case AssignmentStatus.FAILED: return OrchestrationEventType.ASSIGNMENT_FAILED;
      default: return null;
    }
  }
}
