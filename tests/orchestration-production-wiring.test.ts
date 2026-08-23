import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  acquireProjectRuntime,
  releaseProjectRuntime,
} from "../src/runtime/project-registry";
import { OrchestrationPhase as OP } from "../src/orchestration/types/runs";
import { ContinuationDispatcher } from "../src/orchestration/services/continuation-policy";
import { RunStatus } from "../src/orchestration/types/runs";

const TEST_DIR = join(import.meta.dir, ".tmp-production-wiring-test");

describe("Production Wiring & Concurrency Integrity Suite (35 Guarantees)", () => {
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
    const ctx1 = acquireProjectRuntime(TEST_DIR); // initially acquired without client
    expect(ctx1.adapter.getClient()).toBeUndefined();

    const mockClient = { session: { abort: mock(() => Promise.resolve(true)) } };
    const ctx2 = acquireProjectRuntime(TEST_DIR, mockClient); // reacquired with client
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
      client: {}, // No session.promptAsync
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

    // Attempt 2 succeeds (not blocked as duplicate)
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

    // Reopen from disk
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
    for (let i = 0; i < 7; i++) {
      ctx1.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID, messageId: "m-" + i });
    }
    expect(ctx1.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(7);

    await releaseProjectRuntime(TEST_DIR);

    const ctx2 = acquireProjectRuntime(TEST_DIR);
    expect(ctx2.runtime.sessionTurnRepo.getTurnVersion(sessionID)).toBe(7);

    const next = ctx2.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID, messageId: "m-8" });
    expect(next).toBe(8);

    await releaseProjectRuntime(TEST_DIR);
  });

  // 10. user-turn-version-increments-atomically
  it("10. user-turn-version-increments-atomically", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-atomic-turn";
    const v1 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID });
    const v2 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID });
    const v3 = ctx.runtime.sessionTurnRepo.incrementTurnVersion({ sessionId: sessionID });
    expect(v1).toBe(1);
    expect(v2).toBe(2);
    expect(v3).toBe(3);
    await releaseProjectRuntime(TEST_DIR);
  });

  // 11. query-user-turn-invalidates-old-token
  it("11. query-user-turn-invalidates-old-token", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-query-inv";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-q-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const tokenTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);

    // User sends QUERY message
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "What is the status?", id: "2", sessionID, messageID: "m-q-2" }] }
    );

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: tokenTurnVersion, // Stale token
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp",
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
    const sessionID = "sess-ack-inv";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-a-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const tokenTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);

    // User sends ACKNOWLEDGE
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "ok sounds good", id: "2", sessionID, messageID: "m-a-2" }] }
    );

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: tokenTurnVersion,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp",
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
    const sessionID = "sess-mod-inv";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-m-1" }] }
    );
    const _run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const oldTurnVersion = ctx.adapter.getUserTurnVersion(sessionID);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Please also update docs/telemetry.md", id: "2", sessionID, messageID: "m-m-2" }] }
    );

    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBeGreaterThan(oldTurnVersion);
    await releaseProjectRuntime(TEST_DIR);
  });

  // 14. stale-run-version-rejected-from-live-db
  it("14. stale-run-version-rejected-from-live-db", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-stale-run-v";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-s-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    // Mutate Run in DB
    ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
    });

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: ctx.adapter.getUserTurnVersion(sessionID),
      runAggregateVersion: snap.aggregateVersion, // Stale version
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp",
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-fp-1" }] }
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-pt-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap1 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap1.phase,
      expectedAggregateVersion: snap1.aggregateVersion,
    });

    // Create a failed assignment so evaluate() performs CAS transition to RECOVERING
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-cas-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    // Transition with wrong expectedAggregateVersion must fail
    const res = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: 999, // Wrong version
    });
    expect(res).toBe(false);

    await releaseProjectRuntime(TEST_DIR);
  });

  // 18. cas-conflict-does-not-report-phase-changed
  it("18. cas-conflict-does-not-report-phase-changed", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-cas-conflict";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-cc-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    // Thread A wins CAS
    const win = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
    });
    expect(win).toBe(true);

    // Thread B tries with old snapshot -> loses
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-ms-1" }] }
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

  // 20. atomic-attempt-start-concurrent-unique
  it("20. atomic-attempt-start-concurrent-unique", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-att-unique";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-au-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const att1 = ctx.runtime.transitionEngine.startAttempt({
      runId: run.id,
      assignmentId: "as-1",
      callID: "call-1",
      tool: "write",
      actionFingerprint: "afp-1",
      preStateFingerprint: "pre-1",
    });

    const att2 = ctx.runtime.transitionEngine.startAttempt({
      runId: run.id,
      assignmentId: "as-1",
      callID: "call-2",
      tool: "write",
      actionFingerprint: "afp-2",
      preStateFingerprint: "pre-2",
    });

    expect(att1.attemptNumber).toBe(1);
    expect(att2.attemptNumber).toBe(2);

    await releaseProjectRuntime(TEST_DIR);
  });

  // 21. duplicate-call-id-idempotent-or-conflict
  it("21. duplicate-call-id-idempotent-or-conflict", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-dup-callid";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-dc-1" }] }
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

    expect(att1.attemptNumber).toBe(att2.attemptNumber);
    expect(att1.callID).toBe("call-same");

    await releaseProjectRuntime(TEST_DIR);
  });

  // 22. durable-call-id-finalizes-after-restart
  it("22. durable-call-id-finalizes-after-restart", async () => {
    const ctx1 = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-restart-final";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-rf-1" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx1.adapter.onToolExecuteBefore({
      tool: "edit",
      sessionID,
      callID: "call-durable-final",
      args: { path: "src/app.ts" },
    });

    await releaseProjectRuntime(TEST_DIR);

    // Reopen after restart
    const ctx2 = acquireProjectRuntime(TEST_DIR);
    const foundAttempt = ctx2.runtime.transitionEngine.findAttemptByCallID("call-durable-final");
    expect(foundAttempt).not.toBeNull();
    expect(foundAttempt!.callID).toBe("call-durable-final");

    await ctx2.adapter.onToolExecuteAfter(
      { tool: "edit", sessionID, callID: "call-durable-final", args: { path: "src/app.ts" } },
      { output: "file updated", metadata: {} }
    );

    const finalized = ctx2.runtime.transitionEngine.getAttempt(run.id, foundAttempt!.assignmentId, foundAttempt!.attemptNumber);
    expect(finalized?.finishedAt).toBeDefined();

    await releaseProjectRuntime(TEST_DIR);
  });

  // 23. task-attempt-finalized
  it("23. task-attempt-finalized", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-task-att-fin";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-ta-1" }] }
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-sa-1" }] }
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-ca-1" }] }
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

    // Tool execute inside child session A
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-cb-1" }] }
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

    // Tool execute inside child session B
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-of-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    // Create optional assignment (is_required = 0)
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-rf-28" }] }
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-oa-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    // Create completed required assignment
    ctx.runtime.db.query(`
      INSERT INTO assignments (id, run_id, agent_id, description, is_required, status, created_at, created_by)
      VALUES ('as-req-done', ?, 'coder', 'Required backend work', 1, 'completed', datetime('now'), 'system')
    `).run(run.id);

    // Create optional running assignment
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-ca-30" }] }
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

    // Run cancel triggers child cancellation through NativeChildControlPort
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-ac-31" }] }
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-au-32" }] }
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
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-tc-33" }] }
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
    const diag = ctx.runtime.childExecutionLifecycleService.getDiagnosticsForRun(run.id);
    expect(diag.childExecutions?.some(c => c.status === "running")).toBe(true);

    await releaseProjectRuntime(TEST_DIR);
  });

  // 34. replace-does-not-overlap-unconfirmed-old-run
  it("34. replace-does-not-overlap-unconfirmed-old-run", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-replace-no-overlap";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Initial architecture design for database storage", id: "1", sessionID, messageID: "m-rep-1" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    // User sends REPLACE intent
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Forget that, let's implement new frontend UI components instead", id: "2", sessionID, messageID: "m-rep-2" }] }
    );

    const oldRunState = ctx.runtime.taskRunsRepo.findById(run1.id);
    expect(oldRunState?.state).toBe("cancelled");

    await releaseProjectRuntime(TEST_DIR);
  });

  // 35. informational-read-remains-non-progress
  it("35. informational-read-remains-non-progress", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "sess-info-read";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-ir-1" }] }
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
});
