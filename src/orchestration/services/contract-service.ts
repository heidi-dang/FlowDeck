import { randomUUID } from "crypto";
import type { Contract, CreateContractInput, UpdateContractInput, ContractFilter } from "../types";
import { ContractStatus, OrchestrationError, ErrorCodes, OrchestrationEventType } from "../types";
import type { IContractRepository, IEventBus, PaginatedResult } from "./ports";
import type { PaginationRequestDTO } from "../types/pagination";

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

    await this.eventBus.publish({
      id: randomUUID(),
      type: OrchestrationEventType.CONTRACT_CREATED,
      timestamp: now,
      correlationId: input.correlationId,
      causationId: input.causationId,
      contractId: id,
      runId: input.runId,
      data: { name: input.name, version: input.version },
      metadata: {},
    });

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
      const eventType = input.status === ContractStatus.COMPLETED
        ? OrchestrationEventType.CONTRACT_COMPLETED
        : input.status === ContractStatus.FAILED
          ? OrchestrationEventType.CONTRACT_FAILED
          : OrchestrationEventType.CONTRACT_UPDATED;

      await this.eventBus.publish({
        id: randomUUID(),
        type: eventType,
        timestamp: new Date().toISOString(),
        correlationId: existing.correlationId,
        causationId: existing.correlationId,
        contractId: id,
        runId: existing.runId,
        data: { previousStatus: existing.status, newStatus: input.status },
        metadata: {},
      });
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

  async listContracts(filter: ContractFilter, pagination: PaginationRequestDTO): Promise<PaginatedResult<Contract>> {
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
}
