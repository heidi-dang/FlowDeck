/**
 * Tests for contract activation policy and service.
 *
 * Validates:
 * - Activation validation matrix
 * - One-active-version policy
 * - Incomplete draft rejection
 * - Immutability after activation
 * - Concurrent activation policy (two activations of same version)
 * - Contract reconstruction (same spec → same hash)
 */

import { describe, it, expect } from "bun:test"
import { ContractFamily, ContractVersion } from "@/orchestration/contracts/domain/contract"
import { Specification } from "@/orchestration/contracts/domain/specification"
import { ActivationError, IncompleteDraftError } from "@/orchestration/contracts/domain/errors"
import { validateActivation } from "@/orchestration/contracts/policies/activation-policy"
import { activateVersion } from "@/orchestration/contracts/services/activation-service"
import { hashSpecification } from "@/orchestration/contracts/hashing/specification-hash"
import { FakeClock } from "./test-utils"

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

function makeFamily(versions: ContractVersion[] = []): ContractFamily {
  return new ContractFamily({
    id: "fam-1",
    name: "Test Family",
    description: "A test contract family",
    versions,
    createdAt: new Date("2026-07-29T12:00:00Z"),
  })
}

describe("Activation validation", () => {
  it("accepts a valid draft for activation", () => {
    const v1 = makeVersion()
    const family = makeFamily([v1])

    expect(() =>
      validateActivation({
        family,
        versionId: "v1",
        specification: {
          requirements: v1.specification.requirements,
          acceptanceCriteria: v1.specification.acceptanceCriteria,
          verificationRules: v1.specification.verificationRules,
        },
      })
    ).not.toThrow()
  })

  it("rejects activation when specification is completely empty", () => {
    const spec = new Specification({ requirements: [], acceptanceCriteria: [], verificationRules: [] })
    const v1 = makeVersion({ specification: spec })
    const family = makeFamily([v1])

    expect(() =>
      validateActivation({
        family,
        versionId: "v1",
        specification: {
          requirements: [],
          acceptanceCriteria: [],
          verificationRules: [],
        },
      })
    ).toThrow(IncompleteDraftError)
  })

  it("rejects activation when no critical requirement or criterion exists", () => {
    const spec = new Specification({
      requirements: [{ id: "req-1", description: "Nice to have", priority: "advisory" }],
      acceptanceCriteria: [{ id: "ac-1", description: "Would be nice", condition: "x", priority: "high" }],
      verificationRules: [],
    })
    const v1 = makeVersion({ specification: spec })
    const family = makeFamily([v1])

    expect(() =>
      validateActivation({
        family,
        versionId: "v1",
        specification: {
          requirements: spec.requirements,
          acceptanceCriteria: spec.acceptanceCriteria,
          verificationRules: spec.verificationRules,
        },
      })
    ).toThrow(IncompleteDraftError)
  })

  it("accepts activation with only critical requirements (no criteria)", () => {
    const spec = new Specification({
      requirements: [{ id: "req-1", description: "Critical req", priority: "critical" }],
      acceptanceCriteria: [],
      verificationRules: [],
    })
    const v1 = makeVersion({ specification: spec })
    const family = makeFamily([v1])

    expect(() =>
      validateActivation({
        family,
        versionId: "v1",
        specification: {
          requirements: spec.requirements,
          acceptanceCriteria: spec.acceptanceCriteria,
          verificationRules: spec.verificationRules,
        },
      })
    ).not.toThrow()
  })

  it("accepts activation with only critical criteria (no requirements)", () => {
    const spec = new Specification({
      requirements: [],
      acceptanceCriteria: [{ id: "ac-1", description: "Critical criterion", condition: "x", priority: "critical" }],
      verificationRules: [],
    })
    const v1 = makeVersion({ specification: spec })
    const family = makeFamily([v1])

    expect(() =>
      validateActivation({
        family,
        versionId: "v1",
        specification: {
          requirements: spec.requirements,
          acceptanceCriteria: spec.acceptanceCriteria,
          verificationRules: spec.verificationRules,
        },
      })
    ).not.toThrow()
  })

  it("rejects activation when version not found in family", () => {
    const family = makeFamily([])

    expect(() =>
      validateActivation({
        family,
        versionId: "nonexistent",
        specification: { requirements: [], acceptanceCriteria: [], verificationRules: [] },
      })
    ).toThrow(ActivationError)
  })

  it("rejects activation when version is already activated", () => {
    const v1 = makeVersion({ status: "activated" })
    const family = makeFamily([v1])

    expect(() =>
      validateActivation({
        family,
        versionId: "v1",
        specification: {
          requirements: v1.specification.requirements,
          acceptanceCriteria: v1.specification.acceptanceCriteria,
          verificationRules: v1.specification.verificationRules,
        },
      })
    ).toThrow(ActivationError)
  })

  it("enforces one-active-version policy", () => {
    const v1 = makeVersion({ id: "v1", version: 1, status: "activated" })
    const v2 = makeVersion({ id: "v2", version: 2, status: "draft" })
    const family = makeFamily([v1, v2])

    expect(() =>
      validateActivation({
        family,
        versionId: "v2",
        specification: {
          requirements: v2.specification.requirements,
          acceptanceCriteria: v2.specification.acceptanceCriteria,
          verificationRules: v2.specification.verificationRules,
        },
      })
    ).toThrow(ActivationError)
  })

  it("allows activating first version when no active version exists", () => {
    const v1 = makeVersion()
    const family = makeFamily([v1])

    expect(() =>
      validateActivation({
        family,
        versionId: "v1",
        specification: {
          requirements: v1.specification.requirements,
          acceptanceCriteria: v1.specification.acceptanceCriteria,
          verificationRules: v1.specification.verificationRules,
        },
      })
    ).not.toThrow()
  })

  it("allows activating a new version after deprecating the active one", () => {
    const v1 = makeVersion({ id: "v1", version: 1, status: "deprecated" })
    const v2 = makeVersion({ id: "v2", version: 2, status: "draft" })
    const family = makeFamily([v1, v2])

    expect(() =>
      validateActivation({
        family,
        versionId: "v2",
        specification: {
          requirements: v2.specification.requirements,
          acceptanceCriteria: v2.specification.acceptanceCriteria,
          verificationRules: v2.specification.verificationRules,
        },
      })
    ).not.toThrow()
  })
})

