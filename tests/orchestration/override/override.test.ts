import { describe, it, expect } from "bun:test"
import { OverrideRequest } from "@/orchestration/override/domain/override-request"
import { validateOverrideForCompletion, checkDuplicateActiveOverride } from "@/orchestration/override/policies/override-policy"
import { getGateDefinition } from "@/orchestration/completion/domain/gate-policy"
import { NonOverridableGateError, OverrideWrongRunError, OverrideWrongShaError, OverrideWrongGateError, OverrideExpiredError, OverrideConsumedError } from "@/orchestration/override/domain/errors"
import type { Instant, AuthorityLevel } from "@/orchestration/common/types"

const RUN_ID = "run-1"
const SHA = "abc123"
const CONTRACT_VERSION = "version-1"
const FAMILY_ID = "fam-1"
const NOW = "2026-07-29T12:30:00.000Z" as Instant

function makeOverride(overrides: Record<string, unknown> = {}): OverrideRequest {
  return new OverrideRequest({
    id: "ovr-1", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
    contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
    justification: "Need to ship", requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
    status: "approved", version: 1, approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
    createdAt: "2026-07-29T12:00:00.000Z" as Instant,
    ...overrides,
  })
}

describe("Override lifecycle", () => {
  it("starts as requested", () => {
    const o = makeOverride({ status: "requested", version: 1, approver: undefined, approverAuthority: undefined })
    expect(o.status).toBe("requested")
    expect(o.isActive).toBe(false)
  })
  it("can be approved", () => {
    const o = makeOverride({ status: "requested", version: 1, approver: undefined, approverAuthority: undefined })
    const approved = o.approve("bob", "maintainer" as AuthorityLevel, "2026-07-29T13:00:00.000Z" as Instant)
    expect(approved.status).toBe("approved")
    expect(approved.isActive).toBe(true)
  })
  it("can be consumed", () => {
    const o = makeOverride()
    const consumed = o.consume("dec-1", "2026-07-29T13:00:00.000Z" as Instant)
    expect(consumed.status).toBe("consumed")
    expect(consumed.consumedByDecisionId).toBe("dec-1")
  })
  it("rejects invalid transitions", () => {
    const o = makeOverride({ status: "consumed" })
    expect(() => o.approve("bob", "maintainer" as AuthorityLevel, "2026-07-29T13:00:00.000Z" as Instant)).toThrow()
  })
})

describe("Gate overrideability", () => {
  it("current-sha-matches-verification is NOT overridable", () => {
    expect(getGateDefinition("current-sha-matches-verification").overridePolicy.kind).toBe("not_overridable")
  })
  it("verification-policy-satisfied is overridable", () => {
    expect(getGateDefinition("verification-policy-satisfied").overridePolicy.kind).toBe("overridable")
  })
  it("critical-acceptance-criteria-passed requires escalated authority", () => {
    const policy = getGateDefinition("critical-acceptance-criteria-passed").overridePolicy
    if (policy.kind === "overridable") {
      expect(policy.approvalRequired).toBe(true)
      expect(policy.minimumAuthority).toBe("release_manager")
    }
  })
})

describe("Override validation for completion", () => {
  it("valid override passes", () => {
    const o = makeOverride()
    expect(() => validateOverrideForCompletion({
      override: o, gateId: "verification-policy-satisfied",
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION,
      now: NOW,
    })).not.toThrow()
  })
  it("non-overridable gate fails", () => {
    const o = makeOverride({ gateId: "current-sha-matches-verification" })
    expect(() => validateOverrideForCompletion({
      override: o, gateId: "current-sha-matches-verification",
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION, now: NOW,
    })).toThrow(NonOverridableGateError)
  })
  it("wrong gate fails", () => {
    const o = makeOverride({ gateId: "mandatory-evidence-current" })
    expect(() => validateOverrideForCompletion({
      override: o, gateId: "verification-policy-satisfied",
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION, now: NOW,
    })).toThrow(OverrideWrongGateError)
  })
  it("wrong run fails", () => {
    const o = makeOverride({ taskRunId: "other-run" })
    expect(() => validateOverrideForCompletion({
      override: o, gateId: "verification-policy-satisfied",
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION, now: NOW,
    })).toThrow(OverrideWrongRunError)
  })
  it("wrong SHA fails", () => {
    const o = makeOverride({ sha: "wrong-sha" })
    expect(() => validateOverrideForCompletion({
      override: o, gateId: "verification-policy-satisfied",
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION, now: NOW,
    })).toThrow(OverrideWrongShaError)
  })
  it("expired override fails", () => {
    const o = makeOverride({ status: "expired" })
    expect(() => validateOverrideForCompletion({
      override: o, gateId: "verification-policy-satisfied",
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION, now: NOW,
    })).toThrow(OverrideExpiredError)
  })
  it("consumed override fails", () => {
    const o = makeOverride({ status: "consumed" })
    expect(() => validateOverrideForCompletion({
      override: o, gateId: "verification-policy-satisfied",
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION, now: NOW,
    })).toThrow(OverrideConsumedError)
  })
  it("insufficient authority on escalated gate fails", () => {
    const o = makeOverride({ gateId: "critical-acceptance-criteria-passed", approverAuthority: "operator" as AuthorityLevel })
    expect(() => validateOverrideForCompletion({
      override: o, gateId: "critical-acceptance-criteria-passed",
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION, now: NOW,
    })).toThrow()
  })
})

describe("Duplicate override detection", () => {
  it("detects duplicate active overrides", () => {
    const o1 = makeOverride()
    expect(checkDuplicateActiveOverride([o1], "verification-policy-satisfied", RUN_ID)).toBe(true)
  })
  it("does not flag different gates", () => {
    const o1 = makeOverride({ gateId: "mandatory-evidence-current" })
    expect(checkDuplicateActiveOverride([o1], "verification-policy-satisfied", RUN_ID)).toBe(false)
  })
})
