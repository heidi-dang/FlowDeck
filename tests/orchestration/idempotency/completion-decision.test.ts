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
import { IdempotencyConflictError } from "@/orchestration/idempotency/domain/errors"
import { createEvent } from "@/orchestration/events/domain/event-definitions"
import { getCompletionPolicyVersion } from "@/orchestration/completion/domain/policy-version"

const RUN_ID = "run-1"
const SHA = "abc123"
const CONTRACT_VERSION = "version-1"
const FAMILY_ID = "fam-1"
const CORRELATION_ID = "corr-1"

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

let decisionIdCounter = 0
function nextId() { return `dec-${++decisionIdCounter}` }

describe("Completion decision", () => {
  it("creates immutable decision", () => {
    const evaluation = aggregateEvaluation([createGateResult("required-assignments-complete", true)])
    const decision = new CompletionDecision({
      id: "dec-1", taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA, evaluation, outcome: "completed", appliedOverrideIds: [], approvalIds: [],
      failureReasons: [], decisionTimestamp: new Date(), policyVersion: "1.0.0",
      correlationId: CORRELATION_ID, idempotencyKey: "key-1", createdAt: new Date(),
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
      overrides: [], approvalRequests: [], correlationId: CORRELATION_ID,
      idempotencyKey: "key-2", now: new Date(),
    }, { generate: () => nextId() } as any)

    expect(result.decision.outcome).toBe("completed")
    expect(result.decision.policyVersion).toBe(getCompletionPolicyVersion())
  })

  it("overridable gate fails with valid override passes", async () => {
    const repo = new InMemoryCompletionRepository()
    const service = new CompletionDecisionService(repo)

    // Gate 5 (verification-policy-satisfied) fails because a required verification rule failed
    const override = new OverrideRequest({
      id: "ovr-1", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
      contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
      justification: "Need", requester: "alice", requesterAuthority: "operator",
      status: "approved", approver: "bob", approverAuthority: "maintainer",
      createdAt: new Date(),
    })

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA,
      evaluationInput: stubbedEvalInput({
        verificationResults: [{ id: "vr-1", runId: RUN_ID, ruleId: "vr-1", ruleDescription: "Required rule", scope: "unit", required: true, failureClass: "blocking", status: "failed", targetSha: SHA, evidenceIds: [], createdAt: new Date() } as any],
      }),
      overrides: [override], approvalRequests: [],
      correlationId: CORRELATION_ID, idempotencyKey: "key-3", now: new Date(),
    }, { generate: () => nextId() } as any)

    expect(result.decision.outcome).toBe("completed")
    expect(result.decision.appliedOverrideIds).toContain("ovr-1")
  })

  it("non-overridable gate fails → rejected", async () => {
    const repo = new InMemoryCompletionRepository()
    const service = new CompletionDecisionService(repo)

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA,
      evaluationInput: stubbedEvalInput({
        verificationResults: [{ id: "vr-1", runId: "other-run", ruleId: "rule-1", ruleDescription: "R", scope: "unit", required: true, failureClass: "blocking", status: "passed", targetSha: SHA, evidenceIds: [], createdAt: new Date() } as any],
      }),
      overrides: [], approvalRequests: [],
      correlationId: CORRELATION_ID, idempotencyKey: "key-4", now: new Date(),
    }, { generate: () => nextId() } as any)

    expect(result.decision.outcome).not.toBe("completed")
  })

  it("override with approval works", async () => {
    const repo = new InMemoryCompletionRepository()
    const service = new CompletionDecisionService(repo)

    const override = new OverrideRequest({
      id: "ovr-2", gateId: "verification-policy-satisfied", taskRunId: RUN_ID,
      contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID, sha: SHA,
      justification: "Need", requester: "alice", requesterAuthority: "operator",
      status: "approved", approver: "bob", approverAuthority: "maintainer",
      createdAt: new Date(),
    })
    const approvalReq = new ApprovalRequest({
      id: "ar-1", taskRunId: RUN_ID, contractVersionId: CONTRACT_VERSION, contractFamilyId: FAMILY_ID,
      gateId: "verification-policy-satisfied", sha: SHA, requester: "alice", requesterAuthority: "operator",
      reason: "Need", status: "approved", createdAt: new Date(),
    })
    const approvalDec = new ApprovalDecision({
      id: "ad-1", requestId: "ar-1", taskRunId: RUN_ID, contractFamilyId: FAMILY_ID,
      contractVersionId: CONTRACT_VERSION, gateId: "verification-policy-satisfied", sha: SHA,
      outcome: "approved", approver: "bob", approverAuthority: "maintainer",
      reason: "OK", createdAt: new Date(), policyVersion: "1.0.0",
    })

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA,
      evaluationInput: stubbedEvalInput({
        verificationResults: [{ id: "vr-1", runId: RUN_ID, ruleId: "vr-1", ruleDescription: "Required rule", scope: "unit", required: true, failureClass: "blocking", status: "failed", targetSha: SHA, evidenceIds: [], createdAt: new Date() } as any],
      }),
      overrides: [override], approvalRequests: [{ request: approvalReq, decision: approvalDec }],
      correlationId: CORRELATION_ID, idempotencyKey: "key-5", now: new Date(),
    }, { generate: () => nextId() } as any)

    expect(result.decision.outcome).toBe("completed")
    expect(result.decision.approvalIds).toContain("ad-1")
  })

  it("records policy version in decision", async () => {
    const repo = new InMemoryCompletionRepository()
    const service = new CompletionDecisionService(repo)

    const result = await service.evaluateAndDecide({
      taskRunId: RUN_ID, contractFamilyId: FAMILY_ID, contractVersionId: CONTRACT_VERSION,
      evaluatedSha: SHA, evaluationInput: stubbedEvalInput(),
      overrides: [], approvalRequests: [], correlationId: CORRELATION_ID,
      idempotencyKey: "key-6", now: new Date(),
    }, { generate: () => nextId() } as any)

    expect(result.decision.policyVersion).toBe("1.0.0")
  })
})