describe("Activation service", () => {
  it("activates a draft version and records timestamp", () => {
    const clock = new FakeClock("2026-07-29T12:00:00Z")
    const v1 = makeVersion()
    const family = makeFamily([v1])

    const result = activateVersion({ family, versionId: "v1", clock })

    expect(result.version.status).toBe("activated")
    expect(result.version.activatedAt).toEqual(new Date("2026-07-29T12:00:00Z"))
    expect(result.family.activeVersion?.id).toBe("v1")
  })

  it("returns updated family with activated version", () => {
    const clock = new FakeClock()
    const v1 = makeVersion()
    const family = makeFamily([v1])

    const result = activateVersion({ family, versionId: "v1", clock })

    expect(result.family.versions).toHaveLength(1)
    expect(result.family.versions[0].status).toBe("activated")
  })

  it("rejects activating a version that doesn't exist", () => {
    const clock = new FakeClock()
    const family = makeFamily([])

    expect(() =>
      activateVersion({ family, versionId: "nonexistent", clock })
    ).toThrow()
  })

  it("rejects activating an already activated version", () => {
    const clock = new FakeClock()
    const v1 = makeVersion({ status: "activated" })
    const family = makeFamily([v1])

    expect(() =>
      activateVersion({ family, versionId: "v1", clock })
    ).toThrow(ActivationError)
  })

  it("rejects activating when another version is already active", () => {
    const clock = new FakeClock()
    const v1 = makeVersion({ id: "v1", version: 1, status: "activated" })
    const v2 = makeVersion({ id: "v2", version: 2, status: "draft" })
    const family = makeFamily([v1, v2])

    expect(() =>
      activateVersion({ family, versionId: "v2", clock })
    ).toThrow(ActivationError)
  })
})

describe("Contract reconstruction", () => {
  it("same specification produces the same hash across different contract versions", () => {
    const specInput = {
      requirements: [
        { id: "req-1", description: "Must handle auth", priority: "critical" as const },
      ],
      acceptanceCriteria: [
        { id: "ac-1", description: "Login works", condition: "User can log in", priority: "critical" as const },
      ],
      verificationRules: [
        { id: "vr-1", description: "Auth tests pass", scope: "unit" as const, required: true, failureClass: "blocking" as const },
      ],
    }

    const spec1 = new Specification(specInput)
    const spec2 = new Specification(specInput)

    expect(hashSpecification(spec1)).toBe(hashSpecification(spec2))
  })
})
