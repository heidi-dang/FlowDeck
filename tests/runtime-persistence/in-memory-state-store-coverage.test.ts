import { describe, it, expect } from "bun:test";
import { InMemoryStateStore } from "@/orchestration/runtime/state-store.js";
import type {
  State,
  ContractRecord,
  TransitionEvent,
  ContextBudgetData,
  EvidenceData,
  VerificationResultData,
  RecoveryAttemptData,
  CompletionDecisionData,
} from "@/orchestration/runtime/state-store.js";

function makeContract(contractId: string): ContractRecord {
  return {
    contractId,
    hash: "abc123",
    version: "1",
    objective: "Test objective",
    requirements: "[]",
    acceptanceCriteria: "[]",
    constraints: "[]",
    exclusions: "[]",
    requiredEvidence: "[]",
    requiredVerification: "[]",
    startingSha: "0000000000000000000000000000000000000000",
    allowedMutationScope: '["src/**"]',
    approvalGates: "[]",
    createdAt: new Date().toISOString(),
    status: "draft",
  };
}

function makeEvent(runId: string, from: State, to: State): TransitionEvent {
  return {
    runId,
    from,
    to,
    transitionType: "normal",
    timestamp: Date.now(),
  };
}

function makeBudget(over = false): ContextBudgetData {
  return {
    totalBudget: 10000,
    mandatoryCost: 2000,
    highValueCost: 3000,
    optionalCost: 1000,
    remainingBudget: over ? -500 : 4000,
    isOverBudget: over,
    truncationNeeded: over ? 500 : 0,
  };
}

