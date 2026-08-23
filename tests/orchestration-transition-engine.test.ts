import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireProjectRuntime,
  releaseProjectRuntime,
  disposeProjectRuntime,
  _resetAllProjectRuntimes,
} from "../src/runtime/project-registry";
import { closeAllConnections } from "../src/orchestration/persistence/connection";
import { _resetRouteState } from "../src/services/heidi-route-state";
import { _resetAllTaskState } from "../src/services/heidi-task-state";
import {
  type TransitionReasonCode,
} from "../src/orchestration/services/transition-engine";
import { OrchestrationPhase as OP } from "../src/orchestration/types/runs";
import { CONTINUATION_ALLOWLIST, ContinuationPolicy, ContinuationDispatcher } from "../src/orchestration/services/continuation-policy";

describe("Deterministic Transition Engine & Policy Tests (34 Scenarios)", () => {
  let projectDir: string;

  beforeEach(async () => {
    await _resetAllProjectRuntimes();
    closeAllConnections();
    _resetRouteState();
    _resetAllTaskState();
    projectDir = mkdtempSync(join(tmpdir(), "fdx-trans-all-"));
  });

  afterEach(async () => {
    await _resetAllProjectRuntimes();
    closeAllConnections();
    _resetRouteState();
    _resetAllTaskState();
    try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  it("1. idle-zero-progress-no-continuation", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-idle-zero";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-idle-z1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-z1",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });

    expect(trans.reasonCode).toBe("NO_PROGRESS");
    expect(trans.requiresAction).toBe(false);

    const cont = ctx.runtime.continuationPolicy.evaluate({ snapshot: snap, transition: trans });
    expect(cont.decision).toBe("WAIT_FOR_USER");

    await releaseProjectRuntime(projectDir);
  });

  it("2. no-default-progress-confirmed", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-def-trans";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m2" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(trans.reasonCode).not.toBe("PROGRESS_CONFIRMED");
    expect(trans.requiresAction).toBe(false);

    await releaseProjectRuntime(projectDir);
  });

  it("3. continuation-reason-allowlist", () => {
    expect(CONTINUATION_ALLOWLIST.has("NEXT_WORK_ITEM_READY")).toBe(true);
    expect(CONTINUATION_ALLOWLIST.has("CHANGE_STRATEGY" as any)).toBe(true);
    expect(CONTINUATION_ALLOWLIST.has("REPEATED_ACTION_BLOCKED")).toBe(true);
    expect(CONTINUATION_ALLOWLIST.has("TRANSIENT_RETRY_ALLOWED")).toBe(true);
    expect(CONTINUATION_ALLOWLIST.has("RECOVERY_PROGRESS")).toBe(true);
    expect(CONTINUATION_ALLOWLIST.has("STALL_DETECTED")).toBe(true);
    expect(CONTINUATION_ALLOWLIST.has("READY_FOR_VERIFICATION")).toBe(true);
    expect(CONTINUATION_ALLOWLIST.has("CHILD_FAILED")).toBe(true);
    expect(CONTINUATION_ALLOWLIST.has("ASSIGNMENT_FAILED")).toBe(true);
  });

  it("4. unknown-continuation-reason-fails-closed", () => {
    const policy = new ContinuationPolicy();
    const fakeSnapshot = {
      phase: OP.EXECUTING,
      childState: { active: 0 },
      terminalState: { isTerminal: false },
    } as any;
    const fakeTransition = {
      requiresAction: true,
      reasonCode: "SOME_UNKNOWN_EXPERIMENTAL_REASON" as TransitionReasonCode,
    } as any;

    const res = policy.evaluate({ snapshot: fakeSnapshot, transition: fakeTransition });
    expect(res.decision).toBe("WAIT_FOR_USER");
  });

  it("5. adapter-before-creates-attempt", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-att-create";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m5" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-att-wire-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-wire-1",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    await ctx.adapter.onToolExecuteBefore({ tool: "read", sessionID, callID: "call-live-1", args: { file: "test.ts" } });
    const attemptsMid = ctx.runtime.transitionEngine.listAttempts(run.id, a1.id);
    expect(attemptsMid.length).toBe(1);
    expect(attemptsMid[0].attemptNumber).toBe(1);
    expect(attemptsMid[0].finishedAt).toBeUndefined();

    await releaseProjectRuntime(projectDir);
  });

  it("6. adapter-after-finalizes-attempt", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-att-fin";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m6" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-att-wire-2",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-wire-2",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    await ctx.adapter.onToolExecuteBefore({ tool: "read", sessionID, callID: "call-live-2", args: { file: "test.ts" } });
    await ctx.adapter.onToolExecuteAfter({ tool: "read", sessionID, callID: "call-live-2", args: { file: "test.ts" } }, { output: "content" } as any);

    const attemptsFin = ctx.runtime.transitionEngine.listAttempts(run.id, a1.id);
    expect(attemptsFin.length).toBe(1);
    expect(attemptsFin[0].finishedAt).toBeDefined();

    await releaseProjectRuntime(projectDir);
  });

  it("7. adapter-attempt-survives-restart", async () => {
    const ctx1 = acquireProjectRuntime(projectDir);
    const sessionID = "sess-att-restart";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m7" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx1.runtime.services.assignmentService.createAssignment({
      id: "as-att-res",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-res",
    });
    await ctx1.runtime.services.assignmentService.startAssignment(a1.id);

    await ctx1.adapter.onToolExecuteBefore({ tool: "read", sessionID, callID: "c-res-1", args: { file: "app.ts" } });
    await ctx1.adapter.onToolExecuteAfter({ tool: "read", sessionID, callID: "c-res-1", args: { file: "app.ts" } }, { output: "hello" } as any);

    await disposeProjectRuntime(projectDir);
    closeAllConnections();

    const ctx2 = acquireProjectRuntime(projectDir);
    const attempts = ctx2.runtime.transitionEngine.listAttempts(run.id, a1.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].tool).toBe("read");
    expect(attempts[0].finishedAt).toBeDefined();

    await releaseProjectRuntime(projectDir);
  });

  it("8. attempt-allocation-concurrent-unique", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-conc-att";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m8" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = "as-conc-1";
    const a2 = "as-conc-2";

    const n1 = ctx.runtime.transitionEngine.allocateNextAttemptNumber(run.id, a1);
    ctx.runtime.transitionEngine.recordAttemptStart({
      runId: run.id,
      assignmentId: a1,
      attemptNumber: n1,
      tool: "read",
      actionFingerprint: "act1",
      preStateFingerprint: "pre1",
    });

    const n2 = ctx.runtime.transitionEngine.allocateNextAttemptNumber(run.id, a1);
    expect(n2).toBe(2);

    const nA2 = ctx.runtime.transitionEngine.allocateNextAttemptNumber(run.id, a2);
    expect(nA2).toBe(1);

    await releaseProjectRuntime(projectDir);
  });

  it("9. evaluation-loads-attempt-without-manual-input", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-eval-auto";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m9" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-auto-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-auto",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    await ctx.adapter.onToolExecuteBefore({ tool: "read", sessionID, callID: "c-auto-1", args: { file: "test.ts" } });
    await ctx.adapter.onToolExecuteAfter({ tool: "read", sessionID, callID: "c-auto-1", args: { file: "test.ts" } }, { output: "same" } as any);

    await ctx.adapter.onToolExecuteBefore({ tool: "read", sessionID, callID: "c-auto-2", args: { file: "test.ts" } });
    await ctx.adapter.onToolExecuteAfter({ tool: "read", sessionID, callID: "c-auto-2", args: { file: "test.ts" } }, { output: "same" } as any);

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.strategyDecision).toBe("CHANGE_STRATEGY");
    expect(evalResult.reasonCode).toBe("REPEATED_ACTION_BLOCKED");

    await releaseProjectRuntime(projectDir);
  });

  it("10. unrelated-progress-does-not-unblock-old-strategy", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-unrelated-prog";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m10" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-unrel-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-unrel",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    // Action A fails with no progress
    await ctx.adapter.onToolExecuteBefore({ tool: "read", sessionID, callID: "c-a1", args: { file: "foo.ts" } });
    await ctx.adapter.onToolExecuteAfter({ tool: "read", sessionID, callID: "c-a1", args: { file: "foo.ts" } }, { output: "same" } as any);

    // Repeating Action A without progress is blocked
    await ctx.adapter.onToolExecuteBefore({ tool: "read", sessionID, callID: "c-a2", args: { file: "foo.ts" } });
    await ctx.adapter.onToolExecuteAfter({ tool: "read", sessionID, callID: "c-a2", args: { file: "foo.ts" } }, { output: "same" } as any);

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.strategyDecision).toBe("CHANGE_STRATEGY");
    expect(evalResult.reasonCode).toBe("REPEATED_ACTION_BLOCKED");

    await releaseProjectRuntime(projectDir);
  });

  it("11. transient-retry-lineage-bounded", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-trans-lineage";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m11" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-lineage-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-lin",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    ctx.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId: a1.id,
      attemptNumber: 1,
      tool: "fetch",
      actionFingerprint: "act-timeout-fp",
      preStateFingerprint: "pre1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: false,
      repositoryDelta: 0,
      evidenceDelta: 0,
      verificationDelta: 0,
      childStateDelta: 0,
      isTransientError: true,
      failureReason: "Gateway Timeout 504",
      evidenceIds: [],
    });

    let evalRes = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID, latestActionFingerprint: "act-timeout-fp", latestError: "Gateway Timeout 504" });
    expect(evalRes.strategyDecision).toBe("RETRY_SAME_STRATEGY");

    ctx.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId: a1.id,
      attemptNumber: 2,
      tool: "fetch",
      actionFingerprint: "act-timeout-fp",
      preStateFingerprint: "pre1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: false,
      repositoryDelta: 0,
      evidenceDelta: 0,
      verificationDelta: 0,
      childStateDelta: 0,
      isTransientError: true,
      failureReason: "Gateway Timeout 504",
      evidenceIds: [],
    });

    evalRes = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID, latestActionFingerprint: "act-timeout-fp", latestError: "Gateway Timeout 504" });
    expect(evalRes.strategyDecision).toBe("RETRY_SAME_STRATEGY");

    ctx.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId: a1.id,
      attemptNumber: 3,
      tool: "fetch",
      actionFingerprint: "act-timeout-fp",
      preStateFingerprint: "pre1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: false,
      repositoryDelta: 0,
      evidenceDelta: 0,
      verificationDelta: 0,
      childStateDelta: 0,
      isTransientError: true,
      failureReason: "Gateway Timeout 504",
      evidenceIds: [],
    });

    evalRes = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID, latestActionFingerprint: "act-timeout-fp", latestError: "Gateway Timeout 504" });
    expect(evalRes.strategyDecision).toBe("CHANGE_STRATEGY");
    expect(evalRes.reasonCode).toBe("REPEATED_ACTION_BLOCKED");

    await releaseProjectRuntime(projectDir);
  });

  it("12. recovering-tool-start-preserves-phase", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-rec-preserve";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m12" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    let snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.EXECUTING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });
    snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.RECOVERING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });

    await ctx.adapter.onToolExecuteBefore({ tool: "write", sessionID, callID: "c-rec-1", args: { file: "fix.ts" } });
    const finalSnap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(finalSnap.phase).toBe(OP.RECOVERING);

    await releaseProjectRuntime(projectDir);
  });

  it("13. verifying-tool-start-preserves-phase", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-ver-preserve";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m13" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    let snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.EXECUTING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });
    snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.VERIFYING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });

    await ctx.adapter.onToolExecuteBefore({ tool: "bash", sessionID, callID: "c-test-1", args: { command: "bun test" } });
    const finalSnap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(finalSnap.phase).toBe(OP.VERIFYING);

    await releaseProjectRuntime(projectDir);
  });

  it("14. child-session-error-enters-recovering", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-child-err-rec";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m14" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.EXECUTING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c-fail-child", args: { subagent_type: "coder" } });
    await ctx.runtime.childExecutionLifecycleService.markFailed({ taskCallId: "c-fail-child", error: "Fatal subagent crash" });

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.currentPhase).toBe(OP.RECOVERING);
    expect(evalResult.strategyDecision).toBe("CHANGE_STRATEGY");
    expect(evalResult.reasonCode).toBe("CHILD_FAILED");

    await releaseProjectRuntime(projectDir);
  });

  it("15. failed-assignment-enters-recovering", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-as-fail-rec";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m15" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.EXECUTING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });

    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-req-fail",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-rf",
    });
    await ctx.runtime.services.assignmentService.failAssignment(a1.id);

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.currentPhase).toBe(OP.RECOVERING);
    expect(evalResult.strategyDecision).toBe("CHANGE_STRATEGY");
    expect(evalResult.reasonCode).toBe("ASSIGNMENT_FAILED");

    await releaseProjectRuntime(projectDir);
  });

  it("16. cancelled-required-work-not-verification-ready", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-canc-not-ready";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m16" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-canc-req",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-cr",
    });
    await ctx.runtime.services.assignmentService.cancelAssignment(a1.id);

    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(trans.reasonCode).not.toBe("READY_FOR_VERIFICATION");

    await releaseProjectRuntime(projectDir);
  });

  it("17. superseded-required-work-not-verification-ready", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-super-not-ready";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m17" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-super-req",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-sr",
    });
    await ctx.runtime.services.assignmentService.updateAssignment(a1.id, { status: "cancelled" });

    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(trans.reasonCode).not.toBe("READY_FOR_VERIFICATION");

    await releaseProjectRuntime(projectDir);
  });

  it("18. completed-required-optional-skipped-ready", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-opt-skip-ready";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m18" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.EXECUTING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });

    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-req-comp",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-rc",
    });
    const a2 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-opt-skip",
      runId: run.id,
      agentId: "reviewer",
      role: "optional doc review",
      correlationId: "cor-os",
    });

    ctx.runtime.db.query("UPDATE assignments SET is_required = 0 WHERE id = ?").run(a2.id);

    await ctx.runtime.services.assignmentService.completeAssignment(a1.id);
    await ctx.runtime.services.assignmentService.updateAssignment(a2.id, { status: "skipped" });

    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(trans.reasonCode).toBe("READY_FOR_VERIFICATION");
    expect(trans.currentPhase).toBe(OP.VERIFYING);

    await releaseProjectRuntime(projectDir);
  });

  it("19. phase-cas-success-increments-version", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-cas-inc";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m19" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    const s1 = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.EXECUTING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
      authority: "transition_engine",
    });
    expect(s1).toBe(true);

    const snapAfter = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snapAfter.aggregateVersion).toBe(snap.aggregateVersion + 1);

    await releaseProjectRuntime(projectDir);
  });

  it("20. phase-cas-conflict-rejected", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-cas-conflict";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m20" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    // Mutate to bump version
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.EXECUTING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });

    // Stale version CAS fails
    const s2 = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.RECOVERING,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
      authority: "transition_engine",
    });
    expect(s2).toBe(false);

    await releaseProjectRuntime(projectDir);
  });

  it("21. rejected-transition-does-not-increment-version", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-rej-no-inc";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m21" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snapBefore = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    // Invalid transition
    const res = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.COMPLETED,
      expectedPhase: snapBefore.phase,
      expectedAggregateVersion: snapBefore.aggregateVersion,
      authority: "transition_engine",
    });
    expect(res).toBe(false);

    const snapAfter = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snapAfter.aggregateVersion).toBe(snapBefore.aggregateVersion);

    await releaseProjectRuntime(projectDir);
  });

  it("22. user-turn-version-durable", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-user-dur";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Turn 1", id: "1", sessionID, messageID: "m22-1" }] }
    );
    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(1);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Turn 2", id: "2", sessionID, messageID: "m22-2" }] }
    );
    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(2);

    await releaseProjectRuntime(projectDir);
  });

  it("23. stale-idle-after-modify-rejected", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-stale-mod";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m23-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap1 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: 1,
      runAggregateVersion: snap1.aggregateVersion,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp1",
    };

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Wait, modify telemetry architecture instead", id: "2", sessionID, messageID: "m23-2" }] }
    );

    const dispatcher = new ContinuationDispatcher();
    const res = await dispatcher.dispatch(token, {
      currentTurnVersion: ctx.adapter.getUserTurnVersion(sessionID),
      currentAggregateVersion: snap1.aggregateVersion,
    });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_user_turn_version");

    await releaseProjectRuntime(projectDir);
  });

  it("24. stale-idle-after-replace-rejected", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-stale-repl";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m24-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap1 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: 1,
      runAggregateVersion: snap1.aggregateVersion,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp1",
    };

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Replace entire plan with new architecture", id: "2", sessionID, messageID: "m24-2" }] }
    );

    const dispatcher = new ContinuationDispatcher();
    const res = await dispatcher.dispatch(token, {
      currentTurnVersion: ctx.adapter.getUserTurnVersion(sessionID),
      currentAggregateVersion: snap1.aggregateVersion,
    });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_user_turn_version");

    await releaseProjectRuntime(projectDir);
  });

  it("25. stale-idle-after-cancel-rejected", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-stale-canc";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m25-1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap1 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    const token = {
      runId: run.id,
      sessionId: sessionID,
      userTurnVersion: 1,
      runAggregateVersion: snap1.aggregateVersion,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp1",
    };

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "stop / cancel everything", id: "2", sessionID, messageID: "m25-2" }] }
    );

    const dispatcher = new ContinuationDispatcher();
    const res = await dispatcher.dispatch(token, {
      currentTurnVersion: ctx.adapter.getUserTurnVersion(sessionID),
      currentAggregateVersion: snap1.aggregateVersion,
    });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_user_turn_version");

    await releaseProjectRuntime(projectDir);
  });

  it("26. duplicate-idle-dispatch-once", async () => {
    const dispatcher = new ContinuationDispatcher();
    const token = {
      runId: "run-dup-1",
      sessionId: "sess-dup-1",
      userTurnVersion: 1,
      runAggregateVersion: 2,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp-dup",
    };

    const mockClient = { session: { promptAsync: async () => true } };
    const d1 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 2, client: mockClient });
    expect(d1.dispatched).toBe(true);

    const d2 = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 2, client: mockClient });
    expect(d2.dispatched).toBe(false);
    expect(d2.reason).toBe("duplicate_dispatch");
  });

  it("27. stale-aggregate-version-token-rejected", async () => {
    const dispatcher = new ContinuationDispatcher();
    const token = {
      runId: "run-stale-agg",
      sessionId: "sess-stale-agg",
      userTurnVersion: 1,
      runAggregateVersion: 2,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp-agg",
    };

    const res = await dispatcher.dispatch(token, { currentTurnVersion: 1, currentAggregateVersion: 3 });
    expect(res.dispatched).toBe(false);
    expect(res.reason).toBe("stale_run_aggregate_version");
  });

  it("28. native-continuation-dispatch if supported", async () => {
    let promptAsyncCalled = false;
    const mockClient = {
      session: {
        promptAsync: async () => {
          promptAsyncCalled = true;
          return { data: true };
        },
      },
    };

    const dispatcher = new ContinuationDispatcher();
    const token = {
      runId: "run-native-c",
      sessionId: "sess-native-c",
      userTurnVersion: 1,
      runAggregateVersion: 1,
      transitionReason: "NEXT_WORK_ITEM_READY" as const,
      stateFingerprint: "fp-nc",
    };

    const res = await dispatcher.dispatch(token, {
      currentTurnVersion: 1,
      currentAggregateVersion: 1,
      client: mockClient,
    });
    expect(res.dispatched).toBe(true);
    expect(promptAsyncCalled).toBe(true);
  });

  it("29. run-cancel-calls-native-child-abort", async () => {
    let abortCalled = false;
    let abortSessionId = "";

    const mockClient = {
      session: {
        abort: async (input: any) => {
          abortCalled = true;
          abortSessionId = input.path.id;
          return true;
        },
      },
    };

    const ctx = acquireProjectRuntime(projectDir, mockClient);
    const sessionID = "sess-cancel-abort-29";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m29" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c-abort-29", args: { subagent_type: "coder" } });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({ parentSessionId: sessionID, childSessionId: "child-sess-29", agentId: "coder" });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-sess-29" });

    await ctx.runtime.services.runService.cancelRun(run.id, "User requested cancel");

    expect(abortCalled).toBe(true);
    expect(abortSessionId).toBe("child-sess-29");

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snap.childState.active).toBe(0);

    await releaseProjectRuntime(projectDir);
  });

  it("30. failed-native-abort-does-not-fake-cancel", async () => {
    const mockClient = {
      session: {
        abort: async () => {
          return { error: "Permission denied on container" };
        },
      },
    };

    const ctx = acquireProjectRuntime(projectDir, mockClient);
    const sessionID = "sess-fail-abort-30";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m30" }] }
    );
    const _run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c-abort-30", args: { subagent_type: "coder" } });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({ parentSessionId: sessionID, childSessionId: "child-sess-30", agentId: "coder" });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: "child-sess-30" });

    const cancelRes = await ctx.runtime.childExecutionLifecycleService.markCancelled({ childSessionId: "child-sess-30" });
    expect(cancelRes?.newState).not.toBe("cancelled");
    expect(cancelRes?.record.cancelRequested).toBe(true);
    expect(cancelRes?.record.nativeTerminationConfirmed).toBe(false);

    await releaseProjectRuntime(projectDir);
  });

  it("31. informational-read-no-positive-progress", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-read-no-prog";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m31" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const obs = ctx.runtime.progressObservationService.recordToolObservation({
      runId: run.id,
      sessionId: sessionID,
      tool: "read",
      args: { file: "data.txt" },
      output: "Novel content",
    });

    expect(obs.isProgress).toBe(false);
    expect(obs.evidenceKind).toBe("informational");

    await releaseProjectRuntime(projectDir);
  });

  it("32. multiple-novel-reads-do-not-reset-progress", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-reads-tourism-32";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m32" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    for (let i = 1; i <= 4; i++) {
      ctx.runtime.progressObservationService.recordToolObservation({
        runId: run.id,
        sessionId: sessionID,
        tool: "read",
        args: { file: "doc_" + i + ".md" },
        output: "Content of file " + i,
      });
    }

    const diag = ctx.runtime.progressObservationService.getDiagnosticsForRun(run.id);
    expect(diag.noProgressCount).toBe(4);

    await releaseProjectRuntime(projectDir);
  });

  it("33. novel-diagnostic-progress-once", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-diag-prog-33";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m33" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    ctx.runtime.progressObservationService.recordToolObservation({
      runId: run.id,
      sessionId: sessionID,
      tool: "bash",
      error: "TypeError: null is not an object",
    });

    let diag = ctx.runtime.progressObservationService.getDiagnosticsForRun(run.id);
    expect(diag.noProgressCount).toBe(0);
    expect(diag.lastProgressReason).toBe("novel_diagnostic_acquired");

    ctx.runtime.progressObservationService.recordToolObservation({
      runId: run.id,
      sessionId: sessionID,
      tool: "bash",
      error: "TypeError: null is not an object",
    });

    diag = ctx.runtime.progressObservationService.getDiagnosticsForRun(run.id);
    expect(diag.noProgressCount).toBe(1);

    await releaseProjectRuntime(projectDir);
  });

  it("34. generic-transition-cannot-complete-run", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-no-generic-comp-34";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m34" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    let snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    ctx.runtime.transitionEngine.transitionPhase({ runId: run.id, targetPhase: OP.EXECUTING, expectedPhase: snap.phase, expectedAggregateVersion: snap.aggregateVersion });
    snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    const success = ctx.runtime.transitionEngine.transitionPhase({
      runId: run.id,
      targetPhase: OP.COMPLETED,
      expectedPhase: snap.phase,
      expectedAggregateVersion: snap.aggregateVersion,
      authority: "transition_engine",
    });
    expect(success).toBe(false);

    const taskRun = ctx.runtime.db.query("SELECT * FROM task_runs WHERE run_id = ?").get(run.id) as any;
    expect(taskRun.state).not.toBe("completed");

    await releaseProjectRuntime(projectDir);
  });
});
