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

function makeBudget(): ContextBudgetData {
  return {
    totalBudget: 10000,
    mandatoryCost: 2000,
    highValueCost: 3000,
    optionalCost: 1000,
    remainingBudget: 4000,
    isOverBudget: false,
    truncationNeeded: 0,
  };
}

describe("Runtime Persistence — Restart Safety", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "runtime-restart-"));
    dbPath = join(tmpDir, "runtime.db");
  });

  afterEach(() => {
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore if already cleaned up
    }
    try {
      const walPath = dbPath + "-wal";
      unlinkSync(walPath);
    } catch {
      // ignore
    }
    try {
      const shmPath = dbPath + "-shm";
      unlinkSync(shmPath);
    } catch {
      // ignore
    }
  });

  it("survives close and reopen — all run artifacts preserved", async () => {
    const runId = "restart-test-run-1";
    const contractId = "restart-ct-1";
    const contract = makeContract(contractId);
    const creationEvent = makeCreationEvent(runId);

    // 1. Open store, create run with all params
    const store1 = openSqliteStateStore(dbPath);
    const result1 = await store1.createRun({
      runId,
      initialState: "created" as State,
      contract,
      creationEvent,
      budget: makeBudget(),
    });
    expect(result1.committed).toBe(true);
    expect(result1.version).toBe(0);

    // Save cancellation phase
    await store1.saveCancellationPhase(runId, "active", { reason: "test" });

    // 2. Close store
    await store1.close();

    // 3. Reopen store on same file
    const store2 = openSqliteStateStore(dbPath);
    const loaded = await store2.loadRun(runId);

    // 4. Verify all artifacts survive restart
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(runId);
    expect(loaded!.state).not.toBeNull();
    expect(loaded!.state!.state).toBe("created");
    expect(loaded!.state!.version).toBe(0);
    expect(loaded!.contract).not.toBeNull();
    expect(loaded!.contract!.contractId).toBe(contractId);
    expect(loaded!.events.length).toBe(1);
    expect(loaded!.events[0].from).toBe("created");
    expect(loaded!.events[0].to).toBe("planning");
    expect(loaded!.budget).not.toBeNull();
    expect(loaded!.budget!.total_budget).toBe(10000);
    expect(loaded!.cancellationPhase).not.toBeNull();
    expect(loaded!.cancellationPhase!.phase).toBe("active");

    // 5. Verify contract via loadContractForRun
    const loadedContract = await store2.loadContractForRun(runId);
    expect(loadedContract).not.toBeNull();
    expect(loadedContract!.contractId).toBe(contractId);

    // 6. Verify loadState directly
    const loadedState = await store2.loadState(runId);
    expect(loadedState).not.toBeNull();
    expect(loadedState!.state).toBe("created");

    // 7. Verify loadEvents
    const events = await store2.loadEvents(runId);
    expect(events.length).toBe(1);
    expect(events[0].to).toBe("planning");

    await store2.close();
  });

  it("returns null for nonexistent run", async () => {
    const store = createInMemoryStateStore();
    const loaded = await store.loadRun("nonexistent");
    expect(loaded).toBeNull();
    await store.close();
  });
});