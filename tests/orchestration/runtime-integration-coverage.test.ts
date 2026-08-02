import { describe, it, expect } from "bun:test";
import { createRuntimeIntegration, RuntimeConfigSchema } from "@/orchestration/runtime-integration.js";
import type { TaskContractDraft } from "@/orchestration/contracts/task-contract.js";
import type { CheckpointRepositoryPort } from "@/orchestration/recovery/cancellation-service.js";

/** In-memory checkpoint repository so recover() builds recovery state. */
function makeCheckpointRepo(): CheckpointRepositoryPort {
  const checkpoints = new Map<string, unknown>();
  return {
    async saveCheckpoint(cp) {
      checkpoints.set(cp.runId ?? "run", cp);
    },
    async getLatestCheckpoint(runId) {
      return (checkpoints.get(runId) ?? null) as never;
    },
    async deleteCheckpointsForRun(runId) {
      checkpoints.delete(runId);
    },
  };
}

function makeDraft(id: string): TaskContractDraft {
  return {
    id,
    version: "1.0.0",
    objective: "Test objective",
    requirements: [
      { id: "req-1", description: "Requirement 1", critical: true, verifiable: true },
    ],
    acceptanceCriteria: [
      { id: "ac-1", description: "AC 1", critical: true, testable: true },
    ],
    constraints: [],
    exclusions: [],
    requiredEvidence: [],
    requiredVerification: [],
    startingSha: "0000000000000000000000000000000000000000",
    allowedMutationScope: { allowedPaths: ["src/**"], deniedPaths: [], maxFiles: 10 },
    approvalGates: [],
    createdAt: new Date(),
    status: "draft",
  };
}

const ctx = (runId: string) => ({ runId, timestamp: Date.now(), reason: "test" });

