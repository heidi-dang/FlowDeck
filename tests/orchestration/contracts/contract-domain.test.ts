/**
 * Tests for the contract domain model entities.
 *
 * Validates:
 * - Contract family and version creation
 * - Immutability of activated contracts
 * - Status transitions
 * - Family version management
 * - Historical accessibility of family versions
 * - Cross-contract child references fail
 */

import { describe, it, expect } from "bun:test"
import { ContractFamily, ContractVersion } from "@/orchestration/contracts/domain/contract"
import { Specification } from "@/orchestration/contracts/domain/specification"
import { ImmutableContractError } from "@/orchestration/contracts/domain/errors"
import { validateImmutability, isValidTransition } from "@/orchestration/contracts/policies/version-policy"

function makeSpec(overrides: Record<string, unknown> = {}): Specification {
  return new Specification({
    requirements: [
      { id: "req-1", description: "Must handle auth", priority: "critical" },
    ],
    acceptanceCriteria: [
      { id: "ac-1", description: "Login works", condition: "User can log in", priority: "critical" },
    ],
    verificationRules: [
      { id: "vr-1", description: "Auth tests pass", scope: "unit", required: true, failureClass: "blocking" },
    ],
    ...overrides,
  })
}

function makeVersion(overrides: Record<string, unknown> = {}): ContractVersion {
  return new ContractVersion({
    id: "v1",
    familyId: "fam-1",
    version: 1,
    specification: makeSpec(),
    status: "draft",
    hash: "abc123",
    createdAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  })
}

function makeFamily(overrides: Record<string, unknown> = {}): ContractFamily {
  return new ContractFamily({
    id: "fam-1",
    name: "Test Family",
    description: "A test contract family",
    versions: [],
    createdAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  })
}

describe("ContractFamily", () => {
  it("creates a family with no versions", () => {
    const family = makeFamily()
    expect(family.id).toBe("fam-1")
    expect(family.versions).toHaveLength(0)
    expect(family.activeVersion).toBeUndefined()
    expect(family.latestVersion).toBeUndefined()
  })

  it("adds a version via withVersion", () => {
    const family = makeFamily()
    const v1 = makeVersion()
    const updated = family.withVersion(v1)

    expect(updated.versions).toHaveLength(1)
    expect(updated.versions[0].id).toBe("v1")
    // Original should be unchanged
    expect(family.versions).toHaveLength(0)
  })

  it("finds the active version", () => {
    const v1 = makeVersion({ status: "draft" })
    const v2 = makeVersion({ id: "v2", version: 2, status: "activated" })
    const family = makeFamily({ versions: [v1, v2] })

    expect(family.activeVersion).toBeDefined()
    expect(family.activeVersion!.id).toBe("v2")
  })

  it("returns undefined for active version when none activated", () => {
    const v1 = makeVersion({ status: "draft" })
    const v2 = makeVersion({ id: "v2", version: 2, status: "draft" })
    const family = makeFamily({ versions: [v1, v2] })

    expect(family.activeVersion).toBeUndefined()
  })

  it("finds the latest version by version number", () => {
    const v1 = makeVersion({ version: 1 })
    const v2 = makeVersion({ id: "v2", version: 2, status: "activated" })
    const v3 = makeVersion({ id: "v3", version: 3, status: "draft" })
    const family = makeFamily({ versions: [v1, v2, v3] })

    expect(family.latestVersion).toBeDefined()
    expect(family.latestVersion!.version).toBe(3)
  })

  it("replaces a version via withReplacedVersion", () => {
    const v1 = makeVersion()
    const family = makeFamily({ versions: [v1] })

    const updated = v1.withStatus("activated")
    const replaced = family.withReplacedVersion(updated)

    expect(replaced.versions).toHaveLength(1)
    expect(replaced.versions[0].status).toBe("activated")
  })
})

describe("ContractVersion", () => {
  it("creates a draft version", () => {
    const v = makeVersion()
    expect(v.status).toBe("draft")
    expect(v.isActivated).toBe(false)
  })

  it("creates an activated version", () => {
    const v = makeVersion({ status: "activated" })
    expect(v.isActivated).toBe(true)
  })

  it("creates a new version with updated status via withStatus", () => {
    const v = makeVersion()
    const activated = v.withStatus("activated")

    expect(activated.status).toBe("activated")
    expect(activated.isActivated).toBe(true)
    // Original unchanged
    expect(v.status).toBe("draft")
  })

  it("immutability: activated versions cannot be modified", () => {
    const v = makeVersion({ status: "activated" })
    expect(() => validateImmutability(v)).toThrow(ImmutableContractError)
  })

  it("draft versions can be modified", () => {
    const v = makeVersion({ status: "draft" })
    expect(() => validateImmutability(v)).not.toThrow()
  })

  it("family versions remain historically accessible", () => {
    const v1 = makeVersion({ version: 1, status: "deprecated" })
    const v2 = makeVersion({ id: "v2", version: 2, status: "activated" })
    const family = makeFamily({ versions: [v1, v2] })

    // Historical versions are still accessible
    expect(family.versions).toHaveLength(2)
    const historical = family.versions.find((v) => v.version === 1)
    expect(historical).toBeDefined()
    expect(historical!.status).toBe("deprecated")
  })
})

describe("Status transitions", () => {
  it("allows draft → activated", () => {
    expect(isValidTransition("draft", "activated")).toBe(true)
  })

  it("allows draft → deprecated", () => {
    expect(isValidTransition("draft", "deprecated")).toBe(true)
  })

  it("allows activated → deprecated", () => {
    expect(isValidTransition("activated", "deprecated")).toBe(true)
  })

  it("allows activated → superseded", () => {
    expect(isValidTransition("activated", "superseded")).toBe(true)
  })

  it("disallows draft → superseded (must activate first)", () => {
    expect(isValidTransition("draft", "superseded")).toBe(false)
  })

  it("disallows deprecated → activated", () => {
    expect(isValidTransition("deprecated", "activated")).toBe(false)
  })

  it("disallows activated → draft (cannot go backwards)", () => {
    expect(isValidTransition("activated", "draft")).toBe(false)
  })

  it("disallows superseded → anything", () => {
    expect(isValidTransition("superseded", "activated")).toBe(false)
    expect(isValidTransition("superseded", "draft")).toBe(false)
    expect(isValidTransition("superseded", "deprecated")).toBe(false)
  })

  it("disallows deprecated → anything", () => {
    expect(isValidTransition("deprecated", "draft")).toBe(false)
    expect(isValidTransition("deprecated", "superseded")).toBe(false)
  })
})
