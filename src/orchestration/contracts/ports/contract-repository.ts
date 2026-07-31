/**
 * Contract repository port.
 *
 * Defines persistence boundaries for the contract domain.
 * Implementations may be in-memory (for tests) or backed by SQLite (Dev 1).
 */

import type { ContractFamily } from "../domain/contract"

export interface ContractRepository {
  /** Saves a contract family (insert or update). */
  saveFamily(family: ContractFamily): Promise<void>

  /** Retrieves a contract family by ID, or undefined if not found. */
  getFamily(familyId: string): Promise<ContractFamily | undefined>

  /** Lists all contract families. */
  listFamilies(): Promise<ContractFamily[]>

  /** Deletes a contract family by ID. */
  deleteFamily(familyId: string): Promise<void>
}