describe("RuntimeOrchestrator — Dev 2 coverage", () => {
  it("createTask activates contract, initializes state and emits created event", async () => {
    const rt = createRuntimeIntegration();
    const events: string[] = [];
    rt.subscribe((e) => { events.push(e.type); });

    const created = await rt.createTask(makeDraft("task-1"));
    expect(created.runId).toBeTruthy();
    expect(created.initialState).toBe("created");
    expect(created.contract.status).toBe("activated");
    expect(created.contract.activatedAt).toBeInstanceOf(Date);
    expect(created.contract.hash).toBeTruthy();
    expect(events).toContain("task_run.created");
    rt.dispose();
  });

  it("unsubscribe removes the listener", async () => {
    const rt = createRuntimeIntegration();
    const events: string[] = [];
    const unsub = rt.subscribe((e) => { events.push(e.type); });
    unsub();
    await rt.createTask(makeDraft("task-unsub"));
    expect(events.length).toBe(0);
    rt.dispose();
  });

  it("transition moves through the state machine and emits events", async () => {
    const rt = createRuntimeIntegration();
    const events: string[] = [];
    rt.subscribe((e) => { events.push(e.type); });
    const created = await rt.createTask(makeDraft("task-trans"));

    const r1 = await rt.transition(created.runId, "planning", ctx(created.runId));
    expect(r1.success).toBe(true);
    expect(r1.from).toBe("created");
    expect(r1.to).toBe("planning");

    const r2 = await rt.transition(created.runId, "analysing", ctx(created.runId));
    expect(r2.success).toBe(true);

    const r3 = await rt.transition(created.runId, "delegating", ctx(created.runId));
    expect(r3.success).toBe(true);

    const r4 = await rt.transition(created.runId, "executing", ctx(created.runId));
    expect(r4.success).toBe(true);

    const r5 = await rt.transition(created.runId, "verifying", ctx(created.runId));
    expect(r5.success).toBe(true);

    expect(events).toContain("task_run.created");
    expect(events.filter((t) => t === "task_run.transitioned").length).toBe(5);
    rt.dispose();
  });

  it("transition rejects invalid transitions and emits error event", async () => {
    const rt = createRuntimeIntegration();
    const events: string[] = [];
    rt.subscribe((e) => { events.push(e.type); });
    const created = await rt.createTask(makeDraft("task-invalid"));

    // created -> executing is not allowed (must go through planning)
    const r = await rt.transition(created.runId, "executing", ctx(created.runId));
    expect(r.success).toBe(false);
    expect(r.error).toContain("Invalid transition");
    expect(events).toContain("task_run.error");
    rt.dispose();
  });

  it("complete fails on SHA mismatch and missing run", async () => {
    const rt = createRuntimeIntegration();
    const created = await rt.createTask(makeDraft("task-complete"));

    const shaMismatch = await rt.complete({
      runId: created.runId,
      currentSha: "aaa",
      expectedSha: "bbb",
      assignmentsComplete: true,
      verificationResults: [],
      acceptanceCriteria: [],
      requirements: [],
      evidenceItems: [],
    });
    expect(shaMismatch.success).toBe(false);
    expect(shaMismatch.error).toContain("SHA mismatch");

    const missing = await rt.complete({
      runId: "ghost",
      currentSha: "aaa",
      assignmentsComplete: true,
      verificationResults: [],
      acceptanceCriteria: [],
      requirements: [],
      evidenceItems: [],
    });
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("not found");
    rt.dispose();
  });

  it("complete succeeds when gates pass and persists terminal transition", async () => {
    const rt = createRuntimeIntegration();
    const created = await rt.createTask(makeDraft("task-complete-ok"));
    await rt.transition(created.runId, "planning", ctx(created.runId));
    await rt.transition(created.runId, "analysing", ctx(created.runId));
    await rt.transition(created.runId, "delegating", ctx(created.runId));
    await rt.transition(created.runId, "executing", ctx(created.runId));
    await rt.transition(created.runId, "verifying", ctx(created.runId));

    const result = await rt.complete({
      runId: created.runId,
      currentSha: "abc123",
      assignmentsComplete: true,
      verificationResults: [
        {
          id: "vr-1",
          runId: created.runId,
          ruleId: "rule-1",
          ruleDescription: "Rule 1",
          required: true,
          status: "passed",
          targetSha: "abc123",
          evidenceIds: ["ev-1"],
        },
      ],
      acceptanceCriteria: [
        { id: "ac-1", description: "AC 1", priority: "high" },
      ],
      requirements: [
        { id: "req-1", description: "Requirement 1", priority: "high" },
      ],
      evidenceItems: [
        { id: "ev-1", sha: "abc123", runId: created.runId, status: "current", criterionIds: ["ac-1"] },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.evaluation?.allPassed).toBe(true);

    // Terminal state: further transition rejected
    const after = await rt.transition(created.runId, "executing", ctx(created.runId));
    expect(after.success).toBe(false);
    rt.dispose();
  });

  it("cancel and forceEscalation drive cancellation phases", async () => {
    const rt = createRuntimeIntegration();
    const created = await rt.createTask(makeDraft("task-cancel"));

    const graceful = await rt.cancel(created.runId, false, "user requested");
    expect(graceful.success).toBe(true);

    const forced = await rt.forceEscalation(created.runId);
    expect(forced.success).toBe(true);
    expect(forced.phase).toBe("completed");
    rt.dispose();
  });

  it("recover transitions failed runs and rejects non-error states", async () => {
    const rt = createRuntimeIntegration();
    rt.getCancellationService().setCheckpointRepository(makeCheckpointRepo());
    const created = await rt.createTask(makeDraft("task-recover"));

    // Cannot recover from 'created' (not an error state)
    const rejected = await rt.recover(created.runId, "timeout");
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain("Cannot recover");

    // Move to verifying then fail
    await rt.transition(created.runId, "planning", ctx(created.runId));
    await rt.transition(created.runId, "analysing", ctx(created.runId));
    await rt.transition(created.runId, "delegating", ctx(created.runId));
    await rt.transition(created.runId, "executing", ctx(created.runId));
    await rt.transition(created.runId, "verifying", ctx(created.runId));
    await rt.transition(created.runId, "failed", ctx(created.runId));

    const recovered = await rt.recover(created.runId, "timeout");
    expect(recovered.success).toBe(true);
    expect(recovered.recoveryState?.changedHypothesis).toBe(true);
    expect(recovered.recoveryState?.retryFingerprint).toBe("timeout");
    expect(recovered.strategy).toBe("resume");
    // The committed store state is now "recovering"
    expect((await rt.getStateStore().loadState(created.runId))?.state).toBe("recovering");

    // Missing run
    const missing = await rt.recover("ghost", "err");
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("not found");
    rt.dispose();
  });

  it("recover maps error text to strategies", async () => {
    const rt = createRuntimeIntegration();
    rt.getCancellationService().setCheckpointRepository(makeCheckpointRepo());
    const created = await rt.createTask(makeDraft("task-strategy"));
    const through = ["planning", "analysing", "delegating", "executing", "verifying", "failed"] as const;
    const toFailed = async () => {
      for (const s of through) {
        await rt.transition(created.runId, s, ctx(created.runId));
      }
    };
    await toFailed();
    expect((await rt.recover(created.runId, "CIRCUIT open")).strategy).toBe("abort");
    await toFailed();
    expect((await rt.recover(created.runId, "MODEL error")).strategy).toBe("replan");
    await toFailed();
    expect((await rt.recover(created.runId, "generic failure")).strategy).toBe("restart");
    rt.dispose();
  });

  it("getContextBudget initializes then persists, updateContextBudget overwrites", async () => {
    const rt = createRuntimeIntegration();
    const created = await rt.createTask(makeDraft("task-budget"));

    const initial = await rt.getContextBudget(created.runId);
    expect(initial.totalBudget).toBeGreaterThan(0);
    expect(initial.remainingBudget).toBe(initial.totalBudget);

    const updated = await rt.getContextBudget(created.runId);
    expect(updated.totalBudget).toBe(initial.totalBudget);

    await rt.updateContextBudget(created.runId, {
      totalBudget: 5000,
      mandatoryCost: 100,
      highValueCost: 200,
      optionalCost: 300,
      remainingBudget: 4400,
      isOverBudget: false,
      truncationNeeded: 0,
    });
    const persisted = await rt.getContextBudget(created.runId);
    expect(persisted.totalBudget).toBe(5000);
    expect(persisted.remainingBudget).toBe(4400);
    rt.dispose();
  });

  it("accessors return wired collaborators", () => {
    const rt = createRuntimeIntegration();
    expect(rt.getStateStore()).toBeTruthy();
    expect(rt.getTransitionService()).toBeTruthy();
    expect(rt.getCancellationService()).toBeTruthy();
    expect(rt.getEventEmitter().emit).toBeTypeOf("function");
    rt.dispose();
  });

  it("RuntimeConfigSchema validates config shapes", () => {
    expect(RuntimeConfigSchema.parse({ devMode: true, dbPath: "/tmp/x.db" })).toMatchObject({
      devMode: true,
      dbPath: "/tmp/x.db",
    });
    expect(RuntimeConfigSchema.parse({})).toBeTruthy();
    expect(RuntimeConfigSchema.safeParse({ devMode: "yes" }).success).toBe(false);
  });
});
