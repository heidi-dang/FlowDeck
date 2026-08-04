import { describe, it, expect } from "bun:test";
import {
  createInMemoryStateStore,
  enableFaultInjection,
  disableFaultInjection,
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

describe("Runtime Persistence — Atomic Run Creation", () => {
  it("createRun persists all artifacts atomically", async () => {
    const store = createInMemoryStateStore();
    const runId = "atomic-run-1";
    const contractId = "atomic-ct-1";

    const result = await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract(contractId),
      creationEvent: makeCreationEvent(runId),
      budget: makeBudget(),
    });

    expect(result.committed).toBe(true);
    expect(result.version).toBe(0);

    const loaded = await store.loadRun(runId);
    expect(loaded).not.toBeNull();
    // state row
    expect(loaded!.state).not.toBeNull();
    expect(loaded!.state!.state).toBe("created");
    expect(loaded!.state!.version).toBe(0);
    // contract + association
    expect(loaded!.contract).not.toBeNull();
    expect(loaded!.contract!.contractId).toBe(contractId);
    // creation event
    expect(loaded!.events).toHaveLength(1);
    expect(loaded!.events[0].to).toBe("planning");
    // budget
    expect(loaded!.budget).not.toBeNull();
    expect(loaded!.budget!.total_budget).toBe(10000);

    await store.close();
  });

  it("duplicate createRun is rejected and does not duplicate state", async () => {
    const store = createInMemoryStateStore();
    const runId = "atomic-run-dup";

    const first = await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("atomic-ct-dup"),
      creationEvent: makeCreationEvent(runId),
      budget: makeBudget(),
    });
    expect(first.committed).toBe(true);

    const second = await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("atomic-ct-dup-2"),
      creationEvent: makeCreationEvent(runId),
      budget: makeBudget(),
    });

    expect(second.committed).toBe(false);
    expect(second.reason).toBe("run_exists");

    // State not duplicated: still exactly one row with version 0 and a single event
    const loaded = await store.loadRun(runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.state).not.toBeNull();
    expect(loaded!.state!.version).toBe(0);
    expect(loaded!.events).toHaveLength(1);
    // Original contract association survives — not replaced by the second attempt
    expect(loaded!.contract!.contractId).toBe("atomic-ct-dup");

    await store.close();
  });

  it("commitTransition rolls back atomically when fault injected after event insert", async () => {
    const store = createInMemoryStateStore();
    const runId = "atomic-run-fault";

    const created = await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("atomic-ct-fault"),
      creationEvent: makeCreationEvent(runId),
    });
    expect(created.committed).toBe(true);

    enableFaultInjection((point: string) => {
      if (point === "after_event_insert") {
        throw new Error("injected fault after event insert");
      }
    });

    try {
      const result = await store.commitTransition({
        runId,
        state: "planning" as State,
        expectedVersion: 0,
        event: {
          runId,
          from: "created" as State,
          to: "planning" as State,
          transitionType: "normal",
          timestamp: Date.now(),
        },
      });

      // Transaction rolled back — treated as an error result
      expect(result.committed).toBe(false);
      expect(result.reason).toBe("error");
    } finally {
      disableFaultInjection();
    }

    // State did NOT advance
    const state = await store.loadState(runId);
    expect(state).not.toBeNull();
    expect(state!.state).toBe("created");
    expect(state!.version).toBe(0);

    // No partial event was persisted
    const events = await store.loadEvents(runId);
    expect(events).toHaveLength(1);
    expect(events[0].to).toBe("planning");

    await store.close();
  });
});