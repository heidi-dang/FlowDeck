import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  openSqliteStateStore,
  VersionConflictError,
  type State,
  type ContractRecord,
  type TransitionEvent,
  type ContextBudgetData,
  type EvidenceData,
  type VerificationResultData,
  type RecoveryAttemptData,
} from "@/orchestration/runtime/index.js";

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

describe("SQLite state store — Dev 2 coverage", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "runtime-sqlite-cov-"));
    dbPath = join(tmpDir, "runtime.db");
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {
        // ignore
      }
    }
  });

  it("VersionConflictError carries runId, expected and actual versions", () => {
    const err = new VersionConflictError("run-1", 2, 5);
    expect(err.name).toBe("VersionConflictError");
    expect(err.runId).toBe("run-1");
    expect(err.expectedVersion).toBe(2);
    expect(err.actualVersion).toBe(5);
    expect(err.message).toContain("expected 2, got 5");
    expect(err instanceof Error).toBe(true);
  });

  it("deprecated saveState returns false for missing or stale versions", async () => {
    const store = openSqliteStateStore(dbPath);
    // Missing run -> false
    expect(await store.saveState("ghost", "created" as State, 0)).toBe(false);

    await store.createRun({
      runId: "dep-run",
      initialState: "created" as State,
      contract: makeContract("dep-ct"),
    });
    // Current version is 0; expected 0 -> true
    expect(await store.saveState("dep-run", "planning" as State, 0)).toBe(true);
    // Stale version -> false
    expect(await store.saveState("dep-run", "executing" as State, 0)).toBe(false);
    await store.close();
  });

  it("deprecated recordEvent appends events with incrementing seq", async () => {
    const store = openSqliteStateStore(dbPath);
    const runId = "rec-event-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("rec-ct"),
    });
    await store.recordEvent(runId, makeEvent(runId, "created" as State, "planning" as State));
    await store.recordEvent(runId, makeEvent(runId, "planning" as State, "executing" as State));
    const events = await store.loadEvents(runId);
    expect(events.length).toBe(2);
    expect(events[1].to).toBe("executing");
    await store.close();
  });

  it("loadContract and loadContractForRun return null when absent", async () => {
    const store = openSqliteStateStore(dbPath);
    expect(await store.loadContract("missing-ct")).toBeNull();
    expect(await store.loadContractForRun("missing-run")).toBeNull();
    await store.close();
  });

  it("loadRecoveryAttempts round-trips persisted attempts", async () => {
    const store = openSqliteStateStore(dbPath);
    const runId = "rec-attempt-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("ra-ct"),
    });
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
    expect(attempts[1].previousState).toBe("failed");
    expect(attempts[1].errorKey).toBe("timeout");
    await store.close();
  });

  it("loadCircuitBreaker round-trips with and without lastFailureAt", async () => {
    const store = openSqliteStateStore(dbPath);
    expect(await store.loadCircuitBreaker("missing-cb")).toBeNull();

    const now = new Date();
    await store.saveCircuitBreaker("cb-open", {
      state: "open",
      failureCount: 3,
      lastFailureAt: now,
      lastStateChangeAt: now,
      totalSuccesses: 0,
      totalFailures: 3,
      halfOpenSuccesses: 0,
      halfOpenAttempts: 0,
    });
    await store.saveCircuitBreaker("cb-closed", {
      state: "closed",
      failureCount: 0,
      lastStateChangeAt: now,
      totalSuccesses: 4,
      totalFailures: 0,
      halfOpenSuccesses: 0,
      halfOpenAttempts: 0,
    });

    const open = await store.loadCircuitBreaker("cb-open");
    expect(open?.state).toBe("open");
    expect(open?.last_failure_at).not.toBeNull();
    expect(open?.failure_count).toBe(3);

    const closed = await store.loadCircuitBreaker("cb-closed");
    expect(closed?.last_failure_at).toBeNull();
    expect(closed?.total_successes).toBe(4);
    await store.close();
  });

  it("verification results, evidence and completion decision round-trip", async () => {
    const store = openSqliteStateStore(dbPath);
    const runId = "roundtrip-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("rt-ct"),
    });

    const verification: VerificationResultData = {
      checkId: "c1",
      ruleId: "r1",
      status: "passed",
      targetSha: "abc",
      evidenceIds: ["ev-1"],
    };
    await store.saveVerificationResult(runId, verification);
    const results = await store.loadVerificationResults(runId);
    expect(results.length).toBe(1);
    expect(results[0].evidenceIds).toEqual(["ev-1"]);

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
    const evidenceItems = await store.loadEvidence(runId);
    expect(evidenceItems.length).toBe(2);
    expect(evidenceItems[0].filePath).toBe("tests/foo.test.ts");

    expect(await store.loadCompletionDecision(runId)).toBeNull();
    await store.saveCompletionDecision({
      id: "dec-1",
      runId,
      decision: "complete",
      sha: "abc",
      checks: "{}",
      idempotencyKey: "k1",
    });
    const decision = await store.loadCompletionDecision(runId);
    expect(decision?.decision).toBe("complete");
    expect(decision?.idempotencyKey).toBe("k1");
    await store.close();
  });

  it("loadRun returns null when neither state nor contract exists", async () => {
    const store = openSqliteStateStore(dbPath);
    expect(await store.loadRun("ghost-run")).toBeNull();
    await store.close();
  });

  it("context budget round-trips through loadContextBudget", async () => {
    const store = openSqliteStateStore(dbPath);
    const runId = "budget-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("budget-ct"),
    });
    expect(await store.loadContextBudget(runId)).toBeNull();

    const budget: ContextBudgetData = {
      totalBudget: 10000,
      mandatoryCost: 2000,
      highValueCost: 3000,
      optionalCost: 1000,
      remainingBudget: 4000,
      isOverBudget: false,
      truncationNeeded: 0,
    };
    await store.saveContextBudget(runId, budget);
    const row = await store.loadContextBudget(runId);
    expect(row?.total_budget).toBe(10000);
    expect(row?.is_over_budget).toBe(0);
    await store.close();
  });

  it("initializeRun and associateContract are idempotent", async () => {
    const store = openSqliteStateStore(dbPath);
    await store.initializeRun("init-run", "created" as State);
    await store.initializeRun("init-run", "created" as State);
    expect((await store.loadState("init-run"))?.state).toBe("created");

    await store.saveContract(makeContract("assoc-ct"));
    await store.associateContract("init-run", "assoc-ct");
    await store.associateContract("init-run", "assoc-ct");
    const contract = await store.loadContractForRun("init-run");
    expect(contract?.contractId).toBe("assoc-ct");
    await store.close();
  });

  it("saveEvidence ignores duplicates and saveCompletionDecision ignores repeats", async () => {
    const store = openSqliteStateStore(dbPath);
    const runId = "dup-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("dup-ct"),
    });

    const evidence: EvidenceData = {
      id: "ev-dup",
      runId,
      type: "test",
      contentHash: "h",
      sha: "s",
    };
    await store.saveEvidence(evidence);
    await store.saveEvidence(evidence);
    expect((await store.loadEvidence(runId)).length).toBe(1);

    await store.saveCompletionDecision({
      id: "dec-dup",
      runId,
      decision: "complete",
      sha: "s",
      checks: "{}",
      idempotencyKey: "k",
    });
    await store.saveCompletionDecision({
      id: "dec-dup",
      runId,
      decision: "complete",
      sha: "s",
      checks: "{}",
      idempotencyKey: "k",
    });
    const decision = await store.loadCompletionDecision(runId);
    expect(decision?.id).toBe("dec-dup");
    await store.close();
  });

  it("loadRun reconstructs full loaded run from sqlite", async () => {
    const store = openSqliteStateStore(dbPath);
    const runId = "full-sqlite-run";
    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("full-ct"),
      creationEvent: makeEvent(runId, "created" as State, "planning" as State),
    });
    await store.saveVerificationResult(runId, {
      checkId: "c1",
      ruleId: "r1",
      status: "passed",
      targetSha: "abc",
      evidenceIds: [],
    });
    await store.saveCancellationPhase(runId, "active", { reason: "test" });

    const loaded = await store.loadRun(runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.state?.state).toBe("created");
    expect(loaded!.contract?.contractId).toBe("full-ct");
    expect(loaded!.events.length).toBe(1);
    expect(loaded!.verificationResults.length).toBe(1);
    expect(loaded!.cancellationPhase?.phase).toBe("active");
    expect(loaded!.circuitBreakers).toEqual([]);
    await store.close();
  });
});
