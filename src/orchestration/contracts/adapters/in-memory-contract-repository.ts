/**
 * In-memory contract repository.
 *
 * Used for testing until Dev 1's persistence layer is available.
 * Implements the ContractRepository port.
 */

import type { ContractFamily } from "../domain/contract"
import type { ContractRepository } from "../ports/contract-repository"

export class InMemoryContractRepository implements ContractRepository {
  private readonly families: Map<string, ContractFamily> = new Map()

  async saveFamily(family: ContractFamily): Promise<void> {
    this.families.set(family.id, family)
  }

  async getFamily(familyId: string): Promise<ContractFamily | undefined> {
    return this.families.get(familyId)
  }

  async listFamilies(): Promise<ContractFamily[]> {
    return Array.from(this.families.values())
  }

  async deleteFamily(familyId: string): Promise<void> {
    this.families.delete(familyId)
  }

  /** Clears all data (useful between tests). */
  clear(): void {
    this.families.clear()
  }
}
