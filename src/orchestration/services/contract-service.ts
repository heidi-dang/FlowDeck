import { randomUUID } from "crypto";
import type { Contract, CreateContractInput, UpdateContractInput, ContractFilter } from "../types";
import { ContractStatus, OrchestrationError, ErrorCodes, OrchestrationEventType, assertNever } from "../types";
import { createEvent } from "../types/events";
import type { IContractRepository, IEventBus, PaginatedResult } from "./ports";
import type { PagePaginationRequest } from "../types/pagination";

export class ContractService {
  constructor(
    private readonly contractRepo: IContractRepository,
    private readonly eventBus: IEventBus,
  ) {}

  async createContract(input: CreateContractInput): Promise<Contract> {
    const now = new Date().toISOString();
    const id = randomUUID();

    const contract: Contract = {
      id,
      status: ContractStatus.ACTIVE,
      name: input.name,
      description: input.description,
      version: input.version ?? "1.0.0",
      rules: input.rules ?? [],
      correlationId: input.correlationId,
      causationId: input.causationId,
      runId: input.runId,
      assignmentId: input.assignmentId,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };

    const saved = await this.contractRepo.create(contract);

    await this.eventBus.publish(createEvent(
      OrchestrationEventType.CONTRACT_CREATED,
      {
        correlationId: input.correlationId,
        causationId: input.causationId,
        aggregateId: id,
        aggregateVersion: 1,
        runId: input.runId,
        contractId: id,
        data: { name: input.name, version: input.version },
      },
    ));

    return saved;
  }

  async updateContract(id: string, input: UpdateContractInput): Promise<Contract> {
    const existing = await this.contractRepo.findById(id);
    if (!existing) {
      throw OrchestrationError.fromCode(ErrorCodes.CONTRACT_NOT_FOUND, { message: `Contract ${id} not found` });
    }

    const updated = await this.contractRepo.update(id, input);
    if (!updated) {
      throw OrchestrationError.fromCode(ErrorCodes.INTERNAL_ERROR);
    }

    if (input.status && input.status !== existing.status) {
      const eventType = this.getStatusEvent(input.status);
      await this.eventBus.publish(createEvent(
        eventType,
        {
          correlationId: existing.correlationId,
          causationId: existing.correlationId,
          aggregateId: id,
          runId: existing.runId,
          contractId: id,
          data: { previousStatus: existing.status, newStatus: input.status },
        },
      ));
    }

    return updated;
  }

  async getContract(id: string): Promise<Contract> {
    const contract = await this.contractRepo.findById(id);
    if (!contract) {
      throw OrchestrationError.fromCode(ErrorCodes.CONTRACT_NOT_FOUND, { message: `Contract ${id} not found` });
    }
    return contract;
  }

  async listContracts(filter: ContractFilter, pagination: PagePaginationRequest): Promise<PaginatedResult<Contract>> {
    return this.contractRepo.findMany(filter, pagination);
  }

  async activateContract(id: string): Promise<Contract> {
    return this.updateContract(id, { status: ContractStatus.ACTIVE });
  }

  async completeContract(id: string): Promise<Contract> {
    return this.updateContract(id, { status: ContractStatus.COMPLETED });
  }

  async failContract(id: string): Promise<Contract> {
    return this.updateContract(id, { status: ContractStatus.FAILED });
  }

  /** Exhaustive contract status → event mapping. Unknown statuses produce a compile error. */
  private getStatusEvent(status: string): string {
    switch (status) {
      case ContractStatus.COMPLETED: return OrchestrationEventType.CONTRACT_COMPLETED;
      case ContractStatus.FAILED: return OrchestrationEventType.CONTRACT_FAILED;
      case ContractStatus.ACTIVE:
      case ContractStatus.PENDING:
      case ContractStatus.CANCELLED:
        return OrchestrationEventType.CONTRACT_UPDATED;
      default:
        return assertNever(status as unknown as never, `Unhandled contract status event mapping: ${status}`);
    }
  }
}
