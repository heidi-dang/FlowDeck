import { describe, it, expect } from "bun:test"
import { CompletionDecision } from "@/orchestration/completion/decision/completion-decision"
import { CompletionDecisionService } from "@/orchestration/completion/services/decision-service"
import { InMemoryCompletionRepository } from "@/orchestration/completion/adapters/in-memory-completion-repository"
import { InMemoryOverrideRepository } from "@/orchestration/override/adapters/in-memory-override-repository"
import { aggregateEvaluation, createGateResult } from "@/orchestration/completion/domain/evaluation"
import { OverrideRequest } from "@/orchestration/override/domain/override-request"
import { ApprovalRequest } from "@/orchestration/approval/domain/approval-request"
import { ApprovalDecision } from "@/orchestration/approval/domain/approval-decision"
import { IdempotencyService } from "@/orchestration/idempotency/domain/idempotency-service"
import { InMemoryIdempotencyRepository } from "@/orchestration/idempotency/adapters/in-memory-idempotency-repository"
import { IdempotencyConflictError } from "@/orchestration/idempotency/domain/errors"
import { createEvent } from "@/orchestration/events/domain/event-definitions"
import { getCompletionPolicyVersion } from "@/orchestration/completion/domain/policy-version"
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
    const overrideRepo = new InMemoryOverrideRepository()
    const service = new CompletionDecisionService(repo, overrideRepo)

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
    const overrideRepo = new InMemoryOverrideRepository()
    const service = new CompletionDecisionService(repo, overrideRepo)

    const override = new OverrideRequest({
      id: "ovr-1", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
      contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
      justification: "Need", requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
      status: "approved", version: 1, approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
      createdAt: NOW,
    })
    // Save override to repository so it can be consumed
    await overrideRepo.saveRequest(override)

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
    const overrideRepo = new InMemoryOverrideRepository()
    const service = new CompletionDecisionService(repo, overrideRepo)

    const override = new OverrideRequest({
      id: "ovr-2", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
      contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
      justification: "Need", requester: "alice", requesterAuthority: "operator" as AuthorityLevel,
      status: "approved", version: 1, approver: "bob", approverAuthority: "maintainer" as AuthorityLevel,
      createdAt: NOW,
    })
    await overrideRepo.saveRequest(override)
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
    const overrideRepo = new InMemoryOverrideRepository()
    const service = new CompletionDecisionService(repo, overrideRepo)

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA, evaluationInput: stubbedEvalInput(),
      overrides: [], approvalPairs: [], correlationId: CORRELATION_ID,
      idempotencyKey: "key-6", now: NOW,
    })

    expect(result.decision.policyVersion).toBe(PV)
  })
})

describe("Idempotency", () => {
  it("same key and payload → replayed", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    await service.record("completion.decision", RUN_ID, "idem-1", { sha: SHA }, "decision", "dec-1")
    const check = await service.check("completion.decision", RUN_ID, "idem-1", { sha: SHA })
    expect(check.replayed).toBe(true)
    expect(check.result?.resultId).toBe("dec-1")
  })

  it("same key different payload → conflict", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    await service.record("completion.decision", RUN_ID, "idem-2", { sha: SHA }, "decision", "dec-2")
    await expect(service.check("completion.decision", RUN_ID, "idem-2", { sha: "different" }))
      .rejects.toThrow(IdempotencyConflictError)
  })

  it("different runs with same key are independent", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    await service.record("approval.request", "run-a", "key-1", { gate: "g1" }, "request", "req-a")
    await service.record("approval.request", "run-b", "key-1", { gate: "g1" }, "request", "req-b")

    const checkA = await service.check("approval.request", "run-a", "key-1", { gate: "g1" })
    expect(checkA.replayed).toBe(true)
    expect(checkA.result?.resultId).toBe("req-a")

    const checkB = await service.check("approval.request", "run-b", "key-1", { gate: "g1" })
    expect(checkB.replayed).toBe(true)
    expect(checkB.result?.resultId).toBe("req-b")
  })
})

describe("Domain events", () => {
  it("creates a domain event with required fields", () => {
    const event = createEvent("ApprovalRequested", "agg-1", RUN_ID, CORRELATION_ID, "1.0.0", { requestId: "req-1" })
    expect(event.eventType).toBe("ApprovalRequested")
    expect(event.aggregateId).toBe("agg-1")
    expect(event.taskRunId).toBe(RUN_ID)
    expect(event.payload).toEqual({ requestId: "req-1" })
  })
  it("creates event with causation ID", () => {
    const event = createEvent("ApprovalGranted", "agg-1", RUN_ID, CORRELATION_ID, "1.0.0", {}, "cause-1")
    expect(event.causationId).toBe("cause-1")
  })
  it("event payload is frozen", () => {
    const event = createEvent("CompletionEvaluated", "agg-1", RUN_ID, CORRELATION_ID, "1.0.0", { result: "pass" })
    expect(Object.isFrozen(event.payload)).toBe(true)
  })
})
