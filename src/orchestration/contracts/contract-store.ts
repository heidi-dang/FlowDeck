/**
 * In-memory contract store.
 *
 * Stores activated TaskContracts immutably.
 * Contracts cannot be modified after activation.
 * Provides retrieval by ID or hash.
 * All getters return frozen copies to prevent external mutation.
 */

import type { TaskContract } from "./task-contract"
import { ImmutableContractError } from "./domain/errors"

/**
 * Deep freezes a value recursively.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (typeof value !== "object") return value

  if (Array.isArray(value)) {
    Object.freeze(value)
    for (const item of value) {
      deepFreeze(item)
    }
    return value
  }

  if (value instanceof Date) {
    Object.freeze(value)
    return value
  }

  if (value instanceof Map) {
    Object.freeze(value)
    for (const v of value.values()) {
      deepFreeze(v)
    }
    return value
  }

  if (value instanceof Set) {
    Object.freeze(value)
    for (const v of value.values()) {
      deepFreeze(v)
    }
    return value
  }

  Object.freeze(value)
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/**
 * Creates a deep frozen copy of a TaskContract.
 * Preserves Date objects and nested structures properly.
 */
function freezeContract(contract: TaskContract): TaskContract {
  // Create a deep copy that preserves Dates, then freeze
  const copy = {
    ...contract,
    createdAt: new Date(contract.createdAt),
    activatedAt: contract.activatedAt ? new Date(contract.activatedAt) : undefined,
    requirements: contract.requirements.map((r) => ({ ...r })),
    acceptanceCriteria: contract.acceptanceCriteria.map((a) => ({ ...a })),
    constraints: contract.constraints.map((c) => ({ ...c })),
    exclusions: [...contract.exclusions],
    requiredEvidence: contract.requiredEvidence.map((e) => ({ ...e })),
    requiredVerification: contract.requiredVerification.map((v) => ({ ...v })),
    allowedMutationScope: {
      ...contract.allowedMutationScope,
      allowedPaths: [...contract.allowedMutationScope.allowedPaths],
      deniedPaths: [...contract.allowedMutationScope.deniedPaths],
    },
    approvalGates: contract.approvalGates.map((g) => ({ ...g })),
  }
  return deepFreeze(copy) as TaskContract
}

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
 * All getters return frozen copies of contracts to prevent external mutation.
 */
export class ContractStore implements IContractStore {
  private readonly contractsById: ReadonlyMap<string, TaskContract>
  private readonly contractsByHash: ReadonlyMap<string, TaskContract>
  private readonly contractsByStartingSha: ReadonlyMap<string, readonly TaskContract[]>

  constructor(contracts: readonly TaskContract[] = []) {
    // Build indexes - store frozen copies of contracts
    const byId = new Map<string, TaskContract>()
    const byHash = new Map<string, TaskContract>()
    const byStartingSha = new Map<string, TaskContract[]>()

    for (const contract of contracts) {
      if (byId.has(contract.id)) {
        throw new ImmutableContractError(
          `Duplicate contract ID "${contract.id}" in initial contracts`
        )
      }
      const frozen = freezeContract(contract)
      byId.set(frozen.id, frozen)
      byHash.set(frozen.hash, frozen)

      const existing = byStartingSha.get(frozen.startingSha) ?? []
      byStartingSha.set(frozen.startingSha, [...existing, frozen])
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
   * Rejects duplicate contract IDs.
   */
  withContract(contract: TaskContract): ContractStore {
    if (this.contractsById.has(contract.id)) {
      throw new ImmutableContractError(
        `Duplicate contract ID "${contract.id}" - a contract with this ID is already active`
      )
    }

    const newContracts = [...this.getAll(), contract]
    return new ContractStore(newContracts)
  }

  /**
   * Retrieves a contract by its ID.
   * Returns a frozen copy to prevent external mutation.
   */
  getById(id: string): TaskContract | undefined {
    const contract = this.contractsById.get(id)
    if (!contract) return undefined
    return freezeContract(contract)
  }

  /**
   * Retrieves a contract by its deterministic hash.
   * Returns a frozen copy to prevent external mutation.
   */
  getByHash(hash: string): TaskContract | undefined {
    const contract = this.contractsByHash.get(hash)
    if (!contract) return undefined
    return freezeContract(contract)
  }

  /**
   * Returns all stored contracts.
   * Returns frozen copies to prevent external mutation.
   */
  getAll(): readonly TaskContract[] {
    const contracts = Array.from(this.contractsById.values())
    return Object.freeze(contracts.map((c) => freezeContract(c)))
  }

  /**
   * Returns all contracts with the given starting SHA.
   * Useful for historical reconstruction.
   * Returns frozen copies to prevent external mutation.
   */
  getByStartingSha(sha: string): readonly TaskContract[] {
    const contracts = this.contractsByStartingSha.get(sha) ?? []
    return Object.freeze(contracts.map((c) => freezeContract(c)))
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