describe("InMemoryStateStore — Dev 2 coverage", () => {
  it("commitTransition returns run_not_found when run does not exist", async () => {
    const store = new InMemoryStateStore();
    const result = await store.commitTransition({
      runId: "missing",
      state: "planning" as State,
      expectedVersion: 0,
      event: makeEvent("missing", "created" as State, "planning" as State),
    });
    expect(result.committed).toBe(false);
    expect(result.reason).toBe("run_not_found");
  });

  it("commitTransition returns version_conflict on stale version", async () => {
    const store = new InMemoryStateStore();
    const runId = "conflict-run";
    expect((await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("conflict-ct"),
    })).committed).toBe(true);

    // First transition succeeds (version 0 -> 1)
    const first = await store.commitTransition({
      runId,
      state: "planning" as State,
      expectedVersion: 0,
      event: makeEvent(runId, "created" as State, "planning" as State),
    });
    expect(first.committed).toBe(true);
    expect(first.newVersion).toBe(1);

    // Stale version 0 now conflicts
    const stale = await store.commitTransition({
      runId,
      state: "executing" as State,
      expectedVersion: 0,
      event: makeEvent(runId, "planning" as State, "executing" as State),
    });
    expect(stale.committed).toBe(false);
    expect(stale.reason).toBe("version_conflict");
  });

  it("commitTransition appends events in order", async () => {
    const store = new InMemoryStateStore();
    const runId = "events-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("events-ct"),
      creationEvent: makeEvent(runId, "created" as State, "planning" as State),
    });
    await store.commitTransition({
      runId,
      state: "executing" as State,
      expectedVersion: 0,
      event: makeEvent(runId, "planning" as State, "executing" as State),
    });
    const events = await store.loadEvents(runId);
    expect(events.length).toBe(2);
    expect(events[1].to).toBe("executing");
  });

  it("saveState returns false on version mismatch and true otherwise", async () => {
    const store = new InMemoryStateStore();
    const runId = "savestate-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("savestate-ct"),
    });

    // Version 0 -> 1 succeeds
    expect(await store.saveState(runId, "planning" as State, 0)).toBe(true);
    // Stale version 0 now fails
    expect(await store.saveState(runId, "executing" as State, 0)).toBe(false);

    // Missing run with expectedVersion 0 is created (current is undefined)
    expect(await store.saveState("fresh", "created" as State, 0)).toBe(true);
    const loaded = await store.loadState("fresh");
    expect(loaded?.state).toBe("created");
    expect(loaded?.version).toBe(0);
  });

  it("standalone recordEvent appends to the event list", async () => {
    const store = new InMemoryStateStore();
    const runId = "re-only-run";
    await store.recordEvent(runId, makeEvent(runId, "created" as State, "planning" as State));
    await store.recordEvent(runId, makeEvent(runId, "planning" as State, "executing" as State));
    const events = await store.loadEvents(runId);
    expect(events.length).toBe(2);
    expect(events[0].to).toBe("planning");
    expect(events[1].to).toBe("executing");
  });

  it("createRun returns run_exists for duplicate run id", async () => {
    const store = new InMemoryStateStore();
    const runId = "dup-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("dup-ct"),
    });
    const dup = await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("dup-ct-2"),
    });
    expect(dup.committed).toBe(false);
    expect(dup.reason).toBe("run_exists");
  });

  it("contracts round-trip through saveContract/loadContract/loadContractForRun", async () => {
    const store = new InMemoryStateStore();
    const contract = makeContract("contract-1");
    await store.saveContract(contract);

    expect((await store.loadContract("contract-1"))?.contractId).toBe("contract-1");
    expect(await store.loadContract("missing")).toBeNull();
    // No run association yet
    expect(await store.loadContractForRun("run-x")).toBeNull();

    await store.associateContract("run-x", "contract-1");
    expect((await store.loadContractForRun("run-x"))?.contractId).toBe("contract-1");
    // Association without stored contract
    await store.associateContract("run-y", "ghost-contract");
    expect(await store.loadContractForRun("run-y")).toBeNull();
  });

  it("verification results upsert by checkId", async () => {
    const store = new InMemoryStateStore();
    const runId = "verify-run";
    const result: VerificationResultData = {
      checkId: "check-1",
      ruleId: "rule-1",
      status: "passed",
      targetSha: "abc",
      evidenceIds: ["ev-1"],
    };
    await store.saveVerificationResult(runId, result);
    const results = await store.loadVerificationResults(runId);
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("passed");

    // Upsert replaces by checkId
    await store.saveVerificationResult(runId, { ...result, status: "failed" });
    const updated = await store.loadVerificationResults(runId);
    expect(updated.length).toBe(1);
    expect(updated[0].status).toBe("failed");
  });

  it("evidence upserts by id and loads with filePath", async () => {
    const store = new InMemoryStateStore();
    const runId = "evidence-run";
    const evidence: EvidenceData = {
      id: "ev-1",
      runId,
      type: "test",
      contentHash: "hash-1",
      sha: "abc",
      filePath: "tests/foo.test.ts",
    };
    await store.saveEvidence(evidence);
    await store.saveEvidence({ ...evidence, id: "ev-2" });

    const items = await store.loadEvidence(runId);
    expect(items.length).toBe(2);
    expect(items[0].filePath).toBe("tests/foo.test.ts");
  });

  it("completion decisions round-trip", async () => {
    const store = new InMemoryStateStore();
    const decision: CompletionDecisionData = {
      id: "dec-1",
      runId: "complete-run",
      decision: "complete",
      sha: "abc123",
      checks: "{}",
      idempotencyKey: "key-1",
    };
    expect(await store.loadCompletionDecision("complete-run")).toBeNull();
    await store.saveCompletionDecision(decision);
    const loaded = await store.loadCompletionDecision("complete-run");
    expect(loaded?.decision).toBe("complete");
    expect(loaded?.idempotencyKey).toBe("key-1");
  });

  it("recovery attempts append and load in order", async () => {
    const store = new InMemoryStateStore();
    const runId = "recovery-run";
    const attempt: RecoveryAttemptData = {
      id: "ra-1",
      runId,
      attemptNumber: 1,
      previousState: "failed" as State,
      failureReason: "timeout",
      errorKey: "timeout",
      action: "transition:failed->recovering",
    };
    await store.recordRecoveryAttempt(attempt);
    await store.recordRecoveryAttempt({ ...attempt, id: "ra-2", attemptNumber: 2 });
    const attempts = await store.loadRecoveryAttempts(runId);
    expect(attempts.length).toBe(2);
    expect(attempts[1].attemptNumber).toBe(2);
  });

  it("circuit breakers round-trip with optional lastFailureAt", async () => {
    const store = new InMemoryStateStore();
    expect(await store.loadCircuitBreaker("cb-missing")).toBeNull();

    const now = new Date();
    await store.saveCircuitBreaker("cb-1", {
      state: "open",
      failureCount: 3,
      lastFailureAt: now,
      lastStateChangeAt: now,
      totalSuccesses: 0,
      totalFailures: 3,
      halfOpenSuccesses: 0,
      halfOpenAttempts: 0,
    });
    await store.saveCircuitBreaker("cb-2", {
      state: "closed",
      failureCount: 0,
      lastStateChangeAt: now,
      totalSuccesses: 5,
      totalFailures: 0,
      halfOpenSuccesses: 0,
      halfOpenAttempts: 0,
    });

    const loaded = await store.loadCircuitBreaker("cb-1");
    expect(loaded?.state).toBe("open");
    expect(loaded?.failure_count).toBe(3);
    expect(loaded?.last_failure_at).not.toBeNull();

    const closed = await store.loadCircuitBreaker("cb-2");
    expect(closed?.last_failure_at).toBeNull();
    expect(closed?.total_successes).toBe(5);
  });

  it("context budget round-trips and maps fields", async () => {
    const store = new InMemoryStateStore();
    const runId = "budget-run";
    expect(await store.loadContextBudget(runId)).toBeNull();

    await store.saveContextBudget(runId, makeBudget());
    const row = await store.loadContextBudget(runId);
    expect(row?.total_budget).toBe(10000);
    expect(row?.is_over_budget).toBe(0);

    await store.saveContextBudget(runId, makeBudget(true));
    const over = await store.loadContextBudget(runId);
    expect(over?.is_over_budget).toBe(1);
    expect(over?.remaining_budget).toBe(-500);
  });

  it("cancellation phase round-trips with and without details", async () => {
    const store = new InMemoryStateStore();
    const runId = "cancel-run";
    expect(await store.loadCancellationPhase(runId)).toBeNull();

    await store.saveCancellationPhase(runId, "graceful_requested", { reason: "user" });
    let phase = await store.loadCancellationPhase(runId);
    expect(phase?.phase).toBe("graceful_requested");
    expect(phase?.details).toEqual({ reason: "user" });

    await store.saveCancellationPhase(runId, "completed");
    phase = await store.loadCancellationPhase(runId);
    expect(phase?.phase).toBe("completed");
  });

  it("loadRun reconstructs full state and returns null for unknown run", async () => {
    const store = new InMemoryStateStore();
    const runId = "full-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("full-ct"),
      creationEvent: makeEvent(runId, "created" as State, "planning" as State),
      budget: makeBudget(),
    });
    await store.saveVerificationResult(runId, {
      checkId: "c1",
      ruleId: "r1",
      status: "passed",
      targetSha: "abc",
      evidenceIds: [],
    });
    await store.saveCancellationPhase(runId, "active");
    await store.saveCompletionDecision({
      id: "d1",
      runId,
      decision: "complete",
      sha: "abc",
      checks: "{}",
      idempotencyKey: "k1",
    });

    const loaded = await store.loadRun(runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.state?.state).toBe("created");
    expect(loaded!.contract?.contractId).toBe("full-ct");
    expect(loaded!.events.length).toBe(1);
    expect(loaded!.verificationResults.length).toBe(1);
    expect(loaded!.cancellationPhase?.phase).toBe("active");
    expect(loaded!.completionDecision?.decision).toBe("complete");
    expect(loaded!.budget?.total_budget).toBe(10000);
    expect(loaded!.circuitBreakers.length).toBe(0);

    // Unknown run -> null
    expect(await store.loadRun("ghost")).toBeNull();
  });

  it("initializeRun is a no-op but leaves store usable", async () => {
    const store = new InMemoryStateStore();
    await store.initializeRun("init-run", "created" as State);
    // State is created lazily on first write
    await store.saveState("init-run", "created" as State, 0);
    expect((await store.loadState("init-run"))?.state).toBe("created");
  });

  it("close clears all maps", async () => {
    const store = new InMemoryStateStore();
    const runId = "close-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("close-ct"),
    });
    await store.close();
    expect(await store.loadState(runId)).toBeNull();
    expect((await store.loadEvents(runId)).length).toBe(0);
    expect(await store.loadRun(runId)).toBeNull();
  });
});
