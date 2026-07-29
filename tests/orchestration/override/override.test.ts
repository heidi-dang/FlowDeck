import { describe, it, expect } from "bun:test"
import { OverrideRequest } from "@/orchestration/override/domain/override-request"
import { getGateOverrideability, validateOverrideForCompletion, checkDuplicateActiveOverride } from "@/orchestration/override/policies/override-policy"
import { NonOverridableGateError, OverrideWrongRunError, OverrideWrongShaError, OverrideWrongGateError, OverrideExpiredError, OverrideConsumedError, InsufficientOverrideAuthorityError } from "@/orchestration/override/domain/errors"

const RUN_ID = "run-1"
const SHA = "abc123"
const CONTRACT_VERSION = "version-1"
const FAMILY_ID = "fam-1"

function makeOverride(overrides: Record<string, unknown> = {}): OverrideRequest {
  return new OverrideRequest({
    id: "ovr-1", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
    contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
    justification: "Need to ship", requester: "alice", requesterAuthority: "operator",
    status: "approved", approver: "bob", approverAuthority: "maintainer",
    createdAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  })
}

describe("Override lifecycle", () => {
  it("starts as requested", () => {
    const o = makeOverride({ status: "requested", approver: undefined, approverAuthority: undefined })
    expect(o.status).toBe("requested")
    expect(o.isActive).toBe(false)
  })
  it("can be approved", () => {
    const o = makeOverride({ status: "requested", approver: undefined, approverAuthority: undefined })
    const approved = o.approve("bob", "maintainer", new Date("2026-07-29T13:00:00Z"))
    expect(approved.status).toBe("approved")
    expect(approved.approver).toBe("bob")
    expect(approved.isActive).toBe(true)
  })
  it("can be rejected", () => {
    const o = makeOverride({ status: "requested" })
    const rejected = o.reject("bob", new Date())
    expect(rejected.status).toBe("rejected")
  })
  it("can be revoked", () => {
    const o = makeOverride()
    const revoked = o.revoke(new Date())
    expect(revoked.status).toBe("revoked")
    expect(revoked.isActive).toBe(false)
  })
  it("can be consumed", () => {
    const o = makeOverride()
    const consumed = o.consume(new Date())
    expect(consumed.status).toBe("consumed")
    expect(consumed.isActive).toBe(false)
  })
  it("can expire", () => {
    const o = makeOverride({ expiresAt: new Date("2026-07-28T12:00:00Z") })
    expect(o.isExpired(new Date("2026-07-29T12:00:00Z"))).toBe(true)
    expect(o.isActive).toBe(false)
  })
})

describe("Gate overrideability", () => {
  it("current-sha-matches-verification is NOT overridable", () => {
    expect(getGateOverrideability("current-sha-matches-verification")).toBe("not_overridable")
  })
  it("required-assignments-complete is NOT overridable", () => {
    expect(getGateOverrideability("required-assignments-complete")).toBe("not_overridable")
  })
  it("critical-acceptance-criteria-passed requires escalated authority", () => {
    expect(getGateOverrideability("critical-acceptance-criteria-passed")).toBe("requires_escalated_authority")
  })
  it("critical-requirements-verified requires escalated authority", () => {
    expect(getGateOverrideability("critical-requirements-verified")).toBe("requires_escalated_authority")
  })
  it("verification-policy-satisfied is overridable", () => {
    expect(getGateOverrideability("verification-policy-satisfied")).toBe("overridable")
  })
  it("mandatory-evidence-current is overridable", () => {
    expect(getGateOverrideability("mandatory-evidence-current")).toBe("overridable")
  })
})

describe("Override validation for completion", () => {
  const baseInput = {
    expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION,
    now: new Date("2026-07-29T12:30:00Z"),
  }

  it("valid override passes", () => {
    const o = makeOverride()
    expect(() => validateOverrideForCompletion({ override: o, gateId: "verification-policy-satisfied", ...baseInput })).not.toThrow()
  })

  it("non-overridable gate fails", () => {
    const o = makeOverride({ gateId: "current-sha-matches-verification" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "current-sha-matches-verification", ...baseInput })).toThrow(NonOverridableGateError)
  })

  it("wrong gate fails", () => {
    const o = makeOverride({ gateId: "mandatory-evidence-current" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "verification-policy-satisfied", ...baseInput })).toThrow(OverrideWrongGateError)
  })

  it("wrong run fails", () => {
    const o = makeOverride({ taskRunId: "other-run" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "verification-policy-satisfied", ...baseInput })).toThrow(OverrideWrongRunError)
  })

  it("wrong SHA fails", () => {
    const o = makeOverride({ sha: "wrong-sha" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "verification-policy-satisfied", ...baseInput })).toThrow(OverrideWrongShaError)
  })

  it("expired override fails", () => {
    const o = makeOverride({ status: "expired" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "verification-policy-satisfied", ...baseInput })).toThrow(OverrideExpiredError)
  })

  it("consumed override fails", () => {
    const o = makeOverride({ status: "consumed" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "verification-policy-satisfied", ...baseInput })).toThrow(OverrideConsumedError)
  })

  it("rejected override fails", () => {
    const o = makeOverride({ status: "rejected" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "verification-policy-satisfied", ...baseInput })).toThrow()
  })

  it("insufficient authority on escalated gate fails", () => {
    const o = makeOverride({ gateId: "critical-acceptance-criteria-passed", approverAuthority: "operator" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "critical-acceptance-criteria-passed", ...baseInput })).toThrow(InsufficientOverrideAuthorityError)
  })

  it("sufficient authority on escalated gate passes", () => {
    const o = makeOverride({ gateId: "critical-acceptance-criteria-passed", approverAuthority: "release_manager" })
    expect(() => validateOverrideForCompletion({ override: o, gateId: "critical-acceptance-criteria-passed", ...baseInput })).not.toThrow()
  })
})

describe("Duplicate override detection", () => {
  it("detects duplicate active overrides for same gate and run", () => {
    const o1 = makeOverride()
    expect(checkDuplicateActiveOverride([o1], "verification-policy-satisfied", RUN_ID)).toBe(true)
  })
  it("does not flag different gates", () => {
    const o1 = makeOverride({ gateId: "mandatory-evidence-current" })
    expect(checkDuplicateActiveOverride([o1], "verification-policy-satisfied", RUN_ID)).toBe(false)
  })
  it("does not flag consumed overrides as duplicates", () => {
    const o1 = makeOverride({ status: "consumed" })
    expect(checkDuplicateActiveOverride([o1], "verification-policy-satisfied", RUN_ID)).toBe(false)
  })
})
