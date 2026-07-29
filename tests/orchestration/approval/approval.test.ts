import { describe, it, expect } from "bun:test"
import { ApprovalRequest } from "@/orchestration/approval/domain/approval-request"
import { ApprovalDecision } from "@/orchestration/approval/domain/approval-decision"
import { hasSufficientAuthority, getRequiredAuthorityForGate } from "@/orchestration/approval/domain/authority"
import { checkApprovalGate, validateApprovalDecision } from "@/orchestration/approval/policies/approval-policy"
import { InsufficientAuthorityError, ApprovalWrongRunError, ApprovalWrongShaError, ApprovalExpiredError } from "@/orchestration/approval/domain/errors"

const RUN_ID = "run-1"
const SHA = "abc123"
const CONTRACT_VERSION = "version-1"
const FAMILY_ID = "fam-1"
const GATE_ID = "verification-policy-satisfied"

function makeRequest(overrides: Record<string, unknown> = {}): ApprovalRequest {
  return new ApprovalRequest({
    id: "req-1", taskRunId: RUN_ID, contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID,
    gateId: GATE_ID, sha: SHA, requester: "alice", requesterAuthority: "operator",
    reason: "Need override", status: "pending", createdAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  })
}

function makeDecision(overrides: Record<string, unknown> = {}): ApprovalDecision {
  return new ApprovalDecision({
    id: "dec-1", requestId: "req-1", taskRunId: RUN_ID, contractFamilyId: FAMILY_ID,
    contractVersionId: CONTRACT_VERSION, gateId: GATE_ID, sha: SHA,
    outcome: "approved", approver: "bob", approverAuthority: "maintainer",
    reason: "Approved", createdAt: new Date("2026-07-29T12:00:00Z"), policyVersion: "1.0.0",
    ...overrides,
  })
}

describe("Approval request lifecycle", () => {
  it("starts as pending", () => {
    const req = makeRequest()
    expect(req.status).toBe("pending")
    expect(req.isActive).toBe(true)
  })
  it("can be approved", () => {
    const req = makeRequest()
    const approved = req.approve("bob", "Looks good", new Date("2026-07-29T13:00:00Z"))
    expect(approved.status).toBe("approved")
    expect(approved.decidedBy).toBe("bob")
    expect(approved.isActive).toBe(true)
  })
  it("can be rejected", () => {
    const req = makeRequest()
    const rejected = req.reject("bob", "Not good", new Date("2026-07-29T13:00:00Z"))
    expect(rejected.status).toBe("rejected")
    expect(rejected.isActive).toBe(false)
  })
  it("can be revoked", () => {
    const req = makeRequest({ status: "approved" })
    const revoked = req.revoke(new Date("2026-07-29T13:00:00Z"))
    expect(revoked.status).toBe("revoked")
    expect(revoked.isActive).toBe(false)
  })
  it("can expire", () => {
    const req = makeRequest()
    const expired = req.expire(new Date("2026-07-29T13:00:00Z"))
    expect(expired.status).toBe("expired")
  })
  it("approval decision is immutable after creation", () => {
    const dec = makeDecision()
    expect(Object.isFrozen(dec)).toBe(true)
  })
})

describe("Approval binding", () => {
  it("belongs to run", () => {
    const req = makeRequest()
    expect(req.belongsToRun(RUN_ID)).toBe(true)
    expect(req.belongsToRun("other-run")).toBe(false)
  })
  it("matches SHA", () => {
    const req = makeRequest()
    expect(req.matchesSha(SHA)).toBe(true)
    expect(req.matchesSha("other-sha")).toBe(false)
  })
  it("matches contract version", () => {
    const req = makeRequest()
    expect(req.matchesContract(CONTRACT_VERSION)).toBe(true)
    expect(req.matchesContract("other-version")).toBe(false)
  })
})

