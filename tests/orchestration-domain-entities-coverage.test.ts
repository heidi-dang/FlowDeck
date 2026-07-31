import { describe, it, expect } from "bun:test";
import { OverrideRequest, OverrideRequestTransitionError } from "../src/orchestration/override/domain/override-request";
import { ApprovalRequest, ApprovalRequestTransitionError } from "../src/orchestration/approval/domain/approval-request";
import { Evidence } from "../src/orchestration/evidence/domain/evidence";
import { VerificationResult } from "../src/orchestration/verification/domain/verification-result";
import { toInstant } from "../src/orchestration/common/types";

const NOW = toInstant(new Date());

function makeOverrideRequest(statusOverride?: any): OverrideRequest {
  return new OverrideRequest({
    id: "or-1",
    gateId: "required-assignments-complete",
    taskRunId: "run-1",
    contractVersionId: "contract-v1",
    contractFamilyId: "family-1",
    sha: "abc123",
    justification: "Approved by team lead",
    requester: "dev-1",
    requesterAuthority: "standard" as any,
    status: statusOverride ?? "requested",
    version: 1,
    createdAt: NOW,
  });
}

function makeApprovalRequest(statusOverride?: any): ApprovalRequest {
  return new ApprovalRequest({
    id: "ar-1",
    taskRunId: "run-1",
    contractVersionId: "contract-v1",
    contractFamilyId: "family-1",
    gateId: "required-assignments-complete",
    sha: "abc123",
    requester: "dev-1",
    requesterAuthority: "standard" as any,
    reason: "All criteria met",
    status: statusOverride ?? "pending",
    version: 1,
    createdAt: NOW,
  });
}

describe("OverrideRequest Domain Entity Coverage", () => {
  it("constructs with all properties", () => {
    const req = makeOverrideRequest();
    expect(req.id).toBe("or-1");
    expect(req.gateId).toBe("required-assignments-complete");
    expect(req.status).toBe("requested");
  });

  it("isActive returns true for approved non-expired", () => {
    const approved = makeOverrideRequest().approve("approver-1", "team_lead" as any, NOW);
    expect(approved.isActive).toBe(true);
    expect(approved.status).toBe("approved");
  });

  it("approve transitions from requested to approved", () => {
    const req = makeOverrideRequest();
    const approved = req.approve("approver-1", "team_lead" as any, NOW);
    expect(approved.status).toBe("approved");
    expect(approved.approver).toBe("approver-1");
    expect(approved.version).toBe(2);
  });

  it("reject transitions from requested to rejected", () => {
    const req = makeOverrideRequest();
    const rejected = req.reject("approver-1", NOW);
    expect(rejected.status).toBe("rejected");
  });

  it("revoke transitions from approved to revoked", () => {
    const approved = makeOverrideRequest().approve("approver-1", "team_lead" as any, NOW);
    const revoked = approved.revoke(NOW);
    expect(revoked.status).toBe("revoked");
  });

  it("expire transitions from requested to expired", () => {
    const expired = makeOverrideRequest().expire(NOW);
    expect(expired.status).toBe("expired");
  });

  it("consume transitions from approved to consumed", () => {
    const approved = makeOverrideRequest().approve("approver-1", "team_lead" as any, NOW);
    const consumed = approved.consume("dec-1", NOW);
    expect(consumed.status).toBe("consumed");
    expect(consumed.consumedByDecisionId).toBe("dec-1");
  });

  it("throws OverrideRequestTransitionError for invalid transition", () => {
    const req = makeOverrideRequest("rejected");
    expect(() => req.approve("approver-1", "team_lead" as any, NOW)).toThrow(OverrideRequestTransitionError);
  });

  it("belongsToRun and matchesSha work correctly", () => {
    const req = makeOverrideRequest();
    expect(req.belongsToRun("run-1")).toBe(true);
    expect(req.belongsToRun("run-x")).toBe(false);
    expect(req.matchesSha("abc123")).toBe(true);
    expect(req.matchesSha("wrong")).toBe(false);
  });

  it("isExpired returns false when no expiresAt", () => {
    const req = makeOverrideRequest();
    expect(req.isExpired()).toBe(false);
  });

  it("isExpired returns true when past expiresAt", () => {
    const req = new OverrideRequest({
      ...makeOverrideRequest(),
      expiresAt: toInstant(new Date(Date.now() - 1000)),
    });
    expect(req.isExpired()).toBe(true);
  });
});

