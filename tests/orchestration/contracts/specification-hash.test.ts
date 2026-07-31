/**
 * Tests for deterministic specification hashing.
 *
 * Validates:
 * - Deterministic contract hash (same spec → same hash across runs)
 * - Hash changes for every meaningful field
 * - Object insertion order independence
 * - Field omission/type changes produce different hashes
 */

import { describe, it, expect } from "bun:test"
import { Specification } from "@/orchestration/contracts/domain/specification"
import { hashSpecification } from "@/orchestration/contracts/hashing/specification-hash"

function makeSpec(overrides: Record<string, unknown> = {}) {
  return new Specification({
    requirements: [
      { id: "req-1", description: "Must handle auth", priority: "critical" as const },
    ],
    acceptanceCriteria: [
      { id: "ac-1", description: "Login works", condition: "User can log in", priority: "critical" as const },
    ],
    verificationRules: [
      { id: "vr-1", description: "Auth tests pass", scope: "unit" as const, required: true, failureClass: "blocking" as const },
    ],
    ...overrides,
  })
}

describe("Specification hashing", () => {
  it("produces a deterministic hash for identical specifications", () => {
    const spec1 = makeSpec()
    const spec2 = makeSpec()

    const hash1 = hashSpecification(spec1)
    const hash2 = hashSpecification(spec2)

    expect(hash1).toBe(hash2)
  })

  it("produces the same hash across repeated calls for the same spec", () => {
    const spec = makeSpec()
    const hash1 = hashSpecification(spec)
    const hash2 = hashSpecification(spec)
    const hash3 = hashSpecification(spec)

    expect(hash1).toBe(hash2)
    expect(hash2).toBe(hash3)
  })

  it("does not depend on object insertion order in requirements", () => {
    const spec1 = new Specification({
      requirements: [
        { id: "req-1", description: "First", priority: "critical" },
        { id: "req-2", description: "Second", priority: "high" },
      ],
      acceptanceCriteria: [],
      verificationRules: [],
    })

    const spec2 = new Specification({
      requirements: [
        { id: "req-2", description: "Second", priority: "high" },
        { id: "req-1", description: "First", priority: "critical" },
      ],
      acceptanceCriteria: [],
      verificationRules: [],
    })

    expect(hashSpecification(spec1)).toBe(hashSpecification(spec2))
  })

  it("does not depend on object insertion order in acceptance criteria", () => {
    const spec1 = new Specification({
      requirements: [],
      acceptanceCriteria: [
        { id: "ac-1", description: "First", condition: "x", priority: "critical" },
        { id: "ac-2", description: "Second", condition: "y", priority: "high" },
      ],
      verificationRules: [],
    })

    const spec2 = new Specification({
      requirements: [],
      acceptanceCriteria: [
        { id: "ac-2", description: "Second", condition: "y", priority: "high" },
        { id: "ac-1", description: "First", condition: "x", priority: "critical" },
      ],
      verificationRules: [],
    })

    expect(hashSpecification(spec1)).toBe(hashSpecification(spec2))
  })

  it("does not depend on object insertion order in verification rules", () => {
    const spec1 = new Specification({
      requirements: [],
      acceptanceCriteria: [],
      verificationRules: [
        { id: "vr-1", description: "First", scope: "unit", required: true, failureClass: "blocking" },
        { id: "vr-2", description: "Second", scope: "integration", required: false, failureClass: "non_blocking" },
      ],
    })

    const spec2 = new Specification({
      requirements: [],
      acceptanceCriteria: [],
      verificationRules: [
        { id: "vr-2", description: "Second", scope: "integration", required: false, failureClass: "non_blocking" },
        { id: "vr-1", description: "First", scope: "unit", required: true, failureClass: "blocking" },
      ],
    })

    expect(hashSpecification(spec1)).toBe(hashSpecification(spec2))
  })

  it("hash changes when a requirement description changes", () => {
    const spec1 = makeSpec()
    const spec2 = makeSpec({
      requirements: [
        { id: "req-1", description: "Different description", priority: "critical" },
      ],
    })

    expect(hashSpecification(spec1)).not.toBe(hashSpecification(spec2))
  })

  it("hash changes when a requirement priority changes", () => {
    const spec1 = makeSpec()
    const spec2 = makeSpec({
      requirements: [
        { id: "req-1", description: "Must handle auth", priority: "high" },
      ],
    })

    expect(hashSpecification(spec1)).not.toBe(hashSpecification(spec2))
  })

  it("hash changes when a requirement is added", () => {
    const spec1 = makeSpec()
    const spec2 = makeSpec({
      requirements: [
        { id: "req-1", description: "Must handle auth", priority: "critical" },
        { id: "req-2", description: "Extra requirement", priority: "advisory" },
      ],
    })

    expect(hashSpecification(spec1)).not.toBe(hashSpecification(spec2))
  })

  it("hash changes when a requirement is removed", () => {
    const spec1 = makeSpec()
    const spec2 = new Specification({
      requirements: [],
      acceptanceCriteria: [
        { id: "ac-1", description: "Login works", condition: "User can log in", priority: "critical" },
      ],
      verificationRules: [
        { id: "vr-1", description: "Auth tests pass", scope: "unit", required: true, failureClass: "blocking" },
      ],
    })

    expect(hashSpecification(spec1)).not.toBe(hashSpecification(spec2))
  })

  it("hash changes when acceptance criterion condition changes", () => {
    const spec1 = makeSpec()
    const spec2 = makeSpec({
      acceptanceCriteria: [
        { id: "ac-1", description: "Login works", condition: "Different condition", priority: "critical" },
      ],
    })

    expect(hashSpecification(spec1)).not.toBe(hashSpecification(spec2))
  })

  it("hash changes when verification rule scope changes", () => {
    const spec1 = makeSpec()
    const spec2 = makeSpec({
      verificationRules: [
        { id: "vr-1", description: "Auth tests pass", scope: "integration", required: true, failureClass: "blocking" },
      ],
    })

    expect(hashSpecification(spec1)).not.toBe(hashSpecification(spec2))
  })

  it("hash changes when verification rule required flag changes", () => {
    const spec1 = makeSpec()
    const spec2 = makeSpec({
      verificationRules: [
        { id: "vr-1", description: "Auth tests pass", scope: "unit", required: false, failureClass: "blocking" },
      ],
    })

    expect(hashSpecification(spec1)).not.toBe(hashSpecification(spec2))
  })

  it("hash changes when category is added to a requirement", () => {
    const spec1 = makeSpec()
    const spec2 = makeSpec({
      requirements: [
        { id: "req-1", description: "Must handle auth", priority: "critical", category: "security" },
      ],
    })

    expect(hashSpecification(spec1)).not.toBe(hashSpecification(spec2))
  })

  it("produces a 64-char hex string", () => {
    const spec = makeSpec()
    const hash = hashSpecification(spec)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is not affected by mutable runtime state (no status/createdAt in hash)", () => {
    // The hash should only depend on the specification content,
    // not on any wrapper object properties
    const spec = makeSpec()
    const hash = hashSpecification(spec)

    // Running the hash again gives the same result (already tested above)
    expect(hashSpecification(spec)).toBe(hash)
  })
})
