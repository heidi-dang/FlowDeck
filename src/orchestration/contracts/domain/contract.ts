/**
 * Contract domain entities.
 *
 * This module defines:
 * - ContractFamily: a named family of contract versions
 * - ContractVersion: a specific version of a contract specification
 *
 * A ContractFamily owns one or more ContractVersions. At most one version
 * may be in "activated" status at any time (enforced by the activation policy).
 * Once activated, a ContractVersion is immutable.
 */

import type { Specification } from "./specification"

export type ContractVersionStatus = "draft" | "activated" | "deprecated" | "superseded"

export interface ContractVersionData {
  readonly id: string
  readonly familyId: string
  readonly version: number
  readonly specification: Specification
  readonly status: ContractVersionStatus
  readonly hash: string
  readonly createdAt: Date
  readonly activatedAt?: Date
}

export class ContractVersion {
  public readonly id: string
  public readonly familyId: string
  public readonly version: number
  public readonly specification: Specification
  public readonly status: ContractVersionStatus
  public readonly hash: string
  public readonly createdAt: Date
  public readonly activatedAt?: Date

  constructor(data: ContractVersionData) {
    this.id = data.id
    this.familyId = data.familyId
    this.version = data.version
    this.specification = data.specification
    this.status = data.status
    this.hash = data.hash
    this.createdAt = data.createdAt
    this.activatedAt = data.activatedAt
  }

  /** Returns true if this version is activated (and therefore immutable). */
  get isActivated(): boolean {
    return this.status === "activated"
  }

  /** Returns a new ContractVersion with updated status. */
  withStatus(status: ContractVersionStatus): ContractVersion {
    return new ContractVersion({ ...this, status })
  }
}

export interface ContractFamilyData {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly versions: readonly ContractVersion[]
  readonly createdAt: Date
}

export class ContractFamily {
  public readonly id: string
  public readonly name: string
  public readonly description: string
  public readonly versions: readonly ContractVersion[]
  public readonly createdAt: Date

  constructor(data: ContractFamilyData) {
    this.id = data.id
    this.name = data.name
    this.description = data.description
    this.versions = Object.freeze([...data.versions])
    this.createdAt = data.createdAt
  }

  /** Returns the currently activated version, or undefined. */
  get activeVersion(): ContractVersion | undefined {
    return this.versions.find((v) => v.status === "activated")
  }

  /** Returns the latest version by version number. */
  get latestVersion(): ContractVersion | undefined {
    if (this.versions.length === 0) return undefined
    return this.versions.reduce((a, b) => (a.version > b.version ? a : b))
  }

  /** Returns a ContractFamily with a version added (immutable pattern). */
  withVersion(version: ContractVersion): ContractFamily {
    return new ContractFamily({
      ...this,
      versions: [...this.versions, version],
    })
  }

  /** Returns a ContractFamily with a version replaced (immutable pattern). */
  withReplacedVersion(version: ContractVersion): ContractFamily {
    const versions = this.versions.map((v) => (v.id === version.id ? version : v))
    return new ContractFamily({ ...this, versions })
  }
}
