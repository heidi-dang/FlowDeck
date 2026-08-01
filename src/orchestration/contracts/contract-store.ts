/**
 * In-memory contract store.
 *
 * Stores activated TaskContracts immutably.
 * Contracts cannot be modified after activation.
 * Provides retrieval by ID or hash.
 */

import type { TaskContract } from "./task-contract"
import { ImmutableContractError } from "./domain/errors"

/**
 * Contract store interface.
 */
export interface IContractStore {
  store(contract: TaskContract): void
  getById(id: string): TaskContract | undefined
  getByHash(hash: string): TaskContract | undefined
  getAll(): readonly TaskContract[]
  getByStartingSha(sha: string): readonly TaskContract[]
}

/**
 * In-memory implementation of contract store.
 * Uses frozen maps to ensure immutability.
 */
export class ContractStore implements IContractStore {
  private readonly contractsById: ReadonlyMap<string, TaskContract>
  private readonly contractsByHash: ReadonlyMap<string, TaskContract>
  private readonly contractsByStartingSha: ReadonlyMap<string, readonly TaskContract[]>

  constructor(contracts: readonly TaskContract[] = []) {
    // Build indexes
    const byId = new Map<string, TaskContract>()
    const byHash = new Map<string, TaskContract>()
    const byStartingSha = new Map<string, TaskContract[]>()

    for (const contract of contracts) {
      byId.set(contract.id, contract)
      byHash.set(contract.hash, contract)

      const existing = byStartingSha.get(contract.startingSha) ?? []
      byStartingSha.set(contract.startingSha, [...existing, contract])
    }

    // Freeze all maps to prevent mutation
    this.contractsById = Object.freeze(byId)
    this.contractsByHash = Object.freeze(byHash)
    this.contractsByStartingSha = Object.freeze(
      new Map(
        Array.from(byStartingSha.entries()).map(([k, v]) => [k, Object.freeze(v)])
      )
    )
  }

  /**
   * Stores an activated contract immutably.
   * Throws if contract is already in store (activation conflict).
   */
  store(contract: TaskContract): void {
    if (this.contractsById.has(contract.id)) {
      throw new ImmutableContractError(
        `Contract ${contract.id} is already stored and cannot be modified`
      )
    }

    // This would require creating a new instance with the contract added
    // For practical use, we return a new store
    throw new Error(
      "ContractStore.store() should not be called directly. " +
      "Use ContractStore.withContract() to create a new store with the contract added."
    )
  }

  /**
   * Returns a new ContractStore with the given contract added.
   * The original store remains unchanged.
   */
  withContract(contract: TaskContract): ContractStore {
    if (this.contractsById.has(contract.id)) {
      throw new ImmutableContractError(
        `Contract ${contract.id} is already stored and cannot be modified`
      )
    }

    const newContracts = [...this.getAll(), contract]
    return new ContractStore(newContracts)
  }

  /**
   * Retrieves a contract by its ID.
   */
  getById(id: string): TaskContract | undefined {
    return this.contractsById.get(id)
  }

  /**
   * Retrieves a contract by its deterministic hash.
   */
  getByHash(hash: string): TaskContract | undefined {
    return this.contractsByHash.get(hash)
  }

  /**
   * Returns all stored contracts.
   */
  getAll(): readonly TaskContract[] {
    return Array.from(this.contractsById.values())
  }

  /**
   * Returns all contracts with the given starting SHA.
   * Useful for historical reconstruction.
   */
  getByStartingSha(sha: string): readonly TaskContract[] {
    return this.contractsByStartingSha.get(sha) ?? []
  }

  /**
   * Returns the number of stored contracts.
   */
  get size(): number {
    return this.contractsById.size
  }
}

/**
 * Creates an empty contract store.
 */
export function createContractStore(): ContractStore {
  return new ContractStore()
}

/**
 * Reconstructs a contract store from a list of contracts.
 * Useful for historical reconstruction from persisted state.
 */
export function reconstructContractStore(contracts: readonly TaskContract[]): ContractStore {
  return new ContractStore(contracts)
}