describe("Idempotency", () => {
  it("same key and same payload returns original result", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    let executionCount = 0
    const command = () => service.execute({
      commandType: "completion.decision", taskRunId: RUN_ID, idempotencyKey: "idem-1",
      payload: { sha: SHA },
      execute: async () => { executionCount++; return { resultType: "decision", resultId: "dec-1", result: { id: "dec-1", outcome: "completed" } } },
    })

    const r1 = await command()
    expect(r1).toEqual({ id: "dec-1", outcome: "completed" })
    expect(executionCount).toBe(1)

    const r2 = await command()
    expect(r2).toBeDefined()
    expect(executionCount).toBe(1) // Not executed again
  })

  it("same key with different payload fails", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    await service.execute({
      commandType: "completion.decision", taskRunId: RUN_ID, idempotencyKey: "idem-2",
      payload: { sha: SHA },
      execute: async () => ({ resultType: "decision", resultId: "dec-2", result: { id: "dec-2" } }),
    })

    expect(service.execute({
      commandType: "completion.decision", taskRunId: RUN_ID, idempotencyKey: "idem-2",
      payload: { sha: "different" },
      execute: async () => ({ resultType: "decision", resultId: "dec-3", result: { id: "dec-3" } }),
    })).rejects.toThrow(IdempotencyConflictError)
  })

  it("different keys for different runs are independent", async () => {
    const repo = new InMemoryIdempotencyRepository()
    const service = new IdempotencyService(repo)

    const r1 = await service.execute({
      commandType: "approval.request", taskRunId: "run-a", idempotencyKey: "key-1",
      payload: { gate: "g1" },
      execute: async () => ({ resultType: "request", resultId: "req-a", result: { id: "req-a" } }),
    })
    const r2 = await service.execute({
      commandType: "approval.request", taskRunId: "run-b", idempotencyKey: "key-1",
      payload: { gate: "g1" },
      execute: async () => ({ resultType: "request", resultId: "req-b", result: { id: "req-b" } }),
    })
    expect(r1).toEqual({ id: "req-a" })
    expect(r2).toEqual({ id: "req-b" })
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
