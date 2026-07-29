import { describe, it, expect } from "bun:test"
import { ApprovalRequest } from "@/orchestration/approval/domain/approval-request"
import { ApprovalDecision } from "@/orchestration/approval/domain/approval-decision"
import { DEFAULT_APPROVAL_POLICY, getMinimumAuthorityForGate } from "@/orchestration/approval/domain/approval-policy"
import { checkApprovalGate, validateApprovalBinding } from "@/orchestration/approval/policies/approval-policy"
import { hasSufficientAuthority } from "@/orchestration/common/types"
import { InsufficientAuthorityError, ApprovalWrongRunError, ApprovalWrongShaError } from "@/orchestration/approval/domain/errors"
import type { Instant, PolicyVersion, AuthorityLevel } from "@/orchestration/common/types"

const RUN_ID = "run-1"
const SHA = "abc123"
const CONTRACT_VERSION = "version-1"
const FAMILY_ID = "fam-1"
const GATE_ID = "verification-policy-satisfied"
const NOW = "2026-07-29T12:30:00.000Z" as Instant
const PV = "1.0.0" as PolicyVersion

function makeRequest(overrides: Record<string, unknown> = {}): ApprovalRequest {
  return new ApprovalRequest({
    id: "req-1", taskRunId: RUN_ID, contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID,
    gateId: GATE_ID, sha: SHA, requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
    reason: "Need override", status: "pending", version: 1,
    createdAt: "2026-07-29T12:00:00.000Z" as Instant,
    ...overrides,
  })
}

function makeDecision(overrides: Record<string, unknown> = {}): ApprovalDecision {
  return new ApprovalDecision({
    id: "dec-1", requestId: "req-1", taskRunId: RUN_ID, contractFamilyId: FAMILY_ID,
    contractVersionId: CONTRACT_VERSION, gateId: GATE_ID, sha: SHA,
    outcome: "approved", approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
    reason: "Approved", createdAt: "2026-07-29T12:00:00.000Z" as Instant, policyVersion: PV,
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
    const approved = req.approve("bob", "2026-07-29T13:00:00.000Z" as Instant)
    expect(approved.status).toBe("approved")
    expect(approved.decidedBy).toBe("bob")
    expect(approved.isActive).toBe(true)
  })
  it("can be rejected", () => {
    const req = makeRequest()
    const rejected = req.reject("bob", "Not good", "2026-07-29T13:00:00.000Z" as Instant)
    expect(rejected.status).toBe("rejected")
    expect(rejected.isActive).toBe(false)
  })
  it("can be revoked", () => {
    const req = makeRequest({ status: "approved" })
    const revoked = req.revoke("2026-07-29T13:00:00.000Z" as Instant)
    expect(revoked.status).toBe("revoked")
    expect(revoked.isActive).toBe(false)
  })
  it("rejects invalid transitions", () => {
    const req = makeRequest({ status: "rejected" })
    expect(() => req.approve("bob", "2026-07-29T13:00:00.000Z" as Instant)).toThrow()
  })
  it("approval decision is frozen", () => {
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

describe("Approval gate check", () => {
  it("pending approval does not satisfy", () => {
    const req = makeRequest()
    const r = checkApprovalGate(req, undefined, RUN_ID, SHA, CONTRACT_VERSION, NOW, DEFAULT_APPROVAL_POLICY)
    expect(r.satisfied).toBe(false)
  })
  it("approved with valid decision satisfies", () => {
    const req = makeRequest({ status: "approved" })
    const dec = makeDecision()
    const r = checkApprovalGate(req, dec, RUN_ID, SHA, CONTRACT_VERSION, NOW, DEFAULT_APPROVAL_POLICY)
    expect(r.satisfied).toBe(true)
  })
  it("rejected does not satisfy", () => {
    const req = makeRequest({ status: "rejected" })
    const r = checkApprovalGate(req, undefined, RUN_ID, SHA, CONTRACT_VERSION, NOW, DEFAULT_APPROVAL_POLICY)
    expect(r.satisfied).toBe(false)
  })
  it("wrong run does not satisfy", () => {
    const req = makeRequest({ taskRunId: "other-run", status: "approved" })
    const dec = makeDecision({ taskRunId: "other-run" })
    const r = checkApprovalGate(req, dec, RUN_ID, SHA, CONTRACT_VERSION, NOW, DEFAULT_APPROVAL_POLICY)
    expect(r.satisfied).toBe(false)
  })
  it("no request fails", () => {
    const r = checkApprovalGate(undefined as any, undefined, RUN_ID, SHA, CONTRACT_VERSION, NOW, DEFAULT_APPROVAL_POLICY)
    expect(r.satisfied).toBe(false)
  })
})

describe("Authority", () => {
  it("hasSufficientAuthority works", () => {
    expect(hasSufficientAuthority("maintainer", "reviewer")).toBe(true)
    expect(hasSufficientAuthority("reviewer", "maintainer")).toBe(false)
  })
  it("validateApprovalBinding rejects wrong run", () => {
    const req = makeRequest({ taskRunId: "other-run" })
    const dec = makeDecision({ taskRunId: "other-run" })
    expect(() => validateApprovalBinding(req, dec, RUN_ID, SHA, CONTRACT_VERSION, NOW, DEFAULT_APPROVAL_POLICY))
      .toThrow(ApprovalWrongRunError)
  })
  it("validateApprovalBinding rejects wrong SHA", () => {
    const req = makeRequest({ sha: "wrong-sha" })
    const dec = makeDecision({ sha: "wrong-sha" })
    expect(() => validateApprovalBinding(req, dec, RUN_ID, SHA, CONTRACT_VERSION, NOW, DEFAULT_APPROVAL_POLICY))
      .toThrow(ApprovalWrongShaError)
  })
  it("self-approval rejected by default policy", () => {
    const req = makeRequest({ requester: "bob" })
    const dec = makeDecision({ approver: "bob", outcome: "approved" })
    expect(() => validateApprovalBinding(req, dec, RUN_ID, SHA, CONTRACT_VERSION, NOW, DEFAULT_APPROVAL_POLICY))
      .toThrow(InsufficientAuthorityError)
  })
  it("getMinimumAuthorityForGate returns expected", () => {
    expect(getMinimumAuthorityForGate("verification-policy-satisfied" as any)).toBe("reviewer")
  })
})
