import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  openSqliteStateStore,
  createInMemoryStateStore,
  type State,
  type ContractRecord,
  type TransitionEvent,
  type ContextBudgetData,
  type RecoveryAttemptData,
  type VerificationResultData,
  type EvidenceData,
  type CompletionDecisionData,
  type CircuitBreakerRow,
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

function makeCreationEvent(runId: string): TransitionEvent {
  return {
    runId,
    from: "created" as State,
    to: "planning" as State,
    transitionType: "normal",
    timestamp: Date.now(),
  };
}

describe("SqliteStateStore CRUD surface", () => {
  let dir: string;
  let dbPath: string;
  let store: ReturnType<typeof openSqliteStateStore>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fdx-crud-"));
    dbPath = join(dir, "state.db");
    store = openSqliteStateStore(dbPath);
  });

  afterEach(async () => {
    await store.close();
    try { unlinkSync(dbPath); } catch { /* already gone */ }
    try { unlinkSync(`${dbPath}-wal`); } catch { /* no wal */ }
    try { unlinkSync(`${dbPath}-shm`); } catch { /* no shm */ }
    try { unlinkSync(dir); } catch { /* non-empty */ }
  });

  it("should initialize a run idempotently", async () => {
    await store.initializeRun("run-a", "created");
    await store.initializeRun("run-a", "created");
    const loaded = await store.loadRun("run-a");
    expect(loaded?.state?.state).toBe("created");
    expect(loaded?.state?.version).toBe(0);
  });

  it("should associate a contract with a run and load it", async () => {
    await store.initializeRun("run-a", "created");
    const contract = makeContract("contract-1");
    await store.saveContract(contract);
    await store.associateContract("run-a", "contract-1");
    const loaded = await store.loadContractForRun("run-a");
    expect(loaded?.contractId).toBe("contract-1");
    const direct = await store.loadContract("contract-1");
    expect(direct?.contractId).toBe("contract-1");
    expect(direct?.status).toBe("draft");
  });

  it("should return null for a missing contract", async () => {
    expect(await store.loadContract("nope")).toBeNull();
    expect(await store.loadContractForRun("run-x")).toBeNull();
  });

  it("should save and reload a verification result with evidence ids", async () => {
    await store.initializeRun("run-a", "created");
    const result: VerificationResultData = {
      checkId: "check-1",
      ruleId: "rule-1",
      status: "passed",
      targetSha: "abc123",
      evidenceIds: ["ev-1", "ev-2"],
    };
    await store.saveVerificationResult("run-a", result);
    const results = await store.loadVerificationResults("run-a");
    expect(results).toHaveLength(1);
    expect(results[0].checkId).toBe("check-1");
    expect(results[0].evidenceIds).toEqual(["ev-1", "ev-2"]);
  });

  it("should save and reload evidence with optional file path", async () => {
    await store.initializeRun("run-a", "created");
    const evidence: EvidenceData = {
      id: "ev-1",
      runId: "run-a",
      type: "file",
      contentHash: "hash-1",
      sha: "abc123",
      filePath: "src/foo.ts",
    };
    await store.saveEvidence(evidence);
    const noPath: EvidenceData = { ...evidence, id: "ev-2", filePath: undefined };
    await store.saveEvidence(noPath);
    const loaded = await store.loadEvidence("run-a");
    expect(loaded).toHaveLength(2);
    expect(loaded.find((e) => e.id === "ev-1")?.filePath).toBe("src/foo.ts");
    expect(loaded.find((e) => e.id === "ev-2")?.filePath).toBeUndefined();
  });

  it("should save and reload a completion decision", async () => {
    await store.initializeRun("run-a", "created");
    const decision: CompletionDecisionData = {
      id: "dec-1",
      runId: "run-a",
      decision: "complete",
      sha: "abc123",
      checks: '["check-1"]',
      idempotencyKey: "key-1",
    };
    await store.saveCompletionDecision(decision);
    const loaded = await store.loadCompletionDecision("run-a");
    expect(loaded?.decision).toBe("complete");
    expect(loaded?.idempotencyKey).toBe("key-1");
    expect(await store.loadCompletionDecision("run-b")).toBeNull();
  });

  it("should record and reload recovery attempts", async () => {
    await store.initializeRun("run-a", "created");
    const attempt: RecoveryAttemptData = {
      id: "rec-1",
      runId: "run-a",
      attemptNumber: 1,
      previousState: "planning" as State,
      failureReason: "tool error",
      errorKey: "TOOL_ERROR",
      action: "restart",
    };
    await store.recordRecoveryAttempt(attempt);
    const attempts = await store.loadRecoveryAttempts("run-a");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].failureReason).toBe("tool error");
    expect(attempts[0].action).toBe("restart");
  });

  it("should save and reload a circuit breaker", async () => {
    await store.saveCircuitBreaker("breaker-1", {
      state: "open",
      failureCount: 3,
      lastFailureAt: new Date("2026-01-01T00:00:00Z"),
      lastStateChangeAt: new Date("2026-01-02T00:00:00Z"),
      totalSuccesses: 10,
      totalFailures: 5,
      halfOpenSuccesses: 0,
      halfOpenAttempts: 0,
    });
    const loaded = await store.loadCircuitBreaker("breaker-1");
    expect(loaded?.state).toBe("open");
    expect(loaded?.failure_count).toBe(3);
    expect(loaded?.last_failure_at).not.toBeNull();
    expect(await store.loadCircuitBreaker("missing")).toBeNull();
  });

  it("should save and reload a context budget", async () => {
    await store.initializeRun("run-a", "created");
    const budget: ContextBudgetData = {
      totalBudget: 100_000,
      mandatoryCost: 10_000,
      highValueCost: 5_000,
      optionalCost: 2_000,
      remainingBudget: 83_000,
      isOverBudget: false,
      truncationNeeded: 0,
    };
    await store.saveContextBudget("run-a", budget);
    const loaded = await store.loadContextBudget("run-a");
    expect(loaded?.total_budget).toBe(100_000);
    expect(loaded?.is_over_budget).toBe(0);
    expect(await store.loadContextBudget("run-b")).toBeNull();
  });

  it("should save and reload a cancellation phase", async () => {
    await store.initializeRun("run-a", "created");
    await store.saveCancellationPhase("run-a", "force_requested", { reason: "timeout" });
    const loaded = await store.loadCancellationPhase("run-a");
    expect(loaded?.phase).toBe("force_requested");
    expect(await store.loadCancellationPhase("run-b")).toBeNull();
  });

  it("should create a run with contract and event atomically", async () => {
    const result = await store.createRun({
      runId: "run-a",
      initialState: "created",
      contract: makeContract("contract-1"),
      creationEvent: makeCreationEvent("run-a"),
      budget: {
        totalBudget: 100_000,
        mandatoryCost: 0,
        highValueCost: 0,
        optionalCost: 0,
        remainingBudget: 100_000,
        isOverBudget: false,
        truncationNeeded: 0,
      },
    });
    expect(result.version).toBe(0);
    const loaded = await store.loadRun("run-a");
    expect(loaded?.state?.state).toBe("created");
    expect(loaded?.contract?.contractId).toBe("contract-1");
    expect(loaded?.events).toHaveLength(1);
    expect(loaded?.budget?.total_budget).toBe(100_000);
  });

  it("should reject createRun when the run already exists without throwing", async () => {
    const params = {
      runId: "run-a",
      initialState: "created" as State,
      contract: makeContract("contract-1"),
      creationEvent: makeCreationEvent("run-a"),
    };
    const first = await store.createRun(params);
    expect(first.committed).toBe(true);
    const second = await store.createRun(params);
    expect(second.committed).toBe(false);
    expect(second.reason).toBe("run_exists");
  });

  it("should support in-memory store for the same CRUD surface", async () => {
    const mem = createInMemoryStateStore();
    try {
      await mem.saveCircuitBreaker("b1", {
        state: "closed",
        failureCount: 0,
        lastStateChangeAt: new Date(),
        totalSuccesses: 1,
        totalFailures: 0,
        halfOpenSuccesses: 0,
        halfOpenAttempts: 0,
      });
      expect((await mem.loadCircuitBreaker("b1"))?.state).toBe("closed");
      await mem.saveContextBudget("run-z", {
        totalBudget: 50_000,
        mandatoryCost: 0,
        highValueCost: 0,
        optionalCost: 0,
        remainingBudget: 50_000,
        isOverBudget: false,
        truncationNeeded: 0,
      });
      expect((await mem.loadContextBudget("run-z"))?.total_budget).toBe(50_000);
    } finally {
      await mem.close();
    }
  });

  it("should expose schema migration helpers", () => {
    const { hasRuntimeSchema, getSchemaVersion, migrateRuntimeSchema, initRuntimeSchema } =
      require("@/orchestration/runtime/sqlite-state-store.js") as typeof import("@/orchestration/runtime/sqlite-state-store.js");
    expect(typeof hasRuntimeSchema).toBe("function");
    expect(typeof getSchemaVersion).toBe("function");
    expect(typeof migrateRuntimeSchema).toBe("function");
    expect(typeof initRuntimeSchema).toBe("function");
  });

  it("should record and list events with sequence ordering", async () => {
    await store.initializeRun("run-seq", "created");
    const ev1 = makeCreationEvent("run-seq");
    const ev2: TransitionEvent = { ...ev1, to: "executing" as State };
    await store.commitTransition({
      runId: "run-seq",
      state: "planning" as State,
      expectedVersion: 0,
      event: ev1,
    });
    await store.commitTransition({
      runId: "run-seq",
      state: "executing" as State,
      expectedVersion: 1,
      event: ev2,
    });
    const events = await store.loadEvents("run-seq");
    expect(events.map((e) => e.to)).toEqual(["planning", "executing"]);
  });

  it("should reject a stale version on commit without throwing", async () => {
    await store.initializeRun("run-stale", "created");
    const ev = makeCreationEvent("run-stale");
    const first = await store.commitTransition({
      runId: "run-stale",
      state: "planning" as State,
      expectedVersion: 0,
      event: ev,
    });
    expect(first.committed).toBe(true);
    const stale = await store.commitTransition({
      runId: "run-stale",
      state: "planning" as State,
      expectedVersion: 0,
      event: ev,
    });
    expect(stale.committed).toBe(false);
    expect(stale.reason).toBe("version_conflict");
  });
});