describe("ApprovalRequest Domain Entity Coverage", () => {
  it("constructs with all properties", () => {
    const req = makeApprovalRequest();
    expect(req.id).toBe("ar-1");
    expect(req.status).toBe("pending");
    expect(req.isActive).toBe(true);
  });

  it("approve transitions from pending to approved", () => {
    const req = makeApprovalRequest();
    const approved = req.approve("approver-1", NOW);
    expect(approved.status).toBe("approved");
    expect(approved.decidedBy).toBe("approver-1");
    expect(approved.version).toBe(2);
  });

  it("reject transitions from pending to rejected", () => {
    const req = makeApprovalRequest();
    const rejected = req.reject("approver-1", "Not justified", NOW);
    expect(rejected.status).toBe("rejected");
    expect(rejected.decisionReason).toBe("Not justified");
  });

  it("revoke transitions from approved to revoked", () => {
    const approved = makeApprovalRequest().approve("approver-1", NOW);
    const revoked = approved.revoke(NOW);
    expect(revoked.status).toBe("revoked");
  });

  it("expire transitions from pending to expired", () => {
    const expired = makeApprovalRequest().expire(NOW);
    expect(expired.status).toBe("expired");
  });

  it("throws ApprovalRequestTransitionError for invalid transition", () => {
    const rejected = makeApprovalRequest("rejected");
    expect(() => rejected.approve("approver-1", NOW)).toThrow(ApprovalRequestTransitionError);
  });

  it("belongsToRun, matchesSha, matchesContract work correctly", () => {
    const req = makeApprovalRequest();
    expect(req.belongsToRun("run-1")).toBe(true);
    expect(req.belongsToRun("run-x")).toBe(false);
    expect(req.matchesSha("abc123")).toBe(true);
    expect(req.matchesSha("wrong")).toBe(false);
    expect(req.matchesContract("contract-v1")).toBe(true);
    expect(req.matchesContract("wrong")).toBe(false);
  });

  it("isExpired returns false with no expiresAt", () => {
    const req = makeApprovalRequest();
    expect(req.isExpired(NOW)).toBe(false);
  });

  it("isActive returns false for rejected", () => {
    const rejected = makeApprovalRequest("rejected");
    expect(rejected.isActive).toBe(false);
  });
});

describe("Evidence Domain Entity Coverage", () => {
  it("constructs and exposes all properties", () => {
    const ev = new Evidence({
      id: "ev-1",
      runId: "run-1",
      content: "test data",
      contentType: "text/plain",
      sha: "abc123",
      criterionIds: ["ac-1", "ac-2"],
      status: "current",
      createdAt: new Date(),
    });
    expect(ev.id).toBe("ev-1");
    expect(ev.isArchived).toBe(false);
    expect(ev.matchesSha("abc123")).toBe(true);
    expect(ev.matchesSha("wrong")).toBe(false);
    expect(ev.belongsToRun("run-1")).toBe(true);
    expect(ev.belongsToRun("run-x")).toBe(false);
  });

  it("archive creates archived copy preserving content", () => {
    const ev = new Evidence({
      id: "ev-1", runId: "run-1", content: "test",
      contentType: "text/plain", sha: "abc", criterionIds: [],
      status: "current", createdAt: new Date(),
    });
    const archived = ev.archive(new Date());
    expect(archived.isArchived).toBe(true);
    expect(archived.content).toBe("test");
    expect(archived.status).toBe("archived");
  });
});

describe("VerificationResult Domain Entity Coverage", () => {
  it("constructs and exposes all properties", () => {
    const vr = new VerificationResult({
      id: "vr-1",
      runId: "run-1",
      ruleId: "rule-1",
      ruleDescription: "Lint check",
      scope: "global" as any,
      required: true,
      failureClass: "blocking" as any,
      status: "passed",
      targetSha: "abc123",
      evidenceIds: ["ev-1"],
      createdAt: new Date(),
    });
    expect(vr.id).toBe("vr-1");
    expect(vr.isTerminal).toBe(true);
    expect(vr.isPassing).toBe(true);
  });

  it("withStatus creates new result with updated status", () => {
    const vr = new VerificationResult({
      id: "vr-1", runId: "run-1", ruleId: "rule-1", ruleDescription: "Check",
      scope: "global" as any, required: true, failureClass: "blocking" as any,
      status: "pending", targetSha: "abc", evidenceIds: [], createdAt: new Date(),
    });
    const failed = vr.withStatus("failed", new Date());
    expect(failed.status).toBe("failed");
    expect(failed.isTerminal).toBe(true);
    expect(failed.isPassing).toBe(false);
  });

  it("running status is not terminal", () => {
    const vr = new VerificationResult({
      id: "vr-1", runId: "run-1", ruleId: "rule-1", ruleDescription: "Check",
      scope: "global" as any, required: true, failureClass: "blocking" as any,
      status: "running", targetSha: "abc", evidenceIds: [], createdAt: new Date(),
    });
    expect(vr.isTerminal).toBe(false);
  });
});
