/**
 * Evidence domain tests.
 *
 * Validates:
 * - Immutable evidence content
 * - Evidence lifecycle (create → current → archived)
 * - Evidence links to criteria
 * - SHA binding
 * - Same-run enforcement
 * - Archive preserves content
 * - Archived evidence is traceable
 * - Cross-run rejection
 */

import { describe, it, expect } from "bun:test"
import { Evidence } from "@/orchestration/evidence/domain/evidence"
import { EvidenceLink } from "@/orchestration/evidence/domain/evidence-link"
import {
  validateEvidenceBinding,
  isEvidenceCurrent,
  isEvidenceSatisfying,
  checkMandatoryEvidence,
} from "@/orchestration/evidence/policies/evidence-policy"
import {
  EvidenceShaMismatchError,
  EvidenceCrossRunError,
} from "@/orchestration/evidence/domain/errors"

const SHA = "abc123def456"
const OTHER_SHA = "othersha789"
const RUN_ID = "run-1"
const OTHER_RUN_ID = "run-2"

function makeEvidence(overrides: Record<string, unknown> = {}): Evidence {
  return new Evidence({
    id: "ev-1",
    content: "Test evidence content",
    contentType: "text/plain",
    sha: SHA,
    runId: RUN_ID,
    criterionIds: ["ac-1"],
    status: "current",
    createdAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  })
}

describe("Evidence immutability", () => {
  it("creates evidence with immutable content", () => {
    const evidence = makeEvidence()
    expect(evidence.content).toBe("Test evidence content")
    expect(evidence.contentType).toBe("text/plain")
    expect(evidence.status).toBe("current")
  })

  it("archive creates new instance without mutating original", () => {
    const evidence = makeEvidence()
    const archived = evidence.archive(new Date("2026-07-30T12:00:00Z"))

    // Original is unchanged
    expect(evidence.status).toBe("current")
    expect(evidence.archivedAt).toBeUndefined()
    expect(evidence.content).toBe("Test evidence content")

    // Archived copy has new status
    expect(archived.status).toBe("archived")
    expect(archived.content).toBe("Test evidence content") // Content preserved
  })

  it("archive preserves content", () => {
    const evidence = makeEvidence()
    const archived = evidence.archive(new Date("2026-07-30T12:00:00Z"))

    expect(archived.status).toBe("archived")
    expect(archived.content).toBe("Test evidence content") // Content preserved
    expect(archived.archivedAt).toEqual(new Date("2026-07-30T12:00:00Z"))
    // Original unchanged
    expect(evidence.status).toBe("current")
  })

  it("archived evidence remains readable and traceable", () => {
    const evidence = makeEvidence()
    const archived = evidence.archive(new Date("2026-07-30T12:00:00Z"))

    // All fields still accessible
    expect(archived.id).toBe("ev-1")
    expect(archived.sha).toBe(SHA)
    expect(archived.runId).toBe(RUN_ID)
    expect(archived.criterionIds).toEqual(["ac-1"])
    expect(archived.createdAt).toBeDefined()
  })
})

