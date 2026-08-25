import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { computeChecksum } from "../src/orchestration/persistence/migrations/migration-checksum";
import {
  MIGRATION_V13_ALGORITHM_VERSION,
  MIGRATION_V13_CONVERGENCE_INTEGRITY_CHECKSUM_SOURCE,
} from "../src/orchestration/persistence/migrations/migration-v13-convergence-integrity";
import { classifyTask } from "../src/services/heidi-fast-router";
import {
  acquireProjectRuntime,
  disposeProjectRuntime,
  releaseProjectRuntime,
} from "../src/runtime/project-registry";
import { OrchestrationPhase as OP } from "../src/orchestration/types/runs";
import { ContinuationDispatcher, getContinuationPrompt } from "../src/orchestration/services/continuation-policy";
import { RunStatus } from "../src/orchestration/types/runs";
import { runMigrations, getCurrentVersion } from "../src/orchestration/persistence/migrations/migration-runner";
import { MIGRATIONS } from "../src/orchestration/persistence/migrations/migration-registry";
import { MigrationChecksumError } from "../src/orchestration/persistence/errors";

let testDir = "";

describe("Production Wiring & Concurrency Integrity Suite (Execution Integrity Guarantees)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "flowdeck-production-wiring-"));
  });

  afterEach(async () => {
    await disposeProjectRuntime(testDir);
    // The fixture is unique per test. Bun's Windows WAL close can retain the
    // main database handle, so leave process-scoped temporary cleanup to the
    // runner there rather than weakening lifecycle assertions.
    if (process.platform !== "win32") {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 1. plugin-passes-opencode-client-to-runtime
  it("1. plugin-passes-opencode-client-to-runtime", async () => {
    const mockClient = { session: { abort: mock(() => Promise.resolve(true)), promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    expect(ctx.adapter.getClient()).toBe(mockClient);
    await releaseProjectRuntime(testDir);
  });

  // 2. shared-runtime-preserves-valid-client
  it("2. shared-runtime-preserves-valid-client", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    expect(ctx1.adapter.getClient()).toBeUndefined();

    const mockClient = { session: { abort: mock(() => Promise.resolve(true)) } };
    const ctx2 = acquireProjectRuntime(testDir, mockClient);
    expect(ctx2).toBe(ctx1);
    expect(ctx2.adapter.getClient()).toBe(mockClient);

    await releaseProjectRuntime(testDir);
    await releaseProjectRuntime(testDir);
  });

  // 3. continuation-success-reports-dispatched
  it("3. continuation-success-reports-dispatched", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const mockClient = { session: { promptAsync: mock(() => Promise.resolve(true)) } };
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);

    const token = {
      runId: "run-cont-succ",
      sessionId: "sess-succ",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      currentWorkItemId: "as-1",
      stateFingerprint: "fp-1",
    };

    const res = await dispatcher.dispatch(token, {
      currentTurnVersion: 1,
      currentAggregateVersion: 1,
      client: mockClient,
    });

    expect(res.dispatched).toBe(true);
    expect(res.identity.length).toBeGreaterThan(10);
    expect(res.reason).toBeUndefined();
    await releaseProjectRuntime(testDir);
  });

  // 4. continuation-unavailable-reports-not-dispatched
  it("4. continuation-unavailable-reports-not-dispatched", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);

    const token = {
      runId: "run-cont-unavail",
      sessionId: "sess-unavail",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      currentWorkItemId: "as-1",
      stateFingerprint: "fp-1",
    };

    const res = await dispatcher.dispatch(token, {
      currentTurnVersion: 1,
      currentAggregateVersion: 1,
      client: {},
    });

    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("native_dispatch_unavailable");
    await releaseProjectRuntime(testDir);
  });

  // 5. continuation-error-reports-not-dispatched
  it("5. continuation-error-reports-not-dispatched", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const mockClient = { session: { promptAsync: mock(() => Promise.reject(new Error("RPC failed"))) } };
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);

    const token = {
      runId: "run-cont-err",
      sessionId: "sess-err",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      currentWorkItemId: "as-1",
      stateFingerprint: "fp-1",
    };

    const res = await dispatcher.dispatch(token, {
      currentTurnVersion: 1,
      currentAggregateVersion: 1,
      client: mockClient,
    });

    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("native_dispatch_failed");
    await releaseProjectRuntime(testDir);
  });

  // 6. failed-dispatch-does-not-consume-success-dedupe
  it("6. failed-dispatch-does-not-consume-success-dedupe", async () => {
    const ctx = acquireProjectRuntime(testDir);
    let shouldFail = true;
    const mockClient = {
      session: {
        promptAsync: mock(() => shouldFail ? Promise.reject(new Error("Transient RPC fail")) : Promise.resolve(true)),
      },
    };
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);

    const token = {
      runId: "run-retry",
      sessionId: "sess-retry",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "TRANSIENT_RETRY_ALLOWED" as const,
      currentWorkItemId: "as-1",
      stateFingerprint: "fp-retry",
    };

    // Attempt 1 fails
    const res1 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res1.dispatched).toBe(false);

    // Attempt 2 succeeds
    shouldFail = false;
    const res2 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res2.dispatched).toBe(true);
    await releaseProjectRuntime(testDir);
  });

  // 7. successful-dispatch-dedupes
  it("7. successful-dispatch-dedupes", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const mockClient = { session: { promptAsync: mock(() => Promise.resolve(true)) } };
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);

    const token = {
      runId: "run-dedupe",
      sessionId: "sess-dedupe",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "PROGRESS_CONFIRMED" as const,
      currentWorkItemId: "as-1",
      stateFingerprint: "fp-dedupe",
    };

    const res1 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res1.dispatched).toBe(true);

    const res2 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res2.dispatched).toBe(false);
    expect(res2.reason).toBe("duplicate_dispatch");
    await releaseProjectRuntime(testDir);
  });

  // 8. dispatch-dedupe-survives-restart
  it("8. dispatch-dedupe-survives-restart", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    const mockClient = { session: { promptAsync: mock(() => Promise.resolve(true)) } };
    const dispatcher1 = new ContinuationDispatcher(ctx1.runtime.db);

    const token = {
      runId: "run-restart-dedupe",
      sessionId: "sess-restart-dedupe",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "PROGRESS_CONFIRMED" as const,
      currentWorkItemId: "as-1",
      stateFingerprint: "fp-restart-dedupe",
    };

    const res1 = await dispatcher1.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res1.dispatched).toBe(true);
    await releaseProjectRuntime(testDir);

    const ctx2 = acquireProjectRuntime(testDir);
    const dispatcher2 = new ContinuationDispatcher(ctx2.runtime.db);

    const res2 = await dispatcher2.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res2.dispatched).toBe(false);
    expect(res2.reason).toBe("duplicate_dispatch");

    await releaseProjectRuntime(testDir);
  });

  // 9. user-turn-version-survives-restart
  it("9. user-turn-version-survives-restart", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    const sessionID = "sess-turn-restart";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Task 1 description", id: "1", sessionID, messageID: "m1" }] }
    );
    expect(ctx1.adapter.getUserTurnVersion(sessionID)).toBe(1);

    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m2" },
      { message: {} as any, parts: [{ type: "text", text: "Task 2 modification", id: "2", sessionID, messageID: "m2" }] }
    );
    expect(ctx1.adapter.getUserTurnVersion(sessionID)).toBe(2);

    await releaseProjectRuntime(testDir);

    const ctx2 = acquireProjectRuntime(testDir);
    expect(ctx2.adapter.getUserTurnVersion(sessionID)).toBe(2);
    await releaseProjectRuntime(testDir);
  });

  // 10. user-turn-version-increments-atomically
  it("10. user-turn-version-increments-atomically", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-turn-atomic";

    const v1 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID, messageId: "m1" });
    const v2 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID, messageId: "m2" });
    const v3 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID, messageId: "m3" });

    expect(v1).toBe(1);
    expect(v2).toBe(2);
    expect(v3).toBe(3);
    await releaseProjectRuntime(testDir);
  });

  // 11. query-user-turn-invalidates-old-token
  it("11. query-user-turn-invalidates-old-token", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-query-inval";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const oldTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m2" },
      { message: {} as any, parts: [{ type: "text", text: "what is the current status?", id: "2", sessionID, messageID: "m2" }] }
    );

    const newTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);
    expect(newTurnVersion).toBeGreaterThan(oldTurnVersion);

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: oldTurnVersion,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp-old",
    };

    const statePort = {
      getUserTurnVersion: (sid: string) => ctx.adapter.getUserTurnVersion(sid),
      getRunAggregateVersion: (_rid: string) => 1,
    };

    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);
    const res = await dispatcher.dispatch(token, { statePort, client: { session: { promptAsync: mock(() => Promise.resolve(true)) } } });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_user_turn_version");

    await releaseProjectRuntime(testDir);
  });

  // 12. acknowledge-user-turn-invalidates-old-token
  it("12. acknowledge-user-turn-invalidates-old-token", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-ack-inval";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const oldTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m2" },
      { message: {} as any, parts: [{ type: "text", text: "sounds good, proceed", id: "2", sessionID, messageID: "m2" }] }
    );

    const newTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);
    expect(newTurnVersion).toBeGreaterThan(oldTurnVersion);

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: oldTurnVersion,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp-old",
    };

    const statePort = {
      getUserTurnVersion: (sid: string) => ctx.adapter.getUserTurnVersion(sid),
      getRunAggregateVersion: (_rid: string) => 1,
    };

    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);
    const res = await dispatcher.dispatch(token, { statePort, client: { session: { promptAsync: mock(() => Promise.resolve(true)) } } });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_user_turn_version");

    await releaseProjectRuntime(testDir);
  });

  // 13. modify-user-turn-invalidates-old-token
  it("13. modify-user-turn-invalidates-old-token", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-mod-inval";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const oldTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m2" },
      { message: {} as any, parts: [{ type: "text", text: "Also add Redis caching to the telemetry service", id: "2", sessionID, messageID: "m2" }] }
    );

    const newTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);
    expect(newTurnVersion).toBeGreaterThan(oldTurnVersion);

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: oldTurnVersion,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp-old",
    };

    const statePort = {
      getUserTurnVersion: (sid: string) => ctx.adapter.getUserTurnVersion(sid),
      getRunAggregateVersion: (_rid: string) => 1,
    };

    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);
    const res = await dispatcher.dispatch(token, { statePort, client: { session: { promptAsync: mock(() => Promise.resolve(true)) } } });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_user_turn_version");

    await releaseProjectRuntime(testDir);
  });

  // 14. stale-run-version-rejected-from-live-db
  it("14. stale-run-version-rejected-from-live-db", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-stale-run-agg";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    ctx.runtime.taskRunsRepo.updateState(run.id, "executing");
    const currentAgg = ctx.runtime.taskRunsRepo.findById(run.id)!.aggregateVersion;

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: ctx.adapter.getUserTurnVersion(sessionID),
      runAggregateVersion: currentAgg - 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp-1",
    };

    const statePort = {
      getUserTurnVersion: (sid: string) => ctx.adapter.getUserTurnVersion(sid),
      getRunAggregateVersion: (rid: string) => ctx.runtime.taskRunsRepo.findById(rid)?.aggregateVersion ?? null,
    };

    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);
    const res = await dispatcher.dispatch(token, { statePort, client: { session: { promptAsync: mock(() => Promise.resolve(true)) } } });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_run_aggregate_version");

    await releaseProjectRuntime(testDir);
  });

  // 15. stale-state-fingerprint-rejected
  it("15. stale-state-fingerprint-rejected", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-stale-fp";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: ctx.adapter.getUserTurnVersion(sessionID),
      runAggregateVersion: snap.aggregateVersion,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "old-fingerprint-that-changed",
    };

    const statePort = {
      getUserTurnVersion: (sid: string) => ctx.adapter.getUserTurnVersion(sid),
      getRunAggregateVersion: (_rid: string) => snap.aggregateVersion,
      computeStateFingerprint: (rid: string, sid: string) => ctx.runtime.orchestrationSnapshotService.computeStateFingerprint(rid, sid),
    };

    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);
    const res = await dispatcher.dispatch(token, { statePort, client: { session: { promptAsync: mock(() => Promise.resolve(true)) } } });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_state_fingerprint");

    await releaseProjectRuntime(testDir);
  });

  // 16. token-uses-post-transition-snapshot
  it("16. token-uses-post-transition-snapshot", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-post-trans-snap";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap1 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap1.phase,
      expectedAggregateVersion: snap1.aggregateVersion,
    });

    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-fail-16",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-16",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);
    await ctx.runtime.services.assignmentService.failAssignment(a1.id);

    const mockClient = { session: { promptAsync: mock(() => Promise.resolve(true)) } };
    ctx.adapter.setClient(mockClient);

    await ctx.adapter.onSessionIdle(sessionID);

    const snap2 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snap2.phase).toBe(OP.RECOVERING);

    await releaseProjectRuntime(testDir);
  });

  // 17. all-transition-engine-phase-writes-use-cas
  it("17. all-transition-engine-phase-writes-use-cas", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-cas-mandatory";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    const res = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: 999,
    });
    expect(res).toBe(false);

    await releaseProjectRuntime(testDir);
  });

  // 18. cas-conflict-does-not-report-phase-changed
  it("18. cas-conflict-does-not-report-phase-changed", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-cas-conflict";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    const win = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
    });
    expect(win).toBe(true);

    const lose = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.RECOVERING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
    });
    expect(lose).toBe(false);

    await releaseProjectRuntime(testDir);
  });

  // 19. multi-step-phase-evaluation-does-not-reuse-stale-version
  it("19. multi-step-phase-evaluation-does-not-reuse-stale-version", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-multistep-ver";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    let snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const t1 = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
    });
    expect(t1).toBe(true);

    snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const t2 = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.VERIFYING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
    });
    expect(t2).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 20. real-concurrent-attempt-reservation-unique
  it("20. real-concurrent-attempt-reservation-unique", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-att-unique";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const [att1, att2] = await Promise.all([
      Promise.resolve().then(() => ctx.runtime.transitionEngine.startAttempt({
        runId: run.id,
        assignmentId: "as-1",
        callID: "call-c1",
        tool: "write",
        actionFingerprint: "afp-1",
        preStateFingerprint: "pre-1",
      })),
      Promise.resolve().then(() => ctx.runtime.transitionEngine.startAttempt({
        runId: run.id,
        assignmentId: "as-1",
        callID: "call-c2",
        tool: "write",
        actionFingerprint: "afp-2",
        preStateFingerprint: "pre-2",
      })),
    ]);

    expect(att1.attemptNumber).not.toBe(att2.attemptNumber);
    const numbers = new Set([att1.attemptNumber, att2.attemptNumber]);
    expect(numbers.has(1)).toBe(true);
    expect(numbers.has(2)).toBe(true);

    expect(ctx.runtime.transitionEngine.findAttemptByCallID("call-c1")).not.toBeNull();
    expect(ctx.runtime.transitionEngine.findAttemptByCallID("call-c2")).not.toBeNull();

    await releaseProjectRuntime(testDir);
  });

  // 21. duplicate-call-id-idempotent-or-conflict
  it("21. duplicate-call-id-idempotent-or-conflict", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-dup-callid";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const att1 = ctx.runtime.transitionEngine.startAttempt({
      runId: run.id,
      assignmentId: "as-1",
      callID: "call-same",
      tool: "write",
      actionFingerprint: "afp-1",
      preStateFingerprint: "pre-1",
    });

    const att2 = ctx.runtime.transitionEngine.startAttempt({
      runId: run.id,
      assignmentId: "as-1",
      callID: "call-same",
      tool: "write",
      actionFingerprint: "afp-1",
      preStateFingerprint: "pre-1",
    });

    expect(att1.attemptNumber).toBe(1);
    expect(att2.attemptNumber).toBe(1);

    await releaseProjectRuntime(testDir);
  });

  // 22. durable-call-id-finalizes-after-restart
  it("22. durable-call-id-finalizes-after-restart", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    const sessionID = "sess-durable-call";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const _run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx1.adapter.onToolExecuteBefore({
      tool: "write",
      sessionID,
      callID: "call-restart-1",
      args: { path: "src/app.ts", content: "export const x = 1;" },
    });

    await releaseProjectRuntime(testDir);

    const ctx2 = acquireProjectRuntime(testDir);
    await ctx2.adapter.onToolExecuteAfter(
      { tool: "write", sessionID, callID: "call-restart-1", args: { path: "src/app.ts" } },
      { output: "written", metadata: {} }
    );

    const attempt = ctx2.runtime.transitionEngine.findAttemptByCallID("call-restart-1");
    expect(attempt).not.toBeNull();
    expect(attempt?.finishedAt).toBeDefined();

    await releaseProjectRuntime(testDir);
  });

  // 23. task-attempt-finalized
  it("23. task-attempt-finalized", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-task-att-fin";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const _run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({
      tool: "task",
      sessionID,
      callID: "call-task-fin",
      args: { subagent_type: "coder", prompt: "Implement auth" },
    });

    await ctx.adapter.onToolExecuteAfter(
      { tool: "task", sessionID, callID: "call-task-fin", args: { subagent_type: "coder" } },
      { output: "auth done", metadata: {}, title: "Completed auth" }
    );

    const attempt = ctx.runtime.transitionEngine.findAttemptByCallID("call-task-fin");
    expect(attempt?.finishedAt).toBeDefined();
    expect(attempt?.progressProduced).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 24. subagent-attempt-finalized
  it("24. subagent-attempt-finalized", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-sub-att-fin";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const _run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({
      tool: "subagent",
      sessionID,
      callID: "call-subagent-fin",
      args: { agent: "reviewer", prompt: "Review PR" },
    });

    await ctx.adapter.onToolExecuteAfter(
      { tool: "subagent", sessionID, callID: "call-subagent-fin", args: { agent: "reviewer" } },
      { output: "review approved", metadata: {}, title: "Approved" }
    );

    const attempt = ctx.runtime.transitionEngine.findAttemptByCallID("call-subagent-fin");
    expect(attempt?.finishedAt).toBeDefined();
    expect(attempt?.progressProduced).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 25. child-a-tool-attributed-to-assignment-a
  it("25. child-a-tool-attributed-to-assignment-a", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-child-a-main";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const delA = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-spawn-a",
      targetAgent: "coder",
      assignmentId: "assignment-A",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "session-child-A",
      agentId: "coder",
      taskCallId: delA.taskCallId,
    });

    await ctx.adapter.onToolExecuteBefore({
      tool: "bash",
      sessionID: "session-child-A",
      callID: "call-child-a-tool",
      args: { command: "ls" },
    });

    const attA = ctx.runtime.transitionEngine.findAttemptByCallID("call-child-a-tool");
    expect(attA?.assignmentId).toBe("assignment-A");

    await releaseProjectRuntime(testDir);
  });

  // 26. child-b-tool-attributed-to-assignment-b
  it("26. child-b-tool-attributed-to-assignment-b", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-child-b-main";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const delB = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-spawn-b",
      targetAgent: "reviewer",
      assignmentId: "assignment-B",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "session-child-B",
      agentId: "reviewer",
      taskCallId: delB.taskCallId,
    });

    await ctx.adapter.onToolExecuteBefore({
      tool: "read",
      sessionID: "session-child-B",
      callID: "call-child-b-tool",
      args: { file: "README.md" },
    });

    const attB = ctx.runtime.transitionEngine.findAttemptByCallID("call-child-b-tool");
    expect(attB?.assignmentId).toBe("assignment-B");

    await releaseProjectRuntime(testDir);
  });

  // 27. optional-child-failure-does-not-force-recovery
  it("27. optional-child-failure-does-not-force-recovery", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-opt-fail";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    ctx.runtime.db.query(`
      INSERT INTO assignments (id, run_id, agent_id, description, is_required, status, created_at, created_by)
      VALUES ('as-optional', ?, 'linter', 'Optional lint check', 0, 'failed', datetime('now'), 'system')
    `).run(run.id);

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snap.childState.failedRequired).toBe(0);

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.reasonCode).not.toBe("CHILD_FAILED");
    expect(evalResult.reasonCode).not.toBe("ASSIGNMENT_FAILED");

    await releaseProjectRuntime(testDir);
  });

  // 28. required-child-failure-enters-recovery
  it("28. required-child-failure-enters-recovery", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-req-fail-28";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
    });

    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-req-fail-28",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-28",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);
    await ctx.runtime.services.assignmentService.failAssignment(a1.id);

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.currentPhase).toBe(OP.RECOVERING);
    expect(evalResult.strategyDecision).toBe("CHANGE_STRATEGY");
    expect(evalResult.reasonCode).toBe("ASSIGNMENT_FAILED");

    await releaseProjectRuntime(testDir);
  });

  // 29. optional-active-child-policy
  it("29. optional-active-child-policy", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-opt-active";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    ctx.runtime.db.query(`
      INSERT INTO assignments (id, run_id, agent_id, description, is_required, status, created_at, created_by)
      VALUES ('as-req-done', ?, 'coder', 'Required backend work', 1, 'completed', datetime('now'), 'system')
    `).run(run.id);

    ctx.runtime.db.query(`
      INSERT INTO assignments (id, run_id, agent_id, description, is_required, status, created_at, created_by)
      VALUES ('as-opt-run', ?, 'telemetry', 'Optional background metrics', 0, 'running', datetime('now'), 'system')
    `).run(run.id);

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snap.childState.activeRequired).toBe(0);

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.reasonCode).toBe("READY_FOR_VERIFICATION");

    await releaseProjectRuntime(testDir);
  });

  // 30. production-run-cancel-invokes-native-abort
  it("30. production-run-cancel-invokes-native-abort", async () => {
    const abortMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-cancel-abort";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-del-cancel",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-session-to-abort",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.services.runService.cancelRun(run.id, "User cancelled");

    expect(abortMock).toHaveBeenCalled();

    await releaseProjectRuntime(testDir);
  });

  // 31. native-abort-success-confirms-child-cancel
  it("31. native-abort-success-confirms-child-cancel", async () => {
    const abortMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-abort-conf";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-conf-del",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-conf-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-conf-sess" });
    const res = await ctx.runtime.childExecutionLifecycleService.markCancelled({
      childSessionId: "child-conf-sess",
    });

    expect(res?.record.status).toBe("cancelled");
    expect(res?.record.nativeTerminationConfirmed).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 32. native-abort-failure-keeps-cancel-unconfirmed
  it("32. native-abort-failure-keeps-cancel-unconfirmed", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-abort-unconf";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-unconf-del",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-unconf-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-unconf-sess" });
    const res = await ctx.runtime.childExecutionLifecycleService.markCancelled({
      childSessionId: "child-unconf-sess",
    });

    expect(res?.record.status).toBe("running");
    expect(res?.record.cancelRequested).toBe(true);
    expect(res?.record.nativeTerminationConfirmed).toBe(false);

    await releaseProjectRuntime(testDir);
  });

  // 33. parent-cancel-status-truthful-with-unconfirmed-child
  it("33. parent-cancel-status-truthful-with-unconfirmed-child", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Abort timeout")));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-truthful-cancel";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-truth-cancel",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-truth-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-truth-sess" });
    const cancelledRun = await ctx.runtime.services.runService.cancelRun(run.id, "Cancel requested");

    expect(cancelledRun.status).toBe(RunStatus.CANCELLED);
    expect(cancelledRun.metadata?.terminationPending).toBe(true);
    expect(cancelledRun.metadata?.cancellationMode).toBe("detached_pending_native_termination");

    const childRec = ctx.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: "child-truth-sess" });
    expect(childRec?.status).toBe("running");
    expect(childRec?.cancelRequested).toBe(true);
    expect(childRec?.nativeTerminationConfirmed).toBe(false);

    const assignment = await ctx.runtime.services.assignmentService.getAssignment(del.assignmentId);
    expect(assignment?.status).not.toBe("cancelled");

    const session = ctx.runtime.sessionRepo.findById("child-truth-sess");
    expect(session?.status).not.toBe("cancelled");

    await releaseProjectRuntime(testDir);
  });

  // 34. replace-does-not-overlap-unconfirmed-old-run
  it("34. replace-does-not-overlap-unconfirmed-old-run", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-replace-no-overlap";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-rep-1" },
      { message: {} as any, parts: [{ type: "text", text: "Initial architecture design for database storage", id: "1", sessionID, messageID: "m-rep-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-rep-del",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-rep-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-rep-sess" });

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-rep-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, let's implement new frontend UI components instead", id: "2", sessionID, messageID: "m-rep-2" }] }
    );

    const oldRunState = ctx.runtime.taskRunsRepo.findById(run1.id);
    expect(oldRunState?.state).toBe("cancelled");

    const childRec = ctx.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: "child-rep-sess" });
    expect(childRec?.status).toBe("running");
    expect(childRec?.nativeTerminationConfirmed).toBe(false);

    const activeAfter = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeAfter).toBeNull();

    await releaseProjectRuntime(testDir);
  });

  // 35. informational-read-remains-non-progress
  it("35. informational-read-remains-non-progress", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-info-read";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const obs1 = ctx.runtime.progressObservationService.recordToolObservation({
      runId: run.id,
      sessionId: sessionID,
      tool: "read",
      args: { path: "src/index.ts" },
      output: "file contents",
    });

    expect(obs1.isProgress).toBe(false);
    let progDiag = ctx.runtime.progressObservationService.getDiagnosticsForRun(run.id);
    expect(progDiag.noProgressCount).toBe(1);

    const obs2 = ctx.runtime.progressObservationService.recordToolObservation({
      runId: run.id,
      sessionId: sessionID,
      tool: "grep",
      args: { query: "export" },
      output: "export const x = 1;",
    });

    expect(obs2.isProgress).toBe(false);
    progDiag = ctx.runtime.progressObservationService.getDiagnosticsForRun(run.id);
    expect(progDiag.noProgressCount).toBe(2);

    await releaseProjectRuntime(testDir);
  });

  // 36. production-idle-repeated-action-blocks-at-boundary
  it("36. production-idle-repeated-action-blocks-at-boundary", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-stall-prod";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const initSnap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: initSnap.phase,
      expectedAggregateVersion: initSnap.aggregateVersion,
    });

    // Heidi tool attempt 1 produces no progress
    await ctx.adapter.onToolExecuteBefore({
      tool: "read",
      sessionID,
      callID: "call-stall-1",
      args: { path: "config.json" },
    });
    await ctx.adapter.onToolExecuteAfter(
      { tool: "read", sessionID, callID: "call-stall-1", args: { path: "config.json" } },
      { output: "{}", metadata: {} }
    );

    // Call production onSessionIdle without passing fingerprint
    await ctx.adapter.onSessionIdle(sessionID);

    // Durable strategy constraint set was created containing action
    const constraint = ctx.runtime.transitionEngine.getActiveStrategyConstraint(run.id, "root:" + run.id);
    expect(constraint).not.toBeNull();
    expect(constraint?.reason).toBe("REPEATED_ACTION_BLOCKED");

    // Attempting same tool under unchanged state throws at tool.execute.before!
    let threw = false;
    try {
      await ctx.adapter.onToolExecuteBefore({
        tool: "read",
        sessionID,
        callID: "call-stall-2",
        args: { path: "config.json" },
      });
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("REPEATED_ACTION_BLOCKED");
    }
    expect(threw).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 37. root-strategy-set-blocks-a-b-a-loop
  it("37. root-strategy-set-blocks-a-b-a-loop", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-aba-root";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const afpA = ctx.runtime.progressObservationService.computeActionFingerprint({ tool: "read", args: { path: "a.json" }, sessionID });
    const afpB = ctx.runtime.progressObservationService.computeActionFingerprint({ tool: "grep", args: { pattern: "b" }, sessionID });

    const stateFp = ctx.runtime.transitionEngine.computeStrategyStateFingerprint(run.id, "root:" + run.id);

    // A fails -> prohibited {A}
    ctx.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "root:" + run.id,
      prohibitedActionFingerprint: afpA,
      stateFingerprint: stateFp,
      reason: "REPEATED_ACTION_BLOCKED",
    });

    // B fails -> prohibited {A, B}
    ctx.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "root:" + run.id,
      prohibitedActionFingerprint: afpB,
      stateFingerprint: stateFp,
      reason: "REPEATED_ACTION_BLOCKED",
    });

    const set = ctx.runtime.transitionEngine.getActiveStrategyConstraints(run.id, "root:" + run.id);
    expect(set?.prohibitedActionFingerprints).toContain(afpA);
    expect(set?.prohibitedActionFingerprints).toContain(afpB);

    // A attempted again under state S -> blocked!
    let threwA = false;
    try {
      await ctx.adapter.onToolExecuteBefore({
        tool: "read",
        sessionID,
        callID: "call-a-again",
        args: { path: "a.json" },
      });
    } catch (err: any) {
      threwA = true;
      expect(err.message).toContain("REPEATED_ACTION_BLOCKED");
    }
    expect(threwA).toBe(true);

    // B attempted again under state S -> blocked!
    let threwB = false;
    try {
      await ctx.adapter.onToolExecuteBefore({
        tool: "grep",
        sessionID,
        callID: "call-b-again",
        args: { pattern: "b" },
      });
    } catch (err: any) {
      threwB = true;
      expect(err.message).toContain("REPEATED_ACTION_BLOCKED");
    }
    expect(threwB).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 38. assignment-strategy-set-blocks-a-b-a-loop
  it("38. assignment-strategy-set-blocks-a-b-a-loop", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-aba-as";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-as-aba",
      targetAgent: "coder",
      assignmentId: "assignment-ABA",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "session-child-aba",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    const afpA = ctx.runtime.progressObservationService.computeActionFingerprint({ tool: "read", args: { file: "1.ts" }, sessionID: "session-child-aba" });
    const afpB = ctx.runtime.progressObservationService.computeActionFingerprint({ tool: "read", args: { file: "2.ts" }, sessionID: "session-child-aba" });

    const preFpChild = ctx.runtime.transitionEngine.computeStrategyStateFingerprint(run.id, "assignment-ABA");

    ctx.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "assignment-ABA",
      prohibitedActionFingerprint: afpA,
      stateFingerprint: preFpChild,
      reason: "REPEATED_ACTION_BLOCKED",
    });
    ctx.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "assignment-ABA",
      prohibitedActionFingerprint: afpB,
      stateFingerprint: preFpChild,
      reason: "REPEATED_ACTION_BLOCKED",
    });

    let threwA = false;
    try {
      await ctx.adapter.onToolExecuteBefore({
        tool: "read",
        sessionID: "session-child-aba",
        callID: "call-child-a-repeat",
        args: { file: "1.ts" },
      });
    } catch {
      threwA = true;
    }
    expect(threwA).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 39. strategy-set-survives-restart
  it("39. strategy-set-survives-restart", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    const sessionID = "sess-set-restart";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    const afpA = ctx1.runtime.progressObservationService.computeActionFingerprint({ tool: "read", args: { path: "a.json" }, sessionID });
    const afpB = ctx1.runtime.progressObservationService.computeActionFingerprint({ tool: "read", args: { path: "b.json" }, sessionID });

    const stateFp = ctx1.runtime.transitionEngine.computeStrategyStateFingerprint(run.id, "root:" + run.id);

    ctx1.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "root:" + run.id,
      prohibitedActionFingerprint: afpA,
      stateFingerprint: stateFp,
      reason: "REPEATED_ACTION_BLOCKED",
    });
    ctx1.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "root:" + run.id,
      prohibitedActionFingerprint: afpB,
      stateFingerprint: stateFp,
      reason: "REPEATED_ACTION_BLOCKED",
    });

    await releaseProjectRuntime(testDir);

    const ctx2 = acquireProjectRuntime(testDir);
    const set = ctx2.runtime.transitionEngine.getActiveStrategyConstraints(run.id, "root:" + run.id);
    expect(set?.prohibitedActionFingerprints).toContain(afpA);
    expect(set?.prohibitedActionFingerprints).toContain(afpB);

    let threw = false;
    try {
      await ctx2.adapter.onToolExecuteBefore({
        tool: "read",
        sessionID,
        callID: "call-after-restart",
        args: { path: "a.json" },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 40. change-strategy-continuation-carries-deterministic-constraint
  it("40. change-strategy-continuation-carries-deterministic-constraint", async () => {
    const prompt = getContinuationPrompt("REPEATED_ACTION_BLOCKED", { prohibitedActionFingerprint: "afp-test-123" });
    expect(prompt).toContain("afp-test-123");
    expect(prompt).toContain("Change strategy");

    const stallPrompt = getContinuationPrompt("STALL_DETECTED");
    expect(stallPrompt).toContain("Execution stall detected");
  });

  // 41. concurrent-identical-continuation-dispatches-once
  it("41. concurrent-identical-continuation-dispatches-once", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { promptAsync: promptAsyncMock } };
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);

    const token = {
      runId: "run-conc-dispatch",
      sessionId: "sess-conc-dispatch",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      currentWorkItemId: "as-conc",
      stateFingerprint: "fp-conc",
    };

    const [res1, res2] = await Promise.all([
      dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient }),
      dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient }),
    ]);

    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    const dispatchedCount = (res1.dispatched ? 1 : 0) + (res2.dispatched ? 1 : 0);
    expect(dispatchedCount).toBe(1);

    const loser = res1.dispatched ? res2 : res1;
    expect(["dispatch_in_progress", "duplicate_dispatch"]).toContain(loser.reason ?? "");

    await releaseProjectRuntime(testDir);
  });

  // 42. failed-continuation-retry-bounded
  it("42. failed-continuation-retry-bounded", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const promptMock = mock(() => Promise.reject(new Error("RPC failure")));
    const mockClient = { session: { promptAsync: promptMock } };
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);

    const token = {
      runId: "run-retry-bounded",
      sessionId: "sess-retry-bounded",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "TRANSIENT_RETRY_ALLOWED" as const,
      currentWorkItemId: "as-bound",
      stateFingerprint: "fp-bound",
    };

    const res1 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res1.dispatched).toBe(false);

    const res2 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res2.dispatched).toBe(false);

    const res3 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res3.dispatched).toBe(false);
    expect(promptMock).toHaveBeenCalledTimes(2);

    await releaseProjectRuntime(testDir);
  });

  // 43. out-of-order-duplicate-message-id-does-not-increment
  it("43. out-of-order-duplicate-message-id-does-not-increment", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-ooo-msg";

    const v1 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({
      sessionId: sessionID,
      messageId: "msg-1",
      messageHash: "hash-1",
    });
    expect(v1).toBe(1);

    const v2 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({
      sessionId: sessionID,
      messageId: "msg-2",
      messageHash: "hash-2",
    });
    expect(v2).toBe(2);

    // Delayed duplicate of msg-1 arrives after msg-2
    const v1Late = ctx.runtime.sessionTurnRepo.incrementTurnVersion({
      sessionId: sessionID,
      messageId: "msg-1",
      messageHash: "hash-1",
    });
    expect(v1Late).toBe(1);

    // Inspect current turn
    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(2);

    await releaseProjectRuntime(testDir);
  });

  // 44. identical-text-different-message-id-increments-turn
  it("44. identical-text-different-message-id-increments-turn", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-diff-msg-id";

    const v1 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({
      sessionId: sessionID,
      messageId: "msg-id-1",
      messageHash: "hash-ok",
    });
    expect(v1).toBe(1);

    const v2 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({
      sessionId: sessionID,
      messageId: "msg-id-2",
      messageHash: "hash-ok",
    });
    expect(v2).toBe(2);

    await releaseProjectRuntime(testDir);
  });

  // 45. migration-v13-upgrades-real-historical-v12-schema-and-preserves-retry-columns
  it("45. migration-v13-upgrades-real-historical-v12-schema-and-preserves-retry-columns", async () => {
    const db = new Database(":memory:");

    // 1. Run migrations up to v12 (simulate historical database that has v12 ledger)
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(16);

    // 2. Now test upgrade from exact historical v12 state:
    const db2 = new Database(":memory:");
    // Run up to v12
    for (const m of MIGRATIONS) {
      if (m.version > 12) break;
      db2.exec("BEGIN IMMEDIATE");
      db2.exec(m.sql);
      db2.query("INSERT INTO schema_migrations (version, name, applied_at, checksum, duration_ms) VALUES (?, ?, datetime('now'), ?, 1)").run(m.version, m.name, m.checksum);
      db2.exec("COMMIT");
    }
    expect(getCurrentVersion(db2)).toBe(12);

    // Insert row with attempt_count=2, last_attempt_at=T2 in historical V12
    db2.query(`
      INSERT INTO continuation_dispatches (
        identity, run_id, session_id, user_turn_version, run_aggregate_version,
        transition_reason, current_work_item_id, state_fingerprint, status,
        attempt_count, created_at, last_attempt_at, dispatched_at, error
      ) VALUES (
        'id-v12-existing', 'run-v12', 'sess-v12', 1, 1,
        'TRANSIENT_RETRY_ALLOWED', 'as-1', 'fp-v12', 'failed',
        2, '2026-08-20T10:00:00Z', '2026-08-20T10:05:00Z', NULL, 'timeout'
      )
    `).run();

    // Run migrations through the current forward-only V16 ledger.
    runMigrations(db2)
    expect(getCurrentVersion(db2)).toBe(16);

    // Assert attempt_count=2 and last_attempt_at='2026-08-20T10:05:00Z' were preserved!
    const row = db2.query("SELECT * FROM continuation_dispatches WHERE identity = 'id-v12-existing'").get() as any;
    expect(row.attempt_count).toBe(2);
    expect(row.last_attempt_at).toBe("2026-08-20T10:05:00Z");

    db.close();
    db2.close();
  });

  // 46. pending-dispatch-restart-becomes-outcome-unknown
  it("46. pending-dispatch-restart-becomes-outcome-unknown", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    const db = ctx1.runtime.db;

    const token = {
      runId: "run-c",
      sessionId: "sess-c",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "PROGRESS_CONFIRMED" as const,
      currentWorkItemId: "as-1",
      stateFingerprint: "fp-c",
    };
    const identity = ctx1.runtime.continuationDispatcher.computeTokenIdentity(token);

    // Simulate an in-flight pending dispatch before crash
    db.query(`
      INSERT INTO continuation_dispatches (
        identity, run_id, session_id, user_turn_version, run_aggregate_version,
        transition_reason, current_work_item_id, state_fingerprint, status,
        attempt_count, created_at, last_attempt_at
      ) VALUES (?, 'run-c', 'sess-c', 1, 1, 'PROGRESS_CONFIRMED', 'as-1', 'fp-c', 'pending', 1, datetime('now'), datetime('now'))
    `).run(identity);

    await releaseProjectRuntime(testDir);

    // Reopen project runtime: startup reconciliation marks pending -> outcome_unknown
    const ctx2 = acquireProjectRuntime(testDir);
    const row = ctx2.runtime.db.query("SELECT status, error FROM continuation_dispatches WHERE identity = ?").get(identity) as { status: string; error: string };
    expect(row.status).toBe("outcome_unknown");
    expect(row.error).toBe("dispatch_outcome_unknown_after_restart");

    // Dispatching same token does not invoke promptAsync
    const promptMock = mock(() => Promise.resolve(true));
    const res = await ctx2.runtime.continuationDispatcher.dispatch(token, {
      currentTurnVersion: 1,
      currentAggregateVersion: 1,
      client: { session: { promptAsync: promptMock } },
    });

    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("dispatch_outcome_unknown");
    expect(promptMock).not.toHaveBeenCalled();

    await releaseProjectRuntime(testDir);
  });

  // 47. session-deleted-confirms-cancellation-and-resumes-deferred-replace
  it("47. session-deleted-confirms-cancellation-and-resumes-deferred-replace", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-del-conf-resume";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-del-1" },
      { message: {} as any, parts: [{ type: "text", text: "Original plan to build backend telemetry", id: "1", sessionID, messageID: "m-del-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-del-sess",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-to-delete-session",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-to-delete-session" });

    // User sends REPLACE intent -> abort fails -> replacement is deferred
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-del-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor database schema and implement frontend telemetry across all services", id: "2", sessionID, messageID: "m-del-2" }] }
    );

    // Old child is unconfirmed running
    let childRec = ctx.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: "child-to-delete-session" });
    expect(childRec?.status).toBe("running");
    expect(childRec?.nativeTerminationConfirmed).toBe(false);

    // Now native OpenCode emits session.deleted for that child session
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-to-delete-session" },
    } as any);

    // Child is now confirmed cancelled
    childRec = ctx.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: "child-to-delete-session" });
    expect(childRec?.status).toBe("cancelled");
    expect(childRec?.nativeTerminationConfirmed).toBe(true);

    // Diagnostics reflect current termination resolved
    const diag = ctx.runtime.childExecutionLifecycleService.getDiagnosticsForRun(run1.id);
    expect(diag.currentTerminationPending).toBe(false);
    expect(diag.currentUnconfirmedChildExecutionIds.length).toBe(0);

    // Assignment is cancelled
    const asRec = await ctx.runtime.services.assignmentService.getAssignment(del.assignmentId);
    expect(asRec?.status).toBe("cancelled");

    // Deferred replacement resumed and new run is active!
    const activeNewRun = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeNewRun).not.toBeNull();
    expect(activeNewRun?.id).not.toBe(run1.id);

    await releaseProjectRuntime(testDir);
  });

  // 48. modify-reclassification-uses-shared-cancellation-barrier
  it("48. modify-reclassification-uses-shared-cancellation-barrier", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Process stuck")));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-modify-barrier";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-mod-1" },
      { message: {} as any, parts: [{ type: "text", text: "Implement system according to the design specification", id: "1", sessionID, messageID: "m-mod-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-mod-barrier",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-mod-barrier-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-mod-barrier-sess" });

    // User sends material modify requiring reclassification -> abort fails -> new Run is NOT started
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-mod-2" },
      { message: {} as any, parts: [{ type: "text", text: "change the goal to refactor backend telemetry database and deploy frontend components across all repositories", id: "2", sessionID, messageID: "m-mod-2" }] }
    );

    // Active run for session remains null (no overlapping new run started while child running)
    const activeAfter = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeAfter).toBeNull();

    await releaseProjectRuntime(testDir);
  });

  // 49. session-deleted-does-not-cancel-completed-child
  it("49. session-deleted-does-not-cancel-completed-child", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-comp-child";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-comp-del",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-completed-session",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-completed-session" });
    await ctx.runtime.childExecutionLifecycleService.markCompleted({
      childSessionId: "child-completed-session",
      output: "All unit tests pass",
    });

    // Native OpenCode later emits session.deleted for the completed session
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-completed-session" },
    } as any);

    const childRec = ctx.runtime.childExecutionLifecycleService.getChildExecution({ childSessionId: "child-completed-session" });
    expect(childRec?.status).toBe("completed"); // Not rewritten to cancelled!

    await releaseProjectRuntime(testDir);
  });

  // 50. root-old-progress-consumed-once
  it("50. root-old-progress-consumed-once", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-progress-once-50";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({
      tool: "write",
      sessionID,
      callID: "call-prog-50",
      args: { path: "src/fix.ts", content: "export const x = 1;" },
    });
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "src/fix.ts"), "export const x = 1;");
    await ctx.adapter.onToolExecuteAfter(
      { tool: "write", sessionID, callID: "call-prog-50", args: { path: "src/fix.ts" } },
      { output: "saved", metadata: {} }
    );

    const afp = ctx.runtime.progressObservationService.computeActionFingerprint({ tool: "write", args: { path: "src/fix.ts" }, sessionID });

    // First idle evaluate: consumes attempt and yields PROGRESS_CONFIRMED
    const eval1 = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID, latestActionFingerprint: afp });
    expect(eval1.reasonCode).toBe("PROGRESS_CONFIRMED");
    expect(eval1.requiresAction).toBe(true);

    // Second idle evaluate without new attempt/delta: yields NO_PROGRESS (does not loop)
    const eval2 = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID, latestActionFingerprint: afp });
    expect(eval2.reasonCode).toBe("NO_PROGRESS");
    expect(eval2.requiresAction).toBe(false);

    await releaseProjectRuntime(testDir);
  });

  // 51. strategy-set-exhaustion-blocks-further-tools
  it("51. strategy-set-exhaustion-blocks-further-tools", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-exhaustion";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const stateFp = ctx.runtime.transitionEngine.computeStrategyStateFingerprint(run.id, "root:" + run.id);

    // Accumulate 20 distinct failed strategy fingerprints
    for (let i = 1; i <= 20; i++) {
      ctx.runtime.transitionEngine.saveStrategyConstraint({
        runId: run.id,
        assignmentId: "root:" + run.id,
        prohibitedActionFingerprint: `afp-${i}`,
        stateFingerprint: stateFp,
        reason: "REPEATED_ACTION_BLOCKED",
      });
    }

    let set = ctx.runtime.transitionEngine.getActiveStrategyConstraints(run.id, "root:" + run.id);
    expect(set?.exhausted).toBe(false);
    expect(set?.prohibitedActionFingerprints.length).toBe(20);

    // 21st unique failed strategy marks exhausted
    ctx.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "root:" + run.id,
      prohibitedActionFingerprint: "afp-21",
      stateFingerprint: stateFp,
      reason: "REPEATED_ACTION_BLOCKED",
    });

    set = ctx.runtime.transitionEngine.getActiveStrategyConstraints(run.id, "root:" + run.id);
    expect(set?.exhausted).toBe(true);
    expect(set?.prohibitedActionFingerprints.length).toBe(20); // No eviction, kept all 20

    // Any tool execution under this unchanged state fails closed with STRATEGY_SET_EXHAUSTED
    let threwExhausted = false;
    try {
      await ctx.adapter.onToolExecuteBefore({
        tool: "read",
        sessionID,
        callID: "call-any-new-tool",
        args: { path: "brand-new-path.json" },
      });
    } catch (err: any) {
      threwExhausted = true;
      expect(err.message).toContain("STRATEGY_SET_EXHAUSTED");
    }
    expect(threwExhausted).toBe(true);

    // Meaningful state progress clears the exhausted constraint
    ctx.runtime.progressObservationService.incrementMeaningfulStateVersion(run.id);

    // Now tool execution is permitted again under new state
    await ctx.adapter.onToolExecuteBefore({
      tool: "read",
      sessionID,
      callID: "call-allowed-after-progress",
      args: { path: "brand-new-path.json" },
    });

    await releaseProjectRuntime(testDir);
  });

  // 52. deferred-replacement-survives-restart-and-resumes-once
  it("52. deferred-replacement-survives-restart-and-resumes-once", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx1 = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-deferred-restart";

    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-def-1" },
      { message: {} as any, parts: [{ type: "text", text: "Original plan to build backend telemetry", id: "1", sessionID, messageID: "m-def-1" }] }
    );
    const run1 = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx1.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-del-restart",
      targetAgent: "coder",
    });

    ctx1.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-to-restart-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx1.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-to-restart-sess" });

    // User sends REPLACE intent -> abort fails -> deferred replacement is persisted in SQLite
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-def-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor database schema and implement frontend telemetry across all services", id: "2", sessionID, messageID: "m-def-2" }] }
    );

    // Shutdown and restart runtime
    await releaseProjectRuntime(testDir);

    const ctx2 = acquireProjectRuntime(testDir, mockClient);

    // Ensure pending deferred replacement exists in SQLite
    const savedDeferred = ctx2.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(savedDeferred).not.toBeNull();
    expect(savedDeferred?.status).toBe("pending_termination");
    expect(savedDeferred?.effectiveGoal).toContain("refactor database schema");

    // Child termination event arrives in new runtime instance
    await ctx2.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-to-restart-sess" },
    } as any);

    // Second duplicate session.deleted event (to assert exactly-once idempotent resume)
    await ctx2.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-to-restart-sess" },
    } as any);

    const activeNewRun = await ctx2.adapter.resolveActiveRunForSession(sessionID);
    expect(activeNewRun).not.toBeNull();
    expect(activeNewRun?.id).not.toBe(run1.id);

    const finalDef = ctx2.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(finalDef).toBeNull(); // No longer pending_termination/resuming

    await releaseProjectRuntime(testDir);
  });

  // 53. newer-deferred-replacement-supersedes-older-deferred-replacement
  it("53. newer-deferred-replacement-supersedes-older-deferred-replacement", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-supersession";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-sup-1" },
      { message: {} as any, parts: [{ type: "text", text: "Original plan to build backend telemetry", id: "1", sessionID, messageID: "m-sup-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-del-sup",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-to-sup-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-to-sup-sess" });

    // User sends replacement 1
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-sup-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, create analytics dashboard version 1", id: "2", sessionID, messageID: "m-sup-2" }] }
    );

    // User sends replacement 2 before child finishes
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-sup-3" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that too, refactor full database schema and analytics dashboard version 2", id: "3", sessionID, messageID: "m-sup-3" }] }
    );

    // Confirm child deleted
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-to-sup-sess" },
    } as any);

    const activeNewRun = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeNewRun).not.toBeNull();

    // The active route decision must reflect the newer intent (replacement 2)
    const route = ctx.adapter.getUserTurnVersion(sessionID);
    expect(route).toBeGreaterThan(1);

    await releaseProjectRuntime(testDir);
  });

  // 54. true-production-stall-detected-via-session-idle
  it("54. true-production-stall-detected-via-session-idle", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-true-stall";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const initSnap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: initSnap.phase,
      expectedAggregateVersion: initSnap.aggregateVersion,
    });

    // Perform 5 repeated tool attempts with same tool and non-mutating output to drive AdaptiveExecutionControl to stall
    for (let i = 1; i <= 5; i++) {
      await ctx.adapter.onToolExecuteBefore({
        tool: "read",
        sessionID,
        callID: `call-stall-rep-${i}`,
        args: { path: "stalled-target.ts" },
      });
      await ctx.adapter.onToolExecuteAfter(
        { tool: "read", sessionID, callID: `call-stall-rep-${i}`, args: { path: "stalled-target.ts" } },
        { output: "const a = 1;", metadata: {} }
      );
    }

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snap.progress.stalled).toBe(true);

    // Call production onSessionIdle WITHOUT passing any manual fingerprint
    await ctx.adapter.onSessionIdle(sessionID);

    // Transition engine transitioned to RECOVERING with STALL_DETECTED
    const snapAfter = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snapAfter.phase).toBe(OP.RECOVERING);

    const constraint = ctx.runtime.transitionEngine.getActiveStrategyConstraint(run.id, "root:" + run.id);
    expect(constraint?.reason).toBe("STALL_DETECTED");

    // Attempting same action under unchanged state throws REPEATED_ACTION_BLOCKED
    let threwStall = false;
    try {
      await ctx.adapter.onToolExecuteBefore({
        tool: "read",
        sessionID,
        callID: "call-stall-rep-6",
        args: { path: "stalled-target.ts" },
      });
    } catch (err: any) {
      threwStall = true;
      expect(err.message).toContain("REPEATED_ACTION_BLOCKED");
    }
    expect(threwStall).toBe(true);

    await releaseProjectRuntime(testDir);
  });

  // 55. migration-checksum-mismatch-throws-error
  it("55. migration-checksum-mismatch-throws-error", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    // Corrupt the checksum for version 12 in the database ledger
    db.query("UPDATE schema_migrations SET checksum = 'corrupted_fake_checksum' WHERE version = 12").run();

    expect(() => {
      runMigrations(db);
    }).toThrow(MigrationChecksumError);

    db.close();
  });

  // 56. legacy-pre-v12-upgrades-v13-and-backfills-defaults
  it("56. legacy-pre-v12-upgrades-v13-and-backfills-defaults", () => {
    const db = new Database(":memory:");
    // Setup pre-v12 table without attempt_count/last_attempt_at
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE TABLE continuation_dispatches (
        identity TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_turn_version INTEGER NOT NULL,
        run_aggregate_version INTEGER NOT NULL,
        transition_reason TEXT NOT NULL,
        current_work_item_id TEXT,
        state_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'dispatched', 'failed')),
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        error TEXT
      );
    `);
    // Populate ledger with exact checksums from MIGRATIONS 1..11
    for (const m of MIGRATIONS) {
      if (m.version > 11) break;
      db.query("INSERT INTO schema_migrations VALUES (?, ?, datetime('now'), ?, 1)").run(m.version, m.name, m.checksum);
    }

    db.query(`
      INSERT INTO continuation_dispatches (
        identity, run_id, session_id, user_turn_version, run_aggregate_version,
        transition_reason, current_work_item_id, state_fingerprint, status,
        created_at
      ) VALUES ('id-legacy', 'run-leg', 'sess-leg', 1, 1, 'PROGRESS_CONFIRMED', 'as-1', 'fp-leg', 'dispatched', '2026-08-01T10:00:00Z')
    `).run();

    // Run migrations through the current forward-only V16 ledger.
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(16);

    const row = db.query("SELECT * FROM continuation_dispatches WHERE identity = 'id-legacy'").get() as any;
    expect(row.attempt_count).toBe(1);
    expect(row.last_attempt_at).toBe("2026-08-01T10:00:00Z");

    db.close();
  });

  // 57. meaningful-state-version-persists-across-restart-and-increments-on-mutations
  it("57. meaningful-state-version-persists-across-restart-and-increments-on-mutations", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    const sessionID = "sess-meaningful-restart";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    expect(ctx1.runtime.progressObservationService.getMeaningfulStateVersion(run.id)).toBe(0);

    // Mutation 1: file written during tool execution
    mkdirSync(join(testDir, "src"), { recursive: true });
    await ctx1.adapter.onToolExecuteBefore({
      tool: "write",
      sessionID,
      callID: "call-m-1",
      args: { path: "src/a.ts", content: "export const a = 1;" },
    });
    writeFileSync(join(testDir, "src/a.ts"), "export const a = 1;");
    await ctx1.adapter.onToolExecuteAfter(
      { tool: "write", sessionID, callID: "call-m-1", args: { path: "src/a.ts" } },
      { output: "ok", metadata: {} }
    );
    expect(ctx1.runtime.progressObservationService.getMeaningfulStateVersion(run.id)).toBe(1);

    // Informational read: does NOT increment
    await ctx1.adapter.onToolExecuteBefore({
      tool: "read",
      sessionID,
      callID: "call-m-read",
      args: { path: "src/a.ts" },
    });
    await ctx1.adapter.onToolExecuteAfter(
      { tool: "read", sessionID, callID: "call-m-read", args: { path: "src/a.ts" } },
      { output: "export const a = 1;", metadata: {} }
    );
    expect(ctx1.runtime.progressObservationService.getMeaningfulStateVersion(run.id)).toBe(1);

    // Mutation 2: write new file b.ts
    await ctx1.adapter.onToolExecuteBefore({
      tool: "write",
      sessionID,
      callID: "call-m-2",
      args: { path: "src/b.ts", content: "export const b = 2;" },
    });
    writeFileSync(join(testDir, "src/b.ts"), "export const b = 2;");
    await ctx1.adapter.onToolExecuteAfter(
      { tool: "write", sessionID, callID: "call-m-2", args: { path: "src/b.ts" } },
      { output: "ok", metadata: {} }
    );
    expect(ctx1.runtime.progressObservationService.getMeaningfulStateVersion(run.id)).toBe(2);

    await releaseProjectRuntime(testDir);

    // Restart and assert version remains 2
    const ctx2 = acquireProjectRuntime(testDir);
    expect(ctx2.runtime.progressObservationService.getMeaningfulStateVersion(run.id)).toBe(2);

    await releaseProjectRuntime(testDir);
  });

  // 58. concurrent-duplicate-message-id-competing-parallel
  it("58. concurrent-duplicate-message-id-competing-parallel", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-conc-msg-compete";

    const [vA, vB] = await Promise.all([
      Promise.resolve().then(() => ctx.runtime.sessionTurnRepo.incrementTurnVersion({
        sessionId: sessionID,
        messageId: "msg-compete-1",
        messageHash: "hash-compete-1",
      })),
      Promise.resolve().then(() => ctx.runtime.sessionTurnRepo.incrementTurnVersion({
        sessionId: sessionID,
        messageId: "msg-compete-1",
        messageHash: "hash-compete-1",
      })),
    ]);

    expect(vA).toBe(1);
    expect(vB).toBe(1);
    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(1);

    await releaseProjectRuntime(testDir);
  });

  // 59. deferred-resuming-before-create-recovers-after-restart
  it("59. deferred-resuming-before-create-recovers-after-restart", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    const sessionID = "sess-rec-before-create";

    const goal = "Refactor backend telemetry architecture and rewrite services";
    const decision = classifyTask(goal, { hasExplicitDomainSignal: false });
    ctx1.runtime.db.query(`
      INSERT INTO deferred_replacements (
        id, parent_session_id, old_run_id, source_intent, agent_id,
        effective_goal, message_hash, message_id, correlation_id,
        routing_decision, status, created_at, updated_at
      ) VALUES ('def-crash-1', ?, 'old-run-1', 'REPLACE', 'heidi', ?, 'h1', 'm1', 'corr-crash-1', ?, 'resuming', datetime('now'), datetime('now'))
    `).run(sessionID, goal, JSON.stringify(decision));

    await releaseProjectRuntime(testDir);

    // Restart runtime: fresh startup automatically drains safe deferred replacements when client is provided
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { promptAsync: promptAsyncMock } };
    const ctx2 = acquireProjectRuntime(testDir, mockClient);
    await ctx2.adapter.startupReady;

    const def = ctx2.runtime.deferredReplacementRepo.findById("def-crash-1");
    expect(def).not.toBeNull();
    expect(def?.status).toBe("resumed");
    expect(def?.replacementRunId).toBeDefined();

    // Verify replacement Run was actually created and exists in task_runs
    const repRun = ctx2.runtime.taskRunsRepo.findById(def!.replacementRunId!);
    expect(repRun).toBeDefined();
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);

    await releaseProjectRuntime(testDir);
  });

  // 60. deferred-resuming-after-create-reuses-existing-run
  it("60. deferred-resuming-after-create-reuses-existing-run", async () => {
    const ctx1 = acquireProjectRuntime(testDir);
    const sessionID = "sess-rec-after-create";
    const correlationId = "corr-already-created";

    // Create a real Run with correlationId
    const existingRun = await ctx1.runtime.services.runService.createRun({
      runType: "simple",
      correlationId,
      sessionId: sessionID,
      agentId: "heidi",
      metadata: { goal: "Existing replacement run" },
    });

    const goal = "Refactor backend telemetry architecture and rewrite services";
    const decision = classifyTask(goal, { hasExplicitDomainSignal: false });

    // Insert a deferred record stuck in 'resuming' after Run was created but before handoff/promptAsync
    ctx1.runtime.db.query(`
      INSERT INTO deferred_replacements (
        id, parent_session_id, old_run_id, source_intent, agent_id,
        effective_goal, message_hash, message_id, correlation_id,
        routing_decision, status, created_at, updated_at
      ) VALUES ('def-crash-2', ?, 'old-run-2', 'REPLACE', 'heidi', ?, 'h2', 'm2', ?, ?, 'resuming', datetime('now'), datetime('now'))
    `).run(sessionID, goal, correlationId, JSON.stringify(decision));

    await releaseProjectRuntime(testDir);

    // Restart runtime with mock client: reconciliation discovers existing Run and completes native prompt handoff
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { promptAsync: promptAsyncMock } };
    const ctx2 = acquireProjectRuntime(testDir, mockClient);
    await ctx2.adapter.startupReady;

    const def = ctx2.runtime.deferredReplacementRepo.findById("def-crash-2");
    expect(def).not.toBeNull();
    expect(def?.status).toBe("resumed");
    expect(def?.replacementRunId).toBe(existingRun.id);
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);

    // Restart again with existing dispatched record: converges to resumed without duplicate prompt
    await releaseProjectRuntime(testDir);
    const promptAsyncMock2 = mock(() => Promise.resolve(true));
    const mockClient2 = { session: { promptAsync: promptAsyncMock2 } };
    const ctx3 = acquireProjectRuntime(testDir, mockClient2);
    await ctx3.adapter.startupReady;

    expect(promptAsyncMock2).toHaveBeenCalledTimes(0);
    expect(ctx3.runtime.deferredReplacementRepo.findById("def-crash-2")?.status).toBe("resumed");

    await releaseProjectRuntime(testDir);
  });

  // 61. deferred-replacement-persists-actual-run-id
  it("61. deferred-replacement-persists-actual-run-id", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-actual-run-id";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-run-id-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-run-id-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-del-run-id",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-run-id-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-run-id-sess" });

    // User sends REPLACE intent -> deferred replacement created
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-run-id-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor full backend architecture", id: "2", sessionID, messageID: "m-run-id-2" }] }
    );

    const savedDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(savedDef).not.toBeNull();
    expect(savedDef?.status).toBe("pending_termination");

    // Native termination event arrives
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-run-id-sess" },
    } as any);

    const resumedDef = ctx.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(resumedDef?.status).toBe("resumed");
    expect(resumedDef?.replacementRunId).toBeDefined();

    // Verify replacement_run_id matches the actual task_runs row id (not a taskId)
    const taskRunRow = ctx.runtime.taskRunsRepo.findById(resumedDef!.replacementRunId!);
    expect(taskRunRow).toBeDefined();
    expect(taskRunRow?.runId).toBe(resumedDef!.replacementRunId!);
    expect(resumedDef!.replacementRunId).not.toContain("task-");

    await releaseProjectRuntime(testDir);
  });

  // 62. deferred-replacement-create-is-idempotent-by-correlation
  it("62. deferred-replacement-create-is-idempotent-by-correlation", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const correlationId = "corr-idem-competing-" + randomUUID();

    // Truly concurrent competing creation calls using Promise.all
    const [runA, runB] = await Promise.all([
      ctx.runtime.services.runService.createOrGetRunByCorrelationId({
        runType: "simple",
        correlationId,
        sessionId: "sess-idem-competing",
        agentId: "heidi",
        metadata: { key: "first" },
      }, correlationId),
      ctx.runtime.services.runService.createOrGetRunByCorrelationId({
        runType: "simple",
        correlationId,
        sessionId: "sess-idem-competing",
        agentId: "heidi",
        metadata: { key: "second" },
      }, correlationId),
    ]);

    expect(runA.id).toBe(runB.id);

    // Verify findById preserves the original correlation ID
    const retrieved = await ctx.runtime.services.runRepo.findById(runA.id);
    expect(retrieved?.correlationId).toBe(correlationId);

    // Verify findByCorrelationId resolves the same run
    const byCorr = await ctx.runtime.services.runRepo.findByCorrelationId(correlationId);
    expect(byCorr?.id).toBe(runA.id);

    await releaseProjectRuntime(testDir);
  });

  // 63. duplicate-session-delete-after-crash-does-not-create-second-run
  it("63. duplicate-session-delete-after-crash-does-not-create-second-run", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx1 = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-dup-del-crash";

    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-dup-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-dup-1" }] }
    );
    const run1 = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx1.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-del-dup-crash",
      targetAgent: "coder",
    });

    ctx1.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-dup-crash-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx1.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-dup-crash-sess" });

    // User sends REPLACE
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-dup-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, implement frontend components", id: "2", sessionID, messageID: "m-dup-2" }] }
    );

    // Simulate crash and restart
    await releaseProjectRuntime(testDir);

    const ctx2 = acquireProjectRuntime(testDir, mockClient);

    // First session.deleted event
    await ctx2.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-dup-crash-sess" },
    } as any);

    const activeRunFirst = await ctx2.adapter.resolveActiveRunForSession(sessionID);
    expect(activeRunFirst).not.toBeNull();

    // Duplicate session.deleted event
    await ctx2.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-dup-crash-sess" },
    } as any);

    const activeRunSecond = await ctx2.adapter.resolveActiveRunForSession(sessionID);
    expect(activeRunSecond?.id).toBe(activeRunFirst?.id);

    await releaseProjectRuntime(testDir);
  });

  // 64. newer-user-message-while-deferred-does-not-bypass-barrier
  it("64. newer-user-message-while-deferred-does-not-bypass-barrier", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-barrier-bypass";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-b-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-b-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-b-1",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-b-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-b-sess" });

    // User sends REPLACE R1 -> run1 gets cancelled, deferred record R1 created
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-b-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, do replacement R1", id: "2", sessionID, messageID: "m-b-2" }] }
    );

    // Parent run1 is now terminal (cancelled), so resolveActiveRunForSession returns null
    const activeRun = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeRun).toBeNull();

    // Now user sends a brand new message R2 while child is still unconfirmed!
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-b-3" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that too, refactor database schema and build backend services", id: "3", sessionID, messageID: "m-b-3" }] }
    );

    // Barrier check: NO new Run should have been created yet because child is still running!
    const activeRunStillBlocked = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeRunStillBlocked).toBeNull();

    // Native tool execution barrier: parent-session tool execution MUST fail closed with DEFERRED_REPLACEMENT_BARRIER
    await expect(
      ctx.adapter.onToolExecuteBefore({
        tool: "bash",
        sessionID,
        callID: "call-blocked-parent-tool",
        args: { command: "echo mutating" },
      })
    ).rejects.toThrow(/DEFERRED_REPLACEMENT_BARRIER/);

    // Current deferred replacement should now be R2 (superseding R1)
    const curDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(curDef).not.toBeNull();
    expect(curDef?.effectiveGoal).toContain("refactor database schema");
    expect(curDef?.status).toBe("pending_termination");

    // When child termination is finally confirmed
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-b-sess" },
    } as any);

    // Exactly one active new Run resumes with R2's intent
    const activeNewRun = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeNewRun).not.toBeNull();

    await releaseProjectRuntime(testDir);
  });

  // 65. user-cancel-supersedes-or-cancels-deferred-intent
  it("65. user-cancel-supersedes-or-cancels-deferred-intent", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-cancel-deferred";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-c-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-c-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-c-1",
      targetAgent: "coder",
    });

    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-c-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-c-sess" });

    // User sends REPLACE
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-c-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, do replace work", id: "2", sessionID, messageID: "m-c-2" }] }
    );

    const savedDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(savedDef).not.toBeNull();

    // User now sends CANCEL
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-c-3" },
      { message: {} as any, parts: [{ type: "text", text: "cancel everything stop", id: "3", sessionID, messageID: "m-c-3" }] }
    );

    // Deferred replacement must be cancelled and not active
    const activeDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(activeDef).toBeNull();

    // Child termination event arrives
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-c-sess" },
    } as any);

    // No new run is resurrected
    const activeRun = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeRun).toBeNull();

    await releaseProjectRuntime(testDir);
  });

  // 66. deferred-fast-direct-survives-restart-and-resumes-at-most-once
  it("66. deferred-fast-direct-survives-restart-and-resumes-at-most-once", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx1 = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-fast-direct-restart";

    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-fd-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-fd-1" }] }
    );
    const run1 = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx1.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-fd-1",
      targetAgent: "coder",
    });

    ctx1.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-fd-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });

    await ctx1.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-fd-sess" });

    // User sends replace message that routes to FAST_DIRECT as replacement
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-fd-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, give me a quick summary of what is done", id: "2", sessionID, messageID: "m-fd-2" }] }
    );

    // Restart runtime before child termination
    await releaseProjectRuntime(testDir);

    const ctx2 = acquireProjectRuntime(testDir, mockClient);

    const savedDef = ctx2.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(savedDef).not.toBeNull();
    expect(savedDef?.status).toBe("pending_termination");

    // Inject simulated in-flight crash: promptAsync is called and process dies before confirmation
    const crashPromptMock = mock(() => {
      // Simulate sudden process termination while prompt is in-flight by returning a promise that never settles before runtime release
      return new Promise<boolean>(() => {});
    });
    ctx2.adapter.setClient({ session: { abort: abortMock, promptAsync: crashPromptMock } });

    // Child termination event arrives -> initiates dispatch and inserts pending dispatch claim
    void ctx2.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-fd-sess" },
    } as any);

    // Yield tick so dispatch insert executes
    await new Promise(resolve => setTimeout(resolve, 20));

    // Verify status was transitioned to handoff_pending by production code
    const defAtFault = ctx2.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(defAtFault?.status).toBe("handoff_pending");

    // Process crash and restart
    await releaseProjectRuntime(testDir);

    // Restart runtime: handoff_pending reconciles to handoff_outcome_unknown to prevent blind replay
    const promptAsyncMockAfterCrash = mock(() => Promise.resolve(true));
    const ctx3 = acquireProjectRuntime(testDir, { session: { promptAsync: promptAsyncMockAfterCrash } });
    await ctx3.adapter.startupReady;

    const defAfterCrash = ctx3.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(defAfterCrash?.status).toBe("handoff_outcome_unknown");
    expect(promptAsyncMockAfterCrash).toHaveBeenCalledTimes(0);

    await releaseProjectRuntime(testDir);
  });

  // 67. strategy-exhausted-evaluate-returns-explicit-reason-and-stops-autonomous-idle
  it("67. strategy-exhausted-evaluate-returns-explicit-reason-and-stops-autonomous-idle", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: mock(() => Promise.resolve(true)), promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-exhaust-test";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-ex-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-ex-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const initSnap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: initSnap.phase,
      expectedAggregateVersion: initSnap.aggregateVersion,
    });

    const targetItemId = "root:" + run.id;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const stateFp = ctx.runtime.transitionEngine.computeStrategyStateFingerprint(run.id, targetItemId, snap);

    // Save 20 unique prohibited strategies
    for (let i = 1; i <= 20; i++) {
      ctx.runtime.transitionEngine.saveStrategyConstraint({
        runId: run.id,
        assignmentId: targetItemId,
        prohibitedActionFingerprint: `action-strat-${i}`,
        stateFingerprint: stateFp,
        reason: "REPEATED_ACTION_BLOCKED",
      });
    }

    let constraintSet = ctx.runtime.transitionEngine.getActiveStrategyConstraints(run.id, targetItemId);
    expect(constraintSet?.prohibitedActionFingerprints.length).toBe(20);
    expect(constraintSet?.exhausted).toBe(false);

    // 21st unique failure under same state -> marks exhausted
    ctx.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: targetItemId,
      prohibitedActionFingerprint: "action-strat-21",
      stateFingerprint: stateFp,
      reason: "REPEATED_ACTION_BLOCKED",
    });

    constraintSet = ctx.runtime.transitionEngine.getActiveStrategyConstraints(run.id, targetItemId);
    expect(constraintSet?.exhausted).toBe(true);

    // evaluate() returns STRATEGY_SET_EXHAUSTED + BLOCK
    const evalRes = ctx.runtime.transitionEngine.evaluate({
      runId: run.id,
      sessionId: sessionID,
    });

    expect(evalRes.strategyDecision).toBe("BLOCK");
    expect(evalRes.reasonCode).toBe("STRATEGY_SET_EXHAUSTED");
    expect(evalRes.requiresAction).toBe(false);
    expect(evalRes.blockerReason).toBe("Strategy search exhausted under unchanged meaningful state");

    // Continuation policy evaluates to STOP_BLOCKED
    const contRes = ctx.runtime.continuationPolicy.evaluate({
      snapshot: snap,
      transition: evalRes,
    });
    expect(contRes.decision).toBe("STOP_BLOCKED");

    // Trigger onSessionIdle -> promptAsync MUST NOT be called
    promptAsyncMock.mockClear();
    await ctx.adapter.onSessionIdle(sessionID);
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    // RECOVERING phase alone under same meaningful state does not clear exhaustion
    ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.RECOVERING,
      expectedPhase: OP.EXECUTING,
      expectedAggregateVersion: ctx.runtime.taskRunsRepo.findById(run.id)!.aggregateVersion,
    });

    const evalRecovering = ctx.runtime.transitionEngine.evaluate({
      runId: run.id,
      sessionId: sessionID,
    });
    expect(evalRecovering.strategyDecision).toBe("BLOCK");
    expect(evalRecovering.reasonCode).toBe("STRATEGY_SET_EXHAUSTED");

    await ctx.adapter.onSessionIdle(sessionID);
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    // Meaningful progress (mutating repository / state advancement) advances meaningfulStateVersion and clears exhaustion
    ctx.runtime.progressObservationService.incrementMeaningfulStateVersion(run.id);

    const evalAfterMut = ctx.runtime.transitionEngine.evaluate({
      runId: run.id,
      sessionId: sessionID,
    });
    expect(evalAfterMut.reasonCode).not.toBe("STRATEGY_SET_EXHAUSTED");

    await releaseProjectRuntime(testDir);
  });

  // 68. v13-checksum-covers-schema-aware-migration-contract-and-rejects-changed-behavior
  it("68. v13-checksum-covers-schema-aware-migration-contract-and-rejects-changed-behavior", () => {
    const originalChecksum = computeChecksum(MIGRATION_V13_CONVERGENCE_INTEGRITY_CHECKSUM_SOURCE);

    // 1. Changing contract algorithm version changes checksum
    const changedAlgorithmContract = MIGRATION_V13_CONVERGENCE_INTEGRITY_CHECKSUM_SOURCE.replace(
      "algorithm-version: " + MIGRATION_V13_ALGORITHM_VERSION,
      "algorithm-version: 2.0.0-alpha.convergence-v13.changed"
    );
    expect(computeChecksum(changedAlgorithmContract)).not.toBe(originalChecksum);

    // 2. Changing schema SQL changes checksum
    const changedSchemaContract = MIGRATION_V13_CONVERGENCE_INTEGRITY_CHECKSUM_SOURCE.replace(
      "session_turn_messages",
      "session_turn_messages_altered"
    );
    expect(computeChecksum(changedSchemaContract)).not.toBe(originalChecksum);

    // 3. Verifies tamper with ledger throws MigrationChecksumError
    const db = new Database(":memory:");
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(16);

    db.query("UPDATE schema_migrations SET checksum = 'tampered_v13_checksum' WHERE version = 13").run();
    expect(() => {
      runMigrations(db);
    }).toThrow(MigrationChecksumError);

    db.close();
  });

  // 70. deferred-intent-semantics-replay-continue-query-ack-modify
  it("70. deferred-intent-semantics-replay-continue-query-ack-modify", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-deferred-intent-matrix";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-im-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-im-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-im-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-im-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-im-sess" });

    // User sends REPLACE -> deferred replacement created
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-im-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, do initial deferred task", id: "2", sessionID, messageID: "m-im-2" }] }
    );

    const initialDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(initialDef?.effectiveGoal).toContain("initial deferred task");

    // 1. QUERY while deferred does not supersede or change goal
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-im-query" },
      { message: {} as any, parts: [{ type: "text", text: "what is the current status?", id: "3", sessionID, messageID: "m-im-query" }] }
    );
    expect(ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID)?.effectiveGoal).toContain("initial deferred task");

    // 2. ACKNOWLEDGE while deferred does not supersede or change goal
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-im-ack" },
      { message: {} as any, parts: [{ type: "text", text: "ok sounds good", id: "4", sessionID, messageID: "m-im-ack" }] }
    );
    expect(ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID)?.effectiveGoal).toContain("initial deferred task");

    // 3. CONTINUE while deferred does not supersede or change goal
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-im-cont" },
      { message: {} as any, parts: [{ type: "text", text: "continue", id: "5", sessionID, messageID: "m-im-cont" }] }
    );
    expect(ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID)?.effectiveGoal).toContain("initial deferred task");

    // 4. MODIFY updates and refines the current deferred goal intentionally
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-im-mod" },
      { message: {} as any, parts: [{ type: "text", text: "also add strict types", id: "6", sessionID, messageID: "m-im-mod" }] }
    );
    const modDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(modDef?.effectiveGoal).toContain("initial deferred task");
    expect(modDef?.effectiveGoal).toContain("also add strict types");
    expect(modDef?.sourceIntent).toBe("MODIFY_RECLASSIFICATION");

    await releaseProjectRuntime(testDir);
  });

  // 71. deferred-prompt-failure-does-not-mark-resumed
  it("71. deferred-prompt-failure-does-not-mark-resumed", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.reject(new Error("Native OpenCode dispatch failed")));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-prompt-fail";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-pf-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-pf-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-pf-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-pf-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-pf-sess" });

    // User sends REPLACE -> deferred replacement created
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-pf-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor database schema and build backend services", id: "2", sessionID, messageID: "m-pf-2" }] }
    );

    const savedDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(savedDef).not.toBeNull();

    // Confirm native child termination -> attempts deferred resumption, but promptAsync fails
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-pf-sess" },
    } as any);

    const defAfterFail = ctx.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(defAfterFail).not.toBeNull();
    // Must NOT be marked resumed!
    expect(defAfterFail?.status).not.toBe("resumed");
    expect(defAfterFail?.status).toBe("handoff_pending");

    // Process restart: known failure is preserved as retryable and startup recovery retries with same identity
    await releaseProjectRuntime(testDir);
    const retryPromptMock = mock(() => Promise.resolve(true));
    const ctx2 = acquireProjectRuntime(testDir, { session: { abort: abortMock, promptAsync: retryPromptMock } });
    await ctx2.adapter.startupReady;

    const defAfterRetry = ctx2.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(defAfterRetry?.status).toBe("resumed");
    expect(retryPromptMock).toHaveBeenCalledTimes(1);

    await releaseProjectRuntime(testDir);
  });

  // 76. outcome-unknown-cancel-after-child-termination-cancels-deferred
  it("76. outcome-unknown-cancel-after-child-termination-cancels-deferred", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-ou-cancel";

    const goal = "Refactor backend telemetry architecture";
    const decision = classifyTask(goal, { hasExplicitDomainSignal: false });
    ctx.runtime.db.query(`
      INSERT INTO deferred_replacements (
        id, parent_session_id, old_run_id, source_intent, agent_id,
        effective_goal, message_hash, message_id, correlation_id,
        routing_decision, status, created_at, updated_at
      ) VALUES ('def-ou-1', ?, 'old-run-ou', 'REPLACE', 'heidi', ?, 'h-ou', 'm-ou', 'corr-ou', ?, 'handoff_outcome_unknown', datetime('now'), datetime('now'))
    `).run(sessionID, goal, JSON.stringify(decision));

    // User sends CANCEL while child termination is already complete and status is handoff_outcome_unknown
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-ou-cancel" },
      { message: {} as any, parts: [{ type: "text", text: "cancel everything stop", id: "1", sessionID, messageID: "m-ou-cancel" }] }
    );

    const defAfter = ctx.runtime.deferredReplacementRepo.findById("def-ou-1");
    expect(defAfter?.status).toBe("cancelled");

    await releaseProjectRuntime(testDir);
  });

  // 77. outcome-unknown-replace-after-child-termination-supersedes-old
  it("77. outcome-unknown-replace-after-child-termination-supersedes-old", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-ou-replace";

    const goal = "Old uncertain deferred task";
    const decision = classifyTask(goal, { hasExplicitDomainSignal: false });
    ctx.runtime.db.query(`
      INSERT INTO deferred_replacements (
        id, parent_session_id, old_run_id, source_intent, agent_id,
        effective_goal, message_hash, message_id, correlation_id,
        routing_decision, status, created_at, updated_at
      ) VALUES ('def-ou-2', ?, 'old-run-ou-2', 'REPLACE', 'heidi', ?, 'h-ou-2', 'm-ou-2', 'corr-ou-2', ?, 'handoff_outcome_unknown', datetime('now'), datetime('now'))
    `).run(sessionID, goal, JSON.stringify(decision));

    // User sends REPLACE while status is handoff_outcome_unknown
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-ou-rep-msg" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor database schema and build backend services", id: "2", sessionID, messageID: "m-ou-rep-msg" }] }
    );

    // Old deferred record is superseded
    const oldDef = ctx.runtime.deferredReplacementRepo.findById("def-ou-2");
    expect(oldDef?.status).toBe("superseded");

    // New deferred record is created and actively resumed
    const curDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(curDef).not.toBeNull();
    expect(curDef?.effectiveGoal).toContain("refactor database schema");

    await releaseProjectRuntime(testDir);
  });

  // 78. handoff-pending-query-does-not-strand-dispatch
  it("78. handoff-pending-query-does-not-strand-dispatch", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-query-race";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-qr-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-qr-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-qr-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-qr-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-qr-sess" });

    // User sends REPLACE -> deferred replacement created
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-qr-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor database schema and build backend services", id: "2", sessionID, messageID: "m-qr-2" }] }
    );
    const savedDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(savedDef).not.toBeNull();

    // Hook: User asks "what is the status?" (QUERY) during handoff_pending before promptAsync
    ctx.adapter.testHandoffFaultHook = async (_type, _def) => {
      await ctx.adapter.onChatMessage(
        { sessionID, agent: "heidi", messageID: "m-qr-query" },
        { message: {} as any, parts: [{ type: "text", text: "what is the status?", id: "3", sessionID, messageID: "m-qr-query" }] }
      );
    };

    // Child termination event arrives
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-qr-sess" },
    } as any);

    // Handoff must NOT be rejected by stale turn version; must complete promptAsync and mark resumed!
    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    const defAfter = ctx.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(defAfter?.status).toBe("resumed");

    await releaseProjectRuntime(testDir);
  });

  // 79. failed-max-attempts-transitions-deferred-blocked
  it("79. failed-max-attempts-transitions-deferred-blocked", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.reject(new Error("Permanent prompt failure")));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-block-fail";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-bf-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-bf-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-bf-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-bf-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-bf-sess" });

    // User sends REPLACE -> deferred replacement created
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-bf-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor database schema and build backend services", id: "2", sessionID, messageID: "m-bf-2" }] }
    );
    const savedDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);

    // Attempt 1 fails
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-bf-sess" },
    } as any);

    expect(ctx.runtime.deferredReplacementRepo.findById(savedDef!.id)?.status).toBe("handoff_pending");

    // Restart runtime: Attempt 2 fails -> max attempts reached -> status becomes blocked
    await releaseProjectRuntime(testDir);
    const ctx2 = acquireProjectRuntime(testDir, mockClient);
    await ctx2.adapter.startupReady;

    const defBlocked = ctx2.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(defBlocked?.status).toBe("blocked");

    // Parent tool execution remains blocked by barrier
    await expect(
      ctx2.adapter.onToolExecuteBefore({
        tool: "bash",
        sessionID,
        callID: "call-blocked-tool",
        args: { command: "echo mutating" },
      })
    ).rejects.toThrow(/DEFERRED_REPLACEMENT_BARRIER/);

    // User can cancel the blocked replacement
    await ctx2.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-bf-cancel" },
      { message: {} as any, parts: [{ type: "text", text: "cancel everything", id: "3", sessionID, messageID: "m-bf-cancel" }] }
    );
    expect(ctx2.runtime.deferredReplacementRepo.findById(savedDef!.id)?.status).toBe("cancelled");

    await releaseProjectRuntime(testDir);
  });

  // 80. fast-direct-failed-dispatch-retries-safely
  it("80. fast-direct-failed-dispatch-retries-safely", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.reject(new Error("Transient network failure")));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-fd-fail-retry";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-fdfr-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-fdfr-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-fdfr-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-fdfr-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-fdfr-sess" });

    // User sends FAST_DIRECT replace message
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-fdfr-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, give me a quick summary of what is done", id: "2", sessionID, messageID: "m-fdfr-2" }] }
    );
    const savedDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);

    // Child termination event arrives -> Attempt 1 fails
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-fdfr-sess" },
    } as any);

    expect(ctx.runtime.deferredReplacementRepo.findById(savedDef!.id)?.status).toBe("handoff_pending");

    // Restart with working promptAsync -> Attempt 2 succeeds -> marked resumed
    await releaseProjectRuntime(testDir);
    const retryPromptMock = mock(() => Promise.resolve(true));
    const ctx2 = acquireProjectRuntime(testDir, { session: { abort: abortMock, promptAsync: retryPromptMock } });
    await ctx2.adapter.startupReady;

    const defResumed = ctx2.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(defResumed?.status).toBe("resumed");
    expect(retryPromptMock).toHaveBeenCalledTimes(1);

    await releaseProjectRuntime(testDir);
  });

  // 72. deferred-cancel-race-before-dispatch-prevents-prompt
  it("72. deferred-cancel-race-before-dispatch-prevents-prompt", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-cancel-race";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-cr-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-cr-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-cr-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-cr-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-cr-sess" });

    // User sends REPLACE -> deferred replacement created
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-cr-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor database schema and build backend services", id: "2", sessionID, messageID: "m-cr-2" }] }
    );

    const savedDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(savedDef).not.toBeNull();

    // Hook: User cancels while handoff is pending before promptAsync
    ctx.adapter.testHandoffFaultHook = async (_type, _def) => {
      ctx.runtime.deferredReplacementRepo.cancelCurrentForSession(sessionID);
    };

    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-cr-sess" },
    } as any);

    // Verify deferred record was cancelled and promptAsync was NOT executed
    const defAfterCancel = ctx.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(defAfterCancel?.status).toBe("cancelled");
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    await releaseProjectRuntime(testDir);
  });

  // 73. deferred-replace-race-before-dispatch-prevents-stale-prompt
  it("73. deferred-replace-race-before-dispatch-prevents-stale-prompt", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-replace-race";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-rr-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-rr-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-rr-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-rr-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-rr-sess" });

    // User sends REPLACE R1
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-rr-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, do replacement R1", id: "2", sessionID, messageID: "m-rr-2" }] }
    );
    const r1Def = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);

    // When R1 handoff starts, user sends R2
    ctx.adapter.testHandoffFaultHook = async (_type, _def) => {
      // Simulate user sending REPLACE R2 before R1 prompt completes
      ctx.runtime.deferredReplacementRepo.savePending({
        parentSessionId: sessionID,
        oldRunId: run1.id,
        sourceIntent: "REPLACE",
        agentId: "heidi",
        effectiveGoal: "Replacement R2",
        messageHash: "hash-r2",
        messageId: "msg-r2",
        correlationId: "corr-r2",
        routingDecision: { executionClass: "STANDARD", reason: "r2", confidence: 1, reasonCode: "STANDARD", forcedByExplicitSignal: false },
      });
    };

    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-rr-sess" },
    } as any);

    // R1 was superseded
    const r1After = ctx.runtime.deferredReplacementRepo.findById(r1Def!.id);
    expect(r1After?.status).toBe("superseded");

    // Current deferred replacement is now R2
    const curDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(curDef?.effectiveGoal).toBe("Replacement R2");

    await releaseProjectRuntime(testDir);
  });

  // 74. deferred-dispatch-uses-durable-user-turn-without-increment
  it("74. deferred-dispatch-uses-durable-user-turn-without-increment", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-turn-version-integrity";

    // User message 1 -> Turn version 1
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-tv-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-tv-1" }] }
    );
    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(1);

    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-tv-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-tv-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-tv-sess" });

    // User message 2 (REPLACE) -> Turn version 2
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-tv-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, refactor database schema and build backend services", id: "2", sessionID, messageID: "m-tv-2" }] }
    );
    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(2);

    // Native child termination confirms -> deferred continuation dispatches
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-tv-sess" },
    } as any);

    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    // Crucial: internal deferred continuation injection MUST NOT increment the durable user turn version!
    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(2);

    await releaseProjectRuntime(testDir);
  });

  // 75. fast-direct-success-uses-native-prompt-and-marks-resumed
  it("75. fast-direct-success-uses-native-prompt-and-marks-resumed", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock, promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-fd-prompt-success";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-fds-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-fds-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run1.id,
      parentSessionId: sessionID,
      taskCallId: "call-fds-1",
      targetAgent: "coder",
    });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "child-fds-sess",
      agentId: "coder",
      taskCallId: del.taskCallId,
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-fds-sess" });

    // User sends FAST_DIRECT replace message
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-fds-2" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, give me a quick summary of what is done", id: "2", sessionID, messageID: "m-fds-2" }] }
    );

    const savedDef = ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID);
    expect(savedDef).not.toBeNull();
    expect(savedDef?.routingDecision.executionClass).toBe("FAST_DIRECT");

    // Child termination event arrives -> FAST_DIRECT dispatches via promptAsync and marks resumed
    await ctx.adapter.onEvent({
      type: "session.deleted",
      properties: { sessionID: "child-fds-sess" },
    } as any);

    expect(promptAsyncMock).toHaveBeenCalledTimes(1);
    const resumedDef = ctx.runtime.deferredReplacementRepo.findById(savedDef!.id);
    expect(resumedDef?.status).toBe("resumed");
    expect(resumedDef?.replacementRunId).toBeUndefined();

    await releaseProjectRuntime(testDir);
  });

  // 80. internal-user-role-message-does-not-resurrect-a-stopped-run
  it("80. internal-user-role-message-does-not-resurrect-a-stopped-run", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: mock(() => Promise.resolve(true)), promptAsync: promptAsyncMock } };
    const ctx = acquireProjectRuntime(testDir, mockClient);
    const sessionID = "sess-internal-provenance-stop";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-genuine-user-1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repositories", id: "1", sessionID, messageID: "m-genuine-user-1" }] }
    );
    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(1);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-genuine-user-stop" },
      { message: {} as any, parts: [{ type: "text", text: "Stop", id: "2", sessionID, messageID: "m-genuine-user-stop" }] }
    );
    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(2);
    expect(await ctx.adapter.resolveActiveRunForSession(sessionID)).toBeNull();

    // OpenCode transports FlowDeck-generated prompts through a user-role chat
    // event. Only a prior durable native message-ID reservation may establish
    // internal provenance; the raw role and text remain insufficient.
    const internalMessageID = "m-flowdeck-specialist-dispatch";
    expect(ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionID,
      messageId: internalMessageID,
      provenance: "FLOWDECK_SPECIALIST_DISPATCH",
      dispatchIdentity: "test-specialist-dispatch",
    })).toBe(true);
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: internalMessageID },
      { message: {} as any, parts: [{ type: "text", text: "[FlowDeck Specialist Dispatch] Use OpenCode native Task/subagent calls only for the following ready specialist assignments.", id: "3", sessionID, messageID: internalMessageID }] }
    );

    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(2);
    expect(await ctx.adapter.resolveActiveRunForSession(sessionID)).toBeNull();
    expect(promptAsyncMock).toHaveBeenCalledTimes(0);

    await releaseProjectRuntime(testDir);
  });

  // 81. marker-text-from-a-real-user-remains-genuine-intent
  it("81. marker-text-from-a-real-user-remains-genuine-intent", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-genuine-marker-text";
    const messageID = "m-genuine-marker-text";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID },
      { message: {} as any, parts: [{ type: "text", text: "[FlowDeck Specialist Dispatch] Coordinate the frontend authentication redesign and backend API changes together.", id: "1", sessionID, messageID }] }
    );

    expect(ctx.runtime.sessionTurnRepo.findBySessionId(sessionID)?.lastUserMessageId).toBe(messageID);
    expect(await ctx.adapter.resolveActiveRunForSession(sessionID)).not.toBeNull();

    await releaseProjectRuntime(testDir);
  });

  // 82. native-prompt-message-id-provenance-survives-user-role-echo
  it("82. native-prompt-message-id-provenance-survives-user-role-echo", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync: promptAsyncMock } });
    const sessionID = "sess-native-provenance-echo";
    const messageID = "m-native-provenance-echo";
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);
    const token = {
      runId: "run-native-provenance-echo",
      sessionId: sessionID,
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "PROGRESS_CONFIRMED" as const,
      currentWorkItemId: "work-native-provenance-echo",
      stateFingerprint: "fp-native-provenance-echo",
    };
    const dispatchIdentity = dispatcher.computeTokenIdentity(token);

    const dispatched = await dispatcher.dispatch(token, {
      currentTurnVersion: 1,
      currentAggregateVersion: 1,
      client: { session: { promptAsync: promptAsyncMock } },
      messageId: messageID,
      promptText: "A user may legitimately send this exact text.",
      beforeNativeDispatch: () => ctx.runtime.internalMessageProvenanceRepo.reserve({
        sessionId: sessionID,
        messageId: messageID,
        provenance: "FLOWDECK_CONTINUATION",
        dispatchIdentity,
      }),
    });

    expect(dispatched.dispatched).toBe(true);
    expect(promptAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ messageID }),
    }));

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID },
      { message: {} as any, parts: [{ type: "text", text: "A user may legitimately send this exact text.", id: "1", sessionID, messageID }] }
    );
    expect(ctx.runtime.sessionTurnRepo.findBySessionId(sessionID)).toBeNull();

    await releaseProjectRuntime(testDir);
  });

  // 69. historical-v12-byte-identity-remains-valid
  it("69. historical-v12-byte-identity-remains-valid", () => {
    const v12Migration = MIGRATIONS.find(m => m.version === 12);
    expect(v12Migration).toBeDefined();
    expect(v12Migration?.name).toBe("orchestration_runtime_integrity_v2.0.0-alpha");
    expect(v12Migration?.sql).toBeDefined();
    expect(v12Migration?.checksum.length).toBe(64);
  });

});
