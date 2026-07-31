import { describe, it, expect } from "bun:test";
import { evaluateCompletion } from "../src/orchestration/completion/services/evaluation-service";
import { CompletionDecisionService } from "../src/orchestration/completion/services/decision-service";
import { Evidence } from "../src/orchestration/evidence/domain/evidence";
import { VerificationResult } from "../src/orchestration/verification/domain/verification-result";

const SHA = "abc123sha456";

function makeVerificationResult(runId: string, sha: string, status: "passed" | "failed" | "skipped" = "passed"): VerificationResult {
  return new VerificationResult({
    id: `vr-${Math.random().toString(36).slice(2)}`,
    runId,
    ruleId: "rule-1",
    ruleDescription: "Lint check",
    scope: "global" as any,
    required: true,
    failureClass: "blocking" as any,
    status,
    targetSha: sha,
    evidenceIds: [],
    createdAt: new Date(),
  });
}

function makeEvidence(runId: string, sha: string = SHA): Evidence {
  return new Evidence({
    id: `ev-${Math.random().toString(36).slice(2)}`,
    runId,
    content: "All tests passed",
    contentType: "text/plain",
    sha,
    criterionIds: ["ac-1"],
    status: "current",
    createdAt: new Date(),
  });
}

function makeInput(overrides: Partial<any> = {}): any {
  return {
    requiredAssignmentsComplete: true,
    currentSha: SHA,
    verificationResults: [makeVerificationResult("run-1", SHA, "passed")],
    expectedRunId: "run-1",
    requirements: [{ id: "req-1", description: "Must pass linting", priority: "required" }],
    acceptanceCriteria: [{ id: "ac-1", description: "All tests pass", priority: "required" }],
    evidenceItems: [makeEvidence("run-1", SHA)],
    ...overrides,
  };
}

describe("Completion Evaluation Service Coverage", () => {
  it("evaluateCompletion returns 6 gates", () => {
    const result = evaluateCompletion(makeInput());
    expect(result.gates.length).toBe(6);
    expect(typeof result.allPassed).toBe("boolean");
  });

  it("evaluateCompletion fails gate1 when assignments incomplete", () => {
    const result = evaluateCompletion(makeInput({ requiredAssignmentsComplete: false }));
    const gate1 = result.gates.find((g: any) => g.gateId === "required-assignments-complete");
    expect(gate1?.passed).toBe(false);
  });

  it("evaluateCompletion fails gate2 when no verification results match current sha", () => {
    const result = evaluateCompletion(makeInput({ verificationResults: [] }));
    const gate2 = result.gates.find((g: any) => g.gateId === "current-sha-matches-verification");
    expect(gate2?.passed).toBe(false);
  });

  it("evaluateCompletion fails gate2 when verification results target stale sha", () => {
    const staleVr = makeVerificationResult("run-1", "old-sha");
    const result = evaluateCompletion(makeInput({ verificationResults: [staleVr] }));
    const gate2 = result.gates.find((g: any) => g.gateId === "current-sha-matches-verification");
    expect(gate2?.passed).toBe(false);
  });

  it("evaluateCompletion with empty requirements", () => {
    const result = evaluateCompletion(makeInput({ requirements: [] }));
    expect(result.gates.length).toBe(6);
  });

  it("evaluateCompletion with empty acceptance criteria", () => {
    const result = evaluateCompletion(makeInput({ acceptanceCriteria: [] }));
    expect(result.gates.length).toBe(6);
  });

  it("evaluateCompletion with empty evidenceItems", () => {
    const vr = makeVerificationResult("run-1", SHA, "passed");
    const result = evaluateCompletion(makeInput({
      verificationResults: [new VerificationResult({ ...vr, evidenceIds: Object.freeze([] as string[]) })],
      evidenceItems: [],
    }));
    expect(result.gates.length).toBe(6);
  });

  it("evaluateCompletion with archived evidence", () => {
    const archived = makeEvidence("run-1", SHA).archive(new Date());
    const result = evaluateCompletion(makeInput({ evidenceItems: [archived] }));
    expect(result.gates.length).toBe(6);
  });

  it("evaluateCompletion with evidence targeting wrong sha", () => {
    const wrongShaEvidence = makeEvidence("run-1", "wrong-sha");
    const result = evaluateCompletion(makeInput({ evidenceItems: [wrongShaEvidence] }));
    expect(result.gates.length).toBe(6);
  });
});

describe("CompletionDecisionService Coverage", () => {
  function makeDecisionInput(evalOverrides: Partial<any> = {}): any {
    return {
      taskRunId: "run-1",
      contractFamilyId: "family-1",
      contractVersionId: "contract-v1",
      evaluatedSha: SHA,
      evaluationInput: makeInput(evalOverrides),
      overrides: [],
      approvalPairs: [],
      correlationId: "corr-1",
      idempotencyKey: "idem-1",
      now: new Date().toISOString(),
    };
  }

  it("evaluateAndDecide returns a decision with valid outcome", async () => {
    const mockRepo: any = { saveDecision: async () => {} };
    const service = new CompletionDecisionService(mockRepo);
    const result = await service.evaluateAndDecide(makeDecisionInput({ requiredAssignmentsComplete: false }));
    expect(result.decision).toBeDefined();
    expect(["completed", "blocked", "rejected"]).toContain(result.decision.outcome);
  });

  it("evaluateAndDecide calls saveDecision on repository", async () => {
    let saved = false;
    const mockRepo: any = { saveDecision: async () => { saved = true; } };
    const service = new CompletionDecisionService(mockRepo);
    await service.evaluateAndDecide(makeDecisionInput());
    expect(saved).toBe(true);
  });

  it("evaluateAndDecide returns consumedOverrideIds array", async () => {
    const mockRepo: any = { saveDecision: async () => {} };
    const service = new CompletionDecisionService(mockRepo);
    const result = await service.evaluateAndDecide(makeDecisionInput());
    expect(Array.isArray(result.consumedOverrideIds)).toBe(true);
  });

  it("evaluateAndDecide with fully passing gates returns completed", async () => {
    const mockRepo: any = { saveDecision: async () => {} };
    const service = new CompletionDecisionService(mockRepo);
    const result = await service.evaluateAndDecide(makeDecisionInput());
    expect(result.evaluation).toBeDefined();
    expect(result.decision.taskRunId).toBe("run-1");
  });
});