describe("Approval gate check — matrix", () => {
  const baseOverrides = { expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION, now: new Date("2026-07-29T12:30:00Z"), allowSelfApproval: false }

  it("pending approval does not satisfy gate", () => {
    const req = makeRequest()
    const result = checkApprovalGate({ request: req, decision: undefined, expectedTaskRunId: RUN_ID, ...baseOverrides })
    expect(result.status).toBe("pending")
  })
  it("approved with valid decision satisfies gate", () => {
    const req = makeRequest({ status: "approved" })
    const dec = makeDecision()
    const result = checkApprovalGate({ request: req, decision: dec, expectedTaskRunId: RUN_ID, ...baseOverrides })
    expect(result.status).toBe("satisfied")
  })
  it("rejected approval does not satisfy gate", () => {
    const req = makeRequest({ status: "rejected" })
    const result = checkApprovalGate({ request: req, decision: undefined, expectedTaskRunId: RUN_ID, ...baseOverrides })
    expect(result.status).toBe("failed")
  })
  it("expired approval does not satisfy gate", () => {
    const req = makeRequest({ status: "expired", expiresAt: new Date("2026-07-28T12:00:00Z") })
    const result = checkApprovalGate({ request: req, decision: undefined, expectedTaskRunId: RUN_ID, ...baseOverrides })
    expect(result.status).toBe("failed")
  })
  it("revoked approval does not satisfy gate", () => {
    const req = makeRequest({ status: "revoked" })
    const result = checkApprovalGate({ request: req, decision: undefined, expectedTaskRunId: RUN_ID, ...baseOverrides })
    expect(result.status).toBe("failed")
  })
  it("wrong run approval does not satisfy gate", () => {
    const req = makeRequest({ taskRunId: "other-run", status: "approved" })
    const dec = makeDecision({ taskRunId: "other-run" })
    const result = checkApprovalGate({ request: req, decision: dec, expectedTaskRunId: RUN_ID, ...baseOverrides })
    expect(result.status).toBe("failed")
  })
  it("no approval request fails gate", () => {
    const result = checkApprovalGate({ request: undefined as any, decision: undefined, expectedTaskRunId: RUN_ID, ...baseOverrides })
    expect(result.status).toBe("failed")
  })
})

describe("Validation — authority", () => {
  it("hasSufficientAuthority works", () => {
    expect(hasSufficientAuthority("maintainer", "reviewer")).toBe(true)
    expect(hasSufficientAuthority("reviewer", "maintainer")).toBe(false)
    expect(hasSufficientAuthority("system", "release_manager")).toBe(true)
  })
  it("getRequiredAuthorityForGate returns expected", () => {
    expect(getRequiredAuthorityForGate("current-sha-matches-verification")).toBe("maintainer")
    expect(getRequiredAuthorityForGate("verification-policy-satisfied")).toBe("reviewer")
  })
  it("validateApprovalDecision rejects insufficient authority", () => {
    const req = makeRequest()
    const dec = makeDecision({ approverAuthority: "operator" })
    expect(() => validateApprovalDecision({
      request: req, decision: dec,
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION,
      now: new Date("2026-07-29T12:30:00Z"), allowSelfApproval: false,
    })).toThrow(InsufficientAuthorityError)
  })
  it("validateApprovalDecision rejects wrong run", () => {
    const req = makeRequest({ taskRunId: "other-run" })
    const dec = makeDecision({ taskRunId: "other-run" })
    expect(() => validateApprovalDecision({
      request: req, decision: dec,
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION,
      now: new Date("2026-07-29T12:30:00Z"), allowSelfApproval: false,
    })).toThrow(ApprovalWrongRunError)
  })
  it("validateApprovalDecision rejects wrong SHA", () => {
    const req = makeRequest({ sha: "wrong-sha" })
    const dec = makeDecision({ sha: "wrong-sha" })
    expect(() => validateApprovalDecision({
      request: req, decision: dec,
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION,
      now: new Date("2026-07-29T12:30:00Z"), allowSelfApproval: false,
    })).toThrow(ApprovalWrongShaError)
  })
  it("validateApprovalDecision rejects expired", () => {
    const req = makeRequest({ expiresAt: new Date("2026-07-28T12:00:00Z") })
    const dec = makeDecision()
    expect(() => validateApprovalDecision({
      request: req, decision: dec,
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION,
      now: new Date("2026-07-29T12:30:00Z"), allowSelfApproval: false,
    })).toThrow(ApprovalExpiredError)
  })
  it("self-approval is rejected when disallowed", () => {
    const req = makeRequest({ requester: "bob" })
    const dec = makeDecision({ approver: "bob", outcome: "approved" })
    expect(() => validateApprovalDecision({
      request: req, decision: dec,
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION,
      now: new Date("2026-07-29T12:30:00Z"), allowSelfApproval: false,
    })).toThrow(InsufficientAuthorityError)
  })
  it("self-approval is allowed when explicitly permitted", () => {
    const req = makeRequest({ requester: "bob" })
    const dec = makeDecision({ approver: "bob", approverAuthority: "maintainer" })
    expect(() => validateApprovalDecision({
      request: req, decision: dec,
      expectedTaskRunId: RUN_ID, expectedSha: SHA, expectedContractVersionId: CONTRACT_VERSION,
      now: new Date("2026-07-29T12:30:00Z"), allowSelfApproval: true,
    })).not.toThrow()
  })
})
