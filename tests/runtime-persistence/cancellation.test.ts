import { describe, it, expect } from "bun:test";
import {
  createInMemoryStateStore,
  type State,
  type ContractRecord,
  type TransitionEvent,
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

describe("Runtime Persistence — Cancellation Phase", () => {
  it("overwrites phase on each saveCancellationPhase", async () => {
    const store = createInMemoryStateStore();
    const runId = "cancellation-run-1";

    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("cancellation-ct-1"),
      creationEvent: makeCreationEvent(runId),
    });

    await store.saveCancellationPhase(runId, "active");
    expect((await store.loadCancellationPhase(runId))!.phase).toBe("active");

    await store.saveCancellationPhase(runId, "graceful_requested");
    expect((await store.loadCancellationPhase(runId))!.phase).toBe(
      "graceful_requested",
    );

    await store.saveCancellationPhase(runId, "force_requested");
    expect((await store.loadCancellationPhase(runId))!.phase).toBe(
      "force_requested",
    );

    await store.saveCancellationPhase(runId, "completed");
    expect((await store.loadCancellationPhase(runId))!.phase).toBe("completed");

    await store.close();
  });

  it("phase persists across commitTransition (metadata survives)", async () => {
    const store = createInMemoryStateStore();
    const runId = "cancellation-run-2";

    await store.createRun({
      runId,
      initialState: "created" as State,
      contract: makeContract("cancellation-ct-2"),
      creationEvent: makeCreationEvent(runId),
    });

    await store.saveCancellationPhase(runId, "active", { reason: "manual" });

    await store.commitTransition({
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

    const phaseInfo = await store.loadCancellationPhase(runId);
    expect(phaseInfo).not.toBeNull();
    expect(phaseInfo!.phase).toBe("active");
    expect(phaseInfo!.details).toEqual({ reason: "manual" });

    // Run state advanced but cancellation phase metadata is preserved
    const loaded = await store.loadRun(runId);
    expect(loaded!.state!.state).toBe("planning");
    expect(loaded!.cancellationPhase!.phase).toBe("active");

    await store.close();
  });
});