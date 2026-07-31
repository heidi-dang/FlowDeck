import { describe, it, expect } from "bun:test"
import { CompletionDecision } from "@/orchestration/completion/decision/completion-decision"
import { CompletionDecisionService } from "@/orchestration/completion/services/decision-service"
import { InMemoryCompletionRepository } from "@/orchestration/completion/adapters/in-memory-completion-repository"
import { aggregateEvaluation, createGateResult } from "@/orchestration/completion/domain/evaluation"
import { OverrideRequest } from "@/orchestration/override/domain/override-request"
import { ApprovalRequest } from "@/orchestration/approval/domain/approval-request"
import { ApprovalDecision } from "@/orchestration/approval/domain/approval-decision"
import { IdempotencyService } from "@/orchestration/idempotency/domain/idempotency-service"
import { InMemoryIdempotencyRepository } from "@/orchestration/idempotency/adapters/in-memory-idempotency-repository"
import { InMemoryOverrideRepository } from "@/orchestration/override/adapters/in-memory-override-repository"
import { createEvent } from "@/orchestration/events/domain/event-definitions"
import { getCompletionPolicyVersion } from "@/orchestration/completion/domain/policy-version"
import { hashFingerprint } from "@/orchestration/common/canonical-hash"
import type { Instant, PolicyVersion, AuthorityLevel } from "@/orchestration/common/types"

const RUN_ID = "run-1"
const SHA = "abc123"
const CONTRACT_VERSION = "version-1"
const FAMILY_ID = "fam-1"
const CORRELATION_ID = "corr-1"
const NOW = "2026-07-29T12:30:00.000Z" as Instant
const PV = "1.0.0" as PolicyVersion

function stubbedEvalInput(overrides: Record<string, any> = {}) {
  return {
    requiredAssignmentsComplete: true,
    currentSha: SHA,
    verificationResults: [],
    expectedRunId: RUN_ID,
    requirements: [],
    acceptanceCriteria: [],
    evidenceItems: [],
    ...overrides,
  }
}

describe("Completion decision", () => {
  it("creates immutable decision", () => {
    const evaluation = aggregateEvaluation([createGateResult("required-assignments-complete", true)])
    const decision = new CompletionDecision({
      id: "dec-1", taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA, evaluation, outcome: "completed", appliedOverrideIds: [], approvalIds: [],
      failureReasons: [], decisionTimestamp: NOW, policyVersion: PV,
      correlationId: CORRELATION_ID, idempotencyKey: "key-1", createdAt: NOW,
    })
    expect(decision.outcome).toBe("completed")
    expect(Object.isFrozen(decision)).toBe(true)
  })

  it("all six gates pass → completed", async () => {
    const repo = new InMemoryCompletionRepository()
    const service = new CompletionDecisionService(repo)

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA,
      evaluationInput: stubbedEvalInput({
        verificationResults: [{ id: "vr-1", runId: RUN_ID, ruleId: "rule-1", ruleDescription: "R", scope: "unit", required: true, failureClass: "blocking", status: "passed", targetSha: SHA, evidenceIds: [], createdAt: new Date() } as any],
      }),
      overrides: [], approvalPairs: [], correlationId: CORRELATION_ID,
      idempotencyKey: "key-2", now: NOW,
    })

    expect(result.decision.outcome).toBe("completed")
    expect(result.decision.policyVersion).toBe(getCompletionPolicyVersion())
  })

  it("overridable gate with valid override passes", async () => {
    const repo = new InMemoryCompletionRepository()
    const service = new CompletionDecisionService(repo)

    const override = new OverrideRequest({
      id: "ovr-1", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
      contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
      justification: "Need", requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
      status: "approved", version: 1, approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
      createdAt: NOW,
    })

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA,
      evaluationInput: stubbedEvalInput({
        verificationResults: [{ id: "vr-1", runId: RUN_ID, ruleId: "vr-1", ruleDescription: "Required rule", scope: "unit", required: true, failureClass: "blocking", status: "failed", targetSha: SHA, evidenceIds: [], createdAt: new Date() } as any],
      }),
      overrides: [override], approvalPairs: [],
      correlationId: CORRELATION_ID, idempotencyKey: "key-3", now: NOW,
    })

    expect(result.decision.outcome).toBe("completed")
    expect(result.decision.appliedOverrideIds).toContain("ovr-1")
  })

  it("overridable gate with override + approval works", async () => {
    const repo = new InMemoryCompletionRepository()
    const service = new CompletionDecisionService(repo)

    const override = new OverrideRequest({
      id: "ovr-2", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
      contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
      justification: "Need", requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
      status: "approved", version: 1, approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
      createdAt: NOW,
    })
    const approvalReq = new ApprovalRequest({
      id: "ar-1", taskRunId: RUN_ID, contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID,
      gateId: "verification-policy-satisfied", sha: SHA, requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
      reason: "Need", status: "approved", version: 1, createdAt: NOW,
    })
    const approvalDec = new ApprovalDecision({
      id: "ad-1", requestId: "ar-1", taskRunId: RUN_ID, contractFamilyId: FAMILY_ID,
      contractVersionId: CONTRACT_VERSION, gateId: "verification-policy-satisfied", sha: SHA,
      outcome: "approved", approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
      reason: "OK", createdAt: NOW, policyVersion: PV,
    })

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA,
      evaluationInput: stubbedEvalInput({
        verificationResults: [{ id: "vr-1", runId: RUN_ID, ruleId: "vr-1", ruleDescription: "Required rule", scope: "unit", required: true, failureClass: "blocking", status: "failed", targetSha: SHA, evidenceIds: [], createdAt: new Date() } as any],
      }),
      overrides: [override], approvalPairs: [{ request: approvalReq, decision: approvalDec }],
      correlationId: CORRELATION_ID, idempotencyKey: "key-5", now: NOW,
    })

    expect(result.decision.outcome).toBe("completed")
    expect(result.decision.appliedOverrideIds).toContain("ovr-2")
  })

  it("records policy version in decision", async () => {
    const repo = new InMemoryCompletionRepository()
    const service = new CompletionDecisionService(repo)

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA, evaluationInput: stubbedEvalInput(),
      overrides: [], approvalPairs: [], correlationId: CORRELATION_ID,
      idempotencyKey: "key-6", now: NOW,
    })

    expect(result.decision.policyVersion).toBe(PV)
  })
})

