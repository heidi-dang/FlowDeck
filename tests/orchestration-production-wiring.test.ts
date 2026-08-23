import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  acquireProjectRuntime,
  releaseProjectRuntime,
} from "../src/runtime/project-registry";
import { OrchestrationPhase as OP } from "../src/orchestration/types/runs";
import { ContinuationDispatcher, getContinuationPrompt } from "../src/orchestration/services/continuation-policy";
import { RunStatus } from "../src/orchestration/types/runs";
import { runMigrations, getCurrentVersion } from "../src/orchestration/persistence/migrations/migration-runner";

const TEST_DIR = join(import.meta.dir, ".tmp-production-wiring-test");

describe("Production Wiring & Concurrency Integrity Suite (Execution Integrity Guarantees)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await releaseProjectRuntime(TEST_DIR);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // 1. plugin-passes-opencode-client-to-runtime
  it("1. plugin-passes-opencode-client-to-runtime", async () => {
    const mockClient = { session: { abort: mock(() => Promise.resolve(true)), promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(TEST_DIR, mockClient);
    expect(ctx.adapter.getClient()).toBe(mockClient);
    await releaseProjectRuntime(TEST_DIR);
  });

  // 2. shared-runtime-preserves-valid-client
  it("2. shared-runtime-preserves-valid-client", async () => {
    const ctx1 = acquireProjectRuntime(TEST_DIR);
    expect(ctx1.adapter.getClient()).toBeUndefined();

    const mockClient = { session: { abort: mock(() => Promise.resolve(true)) } };
    const ctx2 = acquireProjectRuntime(TEST_DIR, mockClient);
    expect(ctx2).toBe(ctx1);
    expect(ctx2.adapter.getClient()).toBe(mockClient);

    await releaseProjectRuntime(TEST_DIR);
    await releaseProjectRuntime(TEST_DIR);
  });

  // 3. continuation-success-reports-dispatched
  it("3. continuation-success-reports-dispatched", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    await releaseProjectRuntime(TEST_DIR);
  });

  // 4. continuation-unavailable-reports-not-dispatched
  it("4. continuation-unavailable-reports-not-dispatched", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    await releaseProjectRuntime(TEST_DIR);
  });

  // 5. continuation-error-reports-not-dispatched
  it("5. continuation-error-reports-not-dispatched", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    await releaseProjectRuntime(TEST_DIR);
  });

  // 6. failed-dispatch-does-not-consume-success-dedupe
  it("6. failed-dispatch-does-not-consume-success-dedupe", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    await releaseProjectRuntime(TEST_DIR);
  });

  // 7. successful-dispatch-dedupes
  it("7. successful-dispatch-dedupes", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    await releaseProjectRuntime(TEST_DIR);
  });

  // 8. dispatch-dedupe-survives-restart
  it("8. dispatch-dedupe-survives-restart", async () => {
    const ctx1 = acquireProjectRuntime(TEST_DIR);
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
    await releaseProjectRuntime(TEST_DIR);

    const ctx2 = acquireProjectRuntime(TEST_DIR);
    const dispatcher2 = new ContinuationDispatcher(ctx2.runtime.db);

    const res2 = await dispatcher2.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 1, client: mockClient });
    expect(res2.dispatched).toBe(false);
    expect(res2.reason).toBe("duplicate_dispatch");

    await releaseProjectRuntime(TEST_DIR);
  });

  // 9. user-turn-version-survives-restart
  it("9. user-turn-version-survives-restart", async () => {
    const ctx1 = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);

    const ctx2 = acquireProjectRuntime(TEST_DIR);
    expect(ctx2.adapter.getUserTurnVersion(sessionID)).toBe(2);
    await releaseProjectRuntime(TEST_DIR);
  });

  // 10. user-turn-version-increments-atomically
  it("10. user-turn-version-increments-atomically", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-turn-atomic";

    const v1 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID, messageId: "m1" });
    const v2 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID, messageId: "m2" });
    const v3 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID, messageId: "m3" });

    expect(v1).toBe(1);
    expect(v2).toBe(2);
    expect(v3).toBe(3);
    await releaseProjectRuntime(TEST_DIR);
  });

  // 11. query-user-turn-invalidates-old-token
  it("11. query-user-turn-invalidates-old-token", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 12. acknowledge-user-turn-invalidates-old-token
  it("12. acknowledge-user-turn-invalidates-old-token", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 13. modify-user-turn-invalidates-old-token
  it("13. modify-user-turn-invalidates-old-token", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 14. stale-run-version-rejected-from-live-db
  it("14. stale-run-version-rejected-from-live-db", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 15. stale-state-fingerprint-rejected
  it("15. stale-state-fingerprint-rejected", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 16. token-uses-post-transition-snapshot
  it("16. token-uses-post-transition-snapshot", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 17. all-transition-engine-phase-writes-use-cas
  it("17. all-transition-engine-phase-writes-use-cas", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 18. cas-conflict-does-not-report-phase-changed
  it("18. cas-conflict-does-not-report-phase-changed", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 19. multi-step-phase-evaluation-does-not-reuse-stale-version
  it("19. multi-step-phase-evaluation-does-not-reuse-stale-version", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 20. real-concurrent-attempt-reservation-unique
  it("20. real-concurrent-attempt-reservation-unique", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 21. duplicate-call-id-idempotent-or-conflict
  it("21. duplicate-call-id-idempotent-or-conflict", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 22. durable-call-id-finalizes-after-restart
  it("22. durable-call-id-finalizes-after-restart", async () => {
    const ctx1 = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);

    const ctx2 = acquireProjectRuntime(TEST_DIR);
    await ctx2.adapter.onToolExecuteAfter(
      { tool: "write", sessionID, callID: "call-restart-1", args: { path: "src/app.ts" } },
      { output: "written", metadata: {} }
    );

    const attempt = ctx2.runtime.transitionEngine.findAttemptByCallID("call-restart-1");
    expect(attempt).not.toBeNull();
    expect(attempt?.finishedAt).toBeDefined();

    await releaseProjectRuntime(TEST_DIR);
  });

  // 23. task-attempt-finalized
  it("23. task-attempt-finalized", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 24. subagent-attempt-finalized
  it("24. subagent-attempt-finalized", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 25. child-a-tool-attributed-to-assignment-a
  it("25. child-a-tool-attributed-to-assignment-a", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 26. child-b-tool-attributed-to-assignment-b
  it("26. child-b-tool-attributed-to-assignment-b", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 27. optional-child-failure-does-not-force-recovery
  it("27. optional-child-failure-does-not-force-recovery", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 28. required-child-failure-enters-recovery
  it("28. required-child-failure-enters-recovery", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 29. optional-active-child-policy
  it("29. optional-active-child-policy", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 30. production-run-cancel-invokes-native-abort
  it("30. production-run-cancel-invokes-native-abort", async () => {
    const abortMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(TEST_DIR, mockClient);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 31. native-abort-success-confirms-child-cancel
  it("31. native-abort-success-confirms-child-cancel", async () => {
    const abortMock = mock(() => Promise.resolve(true));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(TEST_DIR, mockClient);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 32. native-abort-failure-keeps-cancel-unconfirmed
  it("32. native-abort-failure-keeps-cancel-unconfirmed", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(TEST_DIR, mockClient);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 33. parent-cancel-status-truthful-with-unconfirmed-child
  it("33. parent-cancel-status-truthful-with-unconfirmed-child", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Abort timeout")));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(TEST_DIR, mockClient);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 34. replace-does-not-overlap-unconfirmed-old-run
  it("34. replace-does-not-overlap-unconfirmed-old-run", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(TEST_DIR, mockClient);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 35. informational-read-remains-non-progress
  it("35. informational-read-remains-non-progress", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 36. stall-production-idle-persists-last-attempt-constraint-and-blocks
  it("36. stall-production-idle-persists-last-attempt-constraint-and-blocks", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-stall-prod";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 37. root-strategy-set-blocks-a-b-a-loop
  it("37. root-strategy-set-blocks-a-b-a-loop", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-aba-root";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const afpA = ctx.runtime.progressObservationService.computeActionFingerprint({ tool: "read", args: { path: "a.json" }, sessionID });
    const afpB = ctx.runtime.progressObservationService.computeActionFingerprint({ tool: "grep", args: { pattern: "b" }, sessionID });

    // State S
    const stateFp = "0:0:0:0";

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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 38. assignment-strategy-set-blocks-a-b-a-loop
  it("38. assignment-strategy-set-blocks-a-b-a-loop", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    const snapChild = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, "session-child-aba")!;
    const preFpChild = `${snapChild.progress.lastRepositoryDelta}:${snapChild.childState.activeRequired}:${snapChild.childState.failedRequired}:${snapChild.workItems.filter(w => w.isSatisfied).length}`;

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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 39. strategy-set-survives-restart
  it("39. strategy-set-survives-restart", async () => {
    const ctx1 = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-set-restart";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m1" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    const afpA = ctx1.runtime.progressObservationService.computeActionFingerprint({ tool: "read", args: { path: "a.json" }, sessionID });
    const afpB = ctx1.runtime.progressObservationService.computeActionFingerprint({ tool: "read", args: { path: "b.json" }, sessionID });

    ctx1.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "root:" + run.id,
      prohibitedActionFingerprint: afpA,
      stateFingerprint: "0:0:0:0",
      reason: "REPEATED_ACTION_BLOCKED",
    });
    ctx1.runtime.transitionEngine.saveStrategyConstraint({
      runId: run.id,
      assignmentId: "root:" + run.id,
      prohibitedActionFingerprint: afpB,
      stateFingerprint: "0:0:0:0",
      reason: "REPEATED_ACTION_BLOCKED",
    });

    await releaseProjectRuntime(TEST_DIR);

    const ctx2 = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
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
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 42. failed-continuation-retry-bounded
  it("42. failed-continuation-retry-bounded", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 43. out-of-order-duplicate-message-id-does-not-increment
  it("43. out-of-order-duplicate-message-id-does-not-increment", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    expect(v1Late).toBe(1); // Returns associated version without incrementing

    // Inspect current turn
    expect(ctx.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(2);

    await releaseProjectRuntime(TEST_DIR);
  });

  // 44. identical-text-different-message-id-increments-turn
  it("44. identical-text-different-message-id-increments-turn", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 45. migration-v12-upgrades-real-e816-continuation-schema-and-preserves-rows
  it("45. migration-v12-upgrades-real-e816-continuation-schema-and-preserves-rows", async () => {
    const db = new Database(":memory:");

    // 1. Run migrations up to v11
    runMigrations(db);

    // 2. Simulate legacy continuation_dispatches table without new columns
    db.exec(`
      DROP TABLE IF EXISTS continuation_dispatches;
      CREATE TABLE continuation_dispatches (
        identity TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_turn_version INTEGER NOT NULL,
        run_aggregate_version INTEGER NOT NULL,
        transition_reason TEXT NOT NULL,
        current_work_item_id TEXT,
        state_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        error TEXT
      );
      INSERT INTO continuation_dispatches VALUES
        ('id-old-1', 'run-1', 'sess-1', 1, 1, 'NEXT_WORK_ITEM_READY', 'as-1', 'fp-1', 'dispatched', '2026-08-20T10:00:00Z', '2026-08-20T10:00:01Z', NULL),
        ('id-old-2', 'run-1', 'sess-1', 1, 1, 'TRANSIENT_RETRY_ALLOWED', 'as-1', 'fp-2', 'failed', '2026-08-20T10:05:00Z', NULL, 'timeout');
    `);

    // Reset schema_migrations to version 11 to simulate real database upgrade to V12
    db.query("DELETE FROM schema_migrations WHERE version = 12").run();

    // 3. Apply migration to V12
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(12);

    // 4. Assert new columns exist in table_info
    const cols = db.query("PRAGMA table_info(continuation_dispatches)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain("attempt_count");
    expect(colNames).toContain("last_attempt_at");

    // 5. Assert old rows survived and backfilled
    const rows = db.query("SELECT * FROM continuation_dispatches ORDER BY identity ASC").all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].identity).toBe("id-old-1");
    expect(rows[0].attempt_count).toBe(1);
    expect(rows[0].last_attempt_at).toBe("2026-08-20T10:00:00Z");
    expect(rows[0].status).toBe("dispatched");

    expect(rows[1].identity).toBe("id-old-2");
    expect(rows[1].attempt_count).toBe(1);
    expect(rows[1].status).toBe("failed");

    // 6. Prove ContinuationDispatcher can operate seamlessly on migrated DB
    const dispatcher = new ContinuationDispatcher(db);
    const retryRes = await dispatcher.dispatch({
      runId: "run-1",
      sessionId: "sess-1",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "TRANSIENT_RETRY_ALLOWED",
      currentWorkItemId: "as-1",
      stateFingerprint: "fp-2",
    }, {
      currentTurnVersion: 1,
      currentAggregateVersion: 1,
      client: { session: { promptAsync: mock(() => Promise.resolve(true)) } },
    });

    expect(retryRes.dispatched).toBe(true);

    db.close();
  });

  // 46. pending-dispatch-restart-becomes-outcome-unknown
  it("46. pending-dispatch-restart-becomes-outcome-unknown", async () => {
    const ctx1 = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);

    // Reopen project runtime: startup reconciliation marks pending -> outcome_unknown
    const ctx2 = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 47. session-deleted-confirms-cancellation-and-resumes-deferred-replace
  it("47. session-deleted-confirms-cancellation-and-resumes-deferred-replace", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Native process stuck")));
    const mockClient = { session: { abort: abortMock, promptAsync: mock(() => Promise.resolve(true)) } };
    const ctx = acquireProjectRuntime(TEST_DIR, mockClient);
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

    // Assignment is cancelled
    const asRec = await ctx.runtime.services.assignmentService.getAssignment(del.assignmentId);
    expect(asRec?.status).toBe("cancelled");

    // Deferred replacement resumed and new run is active!
    const activeNewRun = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(activeNewRun).not.toBeNull();
    expect(activeNewRun?.id).not.toBe(run1.id);

    await releaseProjectRuntime(TEST_DIR);
  });

  // 48. modify-reclassification-uses-shared-cancellation-barrier
  it("48. modify-reclassification-uses-shared-cancellation-barrier", async () => {
    const abortMock = mock(() => Promise.reject(new Error("Process stuck")));
    const mockClient = { session: { abort: abortMock } };
    const ctx = acquireProjectRuntime(TEST_DIR, mockClient);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 49. session-deleted-does-not-cancel-completed-child
  it("49. session-deleted-does-not-cancel-completed-child", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
  });

  // 50. root-old-progress-consumed-once
  it("50. root-old-progress-consumed-once", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src/fix.ts"), "export const x = 1;");
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

    await releaseProjectRuntime(TEST_DIR);
  });
});