describe("Evidence SHA binding", () => {
  it("matches SHA correctly", () => {
    const evidence = makeEvidence()
    expect(evidence.matchesSha(SHA)).toBe(true)
    expect(evidence.matchesSha(OTHER_SHA)).toBe(false)
  })

  it("validation passes when SHA matches", () => {
    const evidence = makeEvidence()
    expect(() => validateEvidenceBinding({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).not.toThrow()
  })

  it("validation throws when SHA does not match", () => {
    const evidence = makeEvidence()
    expect(() => validateEvidenceBinding({ evidence, expectedSha: OTHER_SHA, expectedRunId: RUN_ID }))
      .toThrow(EvidenceShaMismatchError)
  })
})

describe("Evidence run ownership", () => {
  it("belongs to run correctly", () => {
    const evidence = makeEvidence()
    expect(evidence.belongsToRun(RUN_ID)).toBe(true)
    expect(evidence.belongsToRun(OTHER_RUN_ID)).toBe(false)
  })

  it("validation throws when run does not match", () => {
    const evidence = makeEvidence()
    expect(() => validateEvidenceBinding({ evidence, expectedSha: SHA, expectedRunId: OTHER_RUN_ID }))
      .toThrow(EvidenceCrossRunError)
  })
})

describe("Evidence current check", () => {
  it("current evidence with matching SHA and run is current", () => {
    const evidence = makeEvidence()
    expect(isEvidenceCurrent({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).toBe(true)
  })

  it("archived evidence is not current", () => {
    const evidence = makeEvidence({ status: "archived", archivedAt: new Date("2026-07-30T12:00:00Z") })
    expect(isEvidenceCurrent({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).toBe(false)
  })

  it("wrong SHA evidence is not current", () => {
    const evidence = makeEvidence({ sha: OTHER_SHA })
    expect(isEvidenceCurrent({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).toBe(false)
  })

  it("wrong run evidence is not current", () => {
    const evidence = makeEvidence({ runId: OTHER_RUN_ID })
    expect(isEvidenceCurrent({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).toBe(false)
  })
})

describe("Evidence satisfying check", () => {
  it("current evidence satisfies", () => {
    const evidence = makeEvidence()
    expect(isEvidenceSatisfying({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).toBe(true)
  })

  it("archived evidence does not satisfy", () => {
    const evidence = makeEvidence({ status: "archived" })
    expect(isEvidenceSatisfying({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).toBe(false)
  })

  it("wrong SHA evidence does not satisfy", () => {
    const evidence = makeEvidence({ sha: OTHER_SHA })
    expect(isEvidenceSatisfying({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).toBe(false)
  })

  it("wrong run evidence does not satisfy", () => {
    const evidence = makeEvidence({ runId: OTHER_RUN_ID })
    expect(isEvidenceSatisfying({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })).toBe(false)
  })
})

describe("Mandatory evidence coverage", () => {
  it("returns satisfied when current evidence exists for criterion", () => {
    const evidence = makeEvidence()
    const result = checkMandatoryEvidence({
      criterionIds: ["ac-1"],
      evidenceItems: [evidence],
      expectedSha: SHA,
      expectedRunId: RUN_ID,
    })

    expect(result).toHaveLength(1)
    expect(result[0].satisfied).toBe(true)
    expect(result[0].criterionId).toBe("ac-1")
    expect(result[0].evidenceCount).toBe(1)
  })

  it("returns unsatisfied when no evidence for criterion", () => {
    const result = checkMandatoryEvidence({
      criterionIds: ["ac-1"],
      evidenceItems: [],
      expectedSha: SHA,
      expectedRunId: RUN_ID,
    })

    expect(result[0].satisfied).toBe(false)
    expect(result[0].reasons).toContain("No evidence for criterion ac-1")
  })

  it("returns unsatisfied when only archived evidence exists", () => {
    const evidence = makeEvidence({ status: "archived" })
    const result = checkMandatoryEvidence({
      criterionIds: ["ac-1"],
      evidenceItems: [evidence],
      expectedSha: SHA,
      expectedRunId: RUN_ID,
    })

    expect(result[0].satisfied).toBe(false)
    expect(result[0].reasons).toContain("Evidence is archived and not current")
  })

  it("returns unsatisfied when evidence has wrong SHA", () => {
    const evidence = makeEvidence({ sha: OTHER_SHA })
    const result = checkMandatoryEvidence({
      criterionIds: ["ac-1"],
      evidenceItems: [evidence],
      expectedSha: SHA,
      expectedRunId: RUN_ID,
    })

    expect(result[0].satisfied).toBe(false)
  })

  it("returns unsatisfied when evidence has wrong run", () => {
    const evidence = makeEvidence({ runId: OTHER_RUN_ID })
    const result = checkMandatoryEvidence({
      criterionIds: ["ac-1"],
      evidenceItems: [evidence],
      expectedSha: SHA,
      expectedRunId: RUN_ID,
    })

    expect(result[0].satisfied).toBe(false)
  })

  it("evaluates multiple criteria independently", () => {
    const evidence1 = makeEvidence({ id: "ev-1", criterionIds: ["ac-1"] })
    const evidence2 = makeEvidence({ id: "ev-2", criterionIds: ["ac-2"], sha: OTHER_SHA })

    const result = checkMandatoryEvidence({
      criterionIds: ["ac-1", "ac-2"],
      evidenceItems: [evidence1, evidence2],
      expectedSha: SHA,
      expectedRunId: RUN_ID,
    })

    expect(result).toHaveLength(2)
    expect(result[0].criterionId).toBe("ac-1")
    expect(result[0].satisfied).toBe(true)
    expect(result[1].criterionId).toBe("ac-2")
    expect(result[1].satisfied).toBe(false)
  })
})

describe("Evidence links", () => {
  it("creates evidence link to criterion", () => {
    const link = new EvidenceLink({
      evidenceId: "ev-1",
      criterionId: "ac-1",
      createdAt: new Date("2026-07-29T12:00:00Z"),
    })

    expect(link.evidenceId).toBe("ev-1")
    expect(link.criterionId).toBe("ac-1")
  })

  it("creates evidence link to rule", () => {
    const link = new EvidenceLink({
      evidenceId: "ev-1",
      ruleId: "vr-1",
      createdAt: new Date("2026-07-29T12:00:00Z"),
    })

    expect(link.ruleId).toBe("vr-1")
  })

  it("cross-run evidence always fails validation", () => {
    const evidence = makeEvidence({ runId: OTHER_RUN_ID })
    expect(() =>
      validateEvidenceBinding({ evidence, expectedSha: SHA, expectedRunId: RUN_ID })
    ).toThrow(EvidenceCrossRunError)
  })
})

describe("Evidence Service integration", () => {
  it("archived evidence cannot unarchive (no method)", () => {
    const evidence = makeEvidence()
    const archived = evidence.archive(new Date("2026-07-30T12:00:00Z"))
    // No unarchive method exists - intentionally omitted
    expect(archived.status).toBe("archived")
    // @ts-expect-error - verify unarchive does not exist
    expect(archived.unarchive).toBeUndefined()
  })
})