describe("Idempotency — reservation-first API", () => {
  it("acquired → can proceed with execution", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    const result = await service.tryReserve("completion.decision", RUN_ID, "idem-1", { sha: SHA }, NOW)
    expect(result.status).toBe("acquired")
  })

  it("completed with same payload → replay", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    const fp = { sha: SHA, taskRunId: RUN_ID }
    const r1 = await service.tryReserve("completion.decision", RUN_ID, "idem-2", fp, NOW)
    expect(r1.status).toBe("acquired")
    await service.complete("completion.decision", RUN_ID, "idem-2", "decision", "dec-1", NOW)

    const r2 = await service.tryReserve("completion.decision", RUN_ID, "idem-2", fp, NOW)
    expect(r2.status).toBe("completed")
    if (r2.status === "completed") {
      expect(r2.record.resultId).toBe("dec-1")
    }
  })

  it("different payload → conflict", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    await service.tryReserve("completion.decision", RUN_ID, "idem-3", { sha: "abc" }, NOW)
    await service.complete("completion.decision", RUN_ID, "idem-3", "decision", "dec-3", NOW)

    const r2 = await service.tryReserve("completion.decision", RUN_ID, "idem-3", { sha: "def" }, NOW)
    expect(r2.status).toBe("conflict")
  })

  it("in_progress when another command holds key", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    await service.tryReserve("completion.decision", RUN_ID, "idem-4", { sha: SHA }, NOW)
    const r2 = await service.tryReserve("completion.decision", RUN_ID, "idem-4", { sha: SHA }, NOW)
    expect(r2.status).toBe("in_progress")
  })

  it("released reservation does not block retry", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    await service.tryReserve("completion.decision", RUN_ID, "idem-5", { sha: SHA }, NOW)
    await service.release("completion.decision", RUN_ID, "idem-5")

    const r2 = await service.tryReserve("completion.decision", RUN_ID, "idem-5", { sha: SHA }, NOW)
    expect(r2.status).toBe("acquired")
  })

  it("override CAS: consume with correct version succeeds", async () => {
    const repo = new InMemoryOverrideRepository()
    const override = new OverrideRequest({
      id: "ovr-cas", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
      contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
      justification: "Test", requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
      status: "approved", version: 1, approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
      createdAt: NOW,
    })
    await repo.saveRequest(override)
    await repo.consume("ovr-cas", "dec-cas", 1, NOW)


    const stored = await repo.getRequest("ovr-cas")
    expect(stored?.status).toBe("consumed")
    expect(stored?.consumedByDecisionId).toBe("dec-cas")
  })

  it("override CAS: stale version fails", async () => {
    const repo = new InMemoryOverrideRepository()
    const override = new OverrideRequest({
      id: "ovr-stale", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
      contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
      justification: "Test", requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
      status: "approved", version: 1, approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
      createdAt: NOW,
    })
    await repo.saveRequest(override)
    await expect(repo.consume("ovr-stale", "dec-stale", 0, NOW)).rejects.toThrow()
  })
})

describe("Canonical hashing", () => {
  it("different key order → same hash", () => {
    const h1 = hashFingerprint({ a: 1, b: 2, c: { d: 3, e: 4 } })
    const h2 = hashFingerprint({ c: { e: 4, d: 3 }, b: 2, a: 1 })
    expect(h1).toBe(h2)
  })

  it("different array order → different hash", () => {
    const h1 = hashFingerprint({ items: [1, 2, 3] })
    const h2 = hashFingerprint({ items: [3, 2, 1] })
    expect(h1).not.toBe(h2)
  })

  it("different override version → different hash", () => {
    const h1 = hashFingerprint({ overrideId: "ovr-1", version: 1 })
    const h2 = hashFingerprint({ overrideId: "ovr-1", version: 2 })
    expect(h1).not.toBe(h2)
  })
})

describe("Domain events", () => {
  it("creates a domain event with required fields", () => {
    const event = createEvent("ApprovalRequested", "agg-1", RUN_ID, CORRELATION_ID, "1.0.0", { requestId: "req-1" }, NOW)
    expect(event.eventType).toBe("ApprovalRequested")
    expect(event.aggregateId).toBe("agg-1")
    expect(event.taskRunId).toBe(RUN_ID)
  })
  it("event payload is frozen", () => {
    const event = createEvent("CompletionEvaluated", "agg-1", RUN_ID, CORRELATION_ID, "1.0.0", { result: "pass" }, NOW)
    expect(Object.isFrozen(event.payload)).toBe(true)
  })
  it("CompletionRejected event type exists", () => {
    const event = createEvent("CompletionRejected", "dec-1", RUN_ID, CORRELATION_ID, "1.0.0", { failureReasons: ["test"] }, NOW)
    expect(event.eventType).toBe("CompletionRejected")
  })
})
