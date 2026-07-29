/**
 * Contract service.
 *
 * High-level operations for the contract domain:
 * - Creating contract families
 * - Drafting new versions
 * - Activating versions
 * - Deprecating/superseding versions
 *
 * This service uses repository ports for persistence and is independent of
 * any specific storage implementation.
 */

import { ContractFamily, ContractVersion } from "../domain/contract"
import { Specification, type SpecificationInput } from "../domain/specification"
import { FamilyNotFoundError, VersionNotFoundError } from "../domain/errors"
import { hashSpecification } from "../hashing/specification-hash"
import { validateImmutability, validateStatusTransition } from "../policies/version-policy"
import { type ContractRepository } from "../ports/contract-repository"
import { type Clock } from "../../common/ports/clock"
import { type IdGenerator } from "../../common/ports/id-generator"
import { activateVersion as executeActivation } from "./activation-service"

export interface CreateFamilyInput {
  readonly name: string
  readonly description: string
}

export interface DraftVersionInput {
  readonly familyId: string
  readonly specification: SpecificationInput
  readonly clock: Clock
  readonly idGenerator: IdGenerator
}

export interface UpdateDraftInput {
  readonly familyId: string
  readonly versionId: string
  readonly specification: SpecificationInput
  readonly clock: Clock
}

export class ContractService {
  private readonly repository: ContractRepository

  constructor(repository: ContractRepository) {
    this.repository = repository
  }

  /** Creates a new contract family with no versions. */
  async createFamily(input: CreateFamilyInput, clock: Clock, idGenerator: IdGenerator): Promise<ContractFamily> {
    const family = new ContractFamily({
      id: idGenerator.generate(),
      name: input.name,
      description: input.description,
      versions: [],
      createdAt: clock.now(),
    })
    await this.repository.saveFamily(family)
    return family
  }

  /** Creates a new draft version for a contract family. */
  async draftVersion(input: DraftVersionInput): Promise<ContractVersion> {
    const family = await this.repository.getFamily(input.familyId)
    if (!family) {
      throw new FamilyNotFoundError(input.familyId)
    }

    const specification = new Specification(input.specification)
    const hash = hashSpecification(specification)

    const nextVersion = family.versions.length > 0
      ? Math.max(...family.versions.map((v) => v.version)) + 1
      : 1

    const version = new ContractVersion({
      id: input.idGenerator.generate(),
      familyId: input.familyId,
      version: nextVersion,
      specification,
      status: "draft",
      hash,
      createdAt: input.clock.now(),
    })

    const updatedFamily = family.withVersion(version)
    await this.repository.saveFamily(updatedFamily)

    return version
  }

  /** Updates a draft version's specification. */
  async updateDraft(input: UpdateDraftInput): Promise<ContractVersion> {
    const family = await this.repository.getFamily(input.familyId)
    if (!family) {
      throw new FamilyNotFoundError(input.familyId)
    }

    const existing = family.versions.find((v) => v.id === input.versionId)
    if (!existing) {
      throw new VersionNotFoundError(input.familyId, 0)
    }

    validateImmutability(existing)

    const specification = new Specification(input.specification)
    const hash = hashSpecification(specification)

    const updated = new ContractVersion({
      ...existing,
      specification,
      hash,
    })

    const updatedFamily = family.withReplacedVersion(updated)
    await this.repository.saveFamily(updatedFamily)

    return updated
  }

  /** Activates a draft version. */
  async activateVersion(familyId: string, versionId: string, clock: Clock): Promise<ContractVersion> {
    const family = await this.repository.getFamily(familyId)
    if (!family) {
      throw new FamilyNotFoundError(familyId)
    }

    const result = executeActivation({ family, versionId, clock })
    await this.repository.saveFamily(result.family)

    return result.version
  }

  /** Transitions a version to a new status (e.g., deprecated, superseded). */
  async transitionVersion(familyId: string, versionId: string, newStatus: "deprecated" | "superseded"): Promise<ContractVersion> {
    const family = await this.repository.getFamily(familyId)
    if (!family) {
      throw new FamilyNotFoundError(familyId)
    }

    const version = family.versions.find((v) => v.id === versionId)
    if (!version) {
      throw new VersionNotFoundError(familyId, 0)
    }

    validateStatusTransition(version, newStatus)

    const updated = version.withStatus(newStatus)
    const updatedFamily = family.withReplacedVersion(updated)
    await this.repository.saveFamily(updatedFamily)

    return updated
  }

  /** Retrieves a family by ID. */
  async getFamily(familyId: string): Promise<ContractFamily> {
    const family = await this.repository.getFamily(familyId)
    if (!family) {
      throw new FamilyNotFoundError(familyId)
    }
    return family
  }

  /** Lists all families. */
  async listFamilies(): Promise<ContractFamily[]> {
    return this.repository.listFamilies()
  }
}
