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
  isValidPhaseTransition,
  TERMINAL_PHASES,
} from "../src/orchestration/services/transition-engine";
import { OrchestrationPhase as OP } from "../src/orchestration/types/runs";
import { AssignmentStatus } from "../src/orchestration/types/assignments";

describe("Deterministic Transition Engine & Policy Tests (33 Scenarios)", () => {
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

  it("1. phase-transition-table-valid-cases", () => {
    expect(isValidPhaseTransition(OP.CREATED, OP.PLANNING)).toBe(true);
    expect(isValidPhaseTransition(OP.CREATED, OP.EXECUTING)).toBe(true);
    expect(isValidPhaseTransition(OP.PLANNING, OP.ANALYSING)).toBe(true);
    expect(isValidPhaseTransition(OP.PLANNING, OP.EXECUTING)).toBe(true);
    expect(isValidPhaseTransition(OP.ANALYSING, OP.DELEGATING)).toBe(true);
    expect(isValidPhaseTransition(OP.ANALYSING, OP.EXECUTING)).toBe(true);
    expect(isValidPhaseTransition(OP.DELEGATING, OP.EXECUTING)).toBe(true);
    expect(isValidPhaseTransition(OP.EXECUTING, OP.VERIFYING)).toBe(true);
    expect(isValidPhaseTransition(OP.EXECUTING, OP.RECOVERING)).toBe(true);
    expect(isValidPhaseTransition(OP.VERIFYING, OP.EXECUTING)).toBe(true);
    expect(isValidPhaseTransition(OP.VERIFYING, OP.RECOVERING)).toBe(true);
    expect(isValidPhaseTransition(OP.RECOVERING, OP.EXECUTING)).toBe(true);
    expect(isValidPhaseTransition(OP.EXECUTING, OP.COMPLETED)).toBe(true);
    expect(isValidPhaseTransition(OP.EXECUTING, OP.FAILED)).toBe(true);
    expect(isValidPhaseTransition(OP.EXECUTING, OP.CANCELLED)).toBe(true);
  });

  it("2. phase-transition-table-invalid-cases-fail-closed", () => {
    expect(isValidPhaseTransition(OP.CREATED, OP.VERIFYING)).toBe(false);
    expect(isValidPhaseTransition(OP.CREATED, OP.COMPLETED)).toBe(false);
    expect(isValidPhaseTransition(OP.PLANNING, OP.VERIFYING)).toBe(false);
    expect(isValidPhaseTransition(OP.DELEGATING, OP.VERIFYING)).toBe(false);
  });

  it("3. terminal-run-phase-immutable", () => {
    for (const term of Array.from(TERMINAL_PHASES)) {
      expect(isValidPhaseTransition(term, OP.EXECUTING)).toBe(false);
      expect(isValidPhaseTransition(term, OP.PLANNING)).toBe(false);
      expect(isValidPhaseTransition(term, OP.RECOVERING)).toBe(false);
      expect(isValidPhaseTransition(term, OP.VERIFYING)).toBe(false);
    }
  });

  it("4. completed-work-item-advances-current-item", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-adv-item";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-item-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-1",
    });
    const a2 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-item-2",
      runId: run.id,
      agentId: "reviewer",
      role: "review",
      correlationId: "cor-2",
    });

    await ctx.runtime.services.assignmentService.startAssignment(a1.id);
    let snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID);
    expect(snap?.currentWorkItemId).toBe(a1.id);

    await ctx.runtime.services.assignmentService.completeAssignment(a1.id);
    snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID);
    expect(snap?.currentWorkItemId).toBe(a2.id);

    await releaseProjectRuntime(projectDir);
  });

  it("5. no-progress-does-not-advance-work-item", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-no-adv";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m2" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-no-adv-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-3",
    });

    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    ctx.runtime.progressObservationService.recordToolObservation({
      runId: run.id,
      sessionId: sessionID,
      tool: "read",
      args: { file: "unrelated.txt" },
      output: "same",
    });

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID);
    expect(snap?.currentWorkItemId).toBe(a1.id);
    expect(snap?.workItems[0].status).toBe(AssignmentStatus.IN_PROGRESS);

    await releaseProjectRuntime(projectDir);
  });

  it("6. identical-action-same-state-prohibited", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-id-act";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m3" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-id-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-4",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    ctx.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId: a1.id,
      attemptNumber: 1,
      actionFingerprint: "act-same-fp",
      resultFingerprint: "res-same-fp",
      tool: "read",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: false,
      evidenceIds: [],
    });

    const evalResult = ctx.runtime.transitionEngine.evaluate({
      runId: run.id,
      sessionId: sessionID,
      latestActionFingerprint: "act-same-fp",
      latestResultFingerprint: "res-same-fp",
    });

    expect(evalResult.strategyDecision).toBe("CHANGE_STRATEGY");
    expect(evalResult.reasonCode).toBe("REPEATED_ACTION_BLOCKED");

    await releaseProjectRuntime(projectDir);
  });

  it("7. identical-action-after-state-change-allowed", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-state-change";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m4" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-change-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-5",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    ctx.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId: a1.id,
      attemptNumber: 1,
      actionFingerprint: "act-test-run",
      resultFingerprint: "res-test-fail-5",
      tool: "bash",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: false,
      evidenceIds: [],
    });

    // Record repository mutation state change
    ctx.runtime.progressObservationService.recordToolObservation({
      runId: run.id,
      sessionId: sessionID,
      tool: "write",
      args: { file: "test.ts" },
      preRepositoryHash: "hash-pre",
      postRepositoryHash: "hash-post",
    });

    const evalResult = ctx.runtime.transitionEngine.evaluate({
      runId: run.id,
      sessionId: sessionID,
      latestActionFingerprint: "act-test-run",
    });

    expect(evalResult.strategyDecision).toBe("EXECUTE_CURRENT");
    expect(evalResult.reasonCode).toBe("PROGRESS_CONFIRMED");

    await releaseProjectRuntime(projectDir);
  });

  it("8. transient-same-strategy-retry-bounded", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-trans-bound";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m5" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-trans-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-6",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    ctx.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId: a1.id,
      attemptNumber: 1,
      actionFingerprint: "act-timeout-fp",
      resultFingerprint: "res-timeout",
      tool: "bash",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: false,
      isTransientError: true,
      failureReason: "Gateway Timeout 504",
      evidenceIds: [],
    });

    const evalResult = ctx.runtime.transitionEngine.evaluate({
      runId: run.id,
      sessionId: sessionID,
      latestActionFingerprint: "act-timeout-fp",
      latestError: "Gateway Timeout 504",
    });

    expect(evalResult.strategyDecision).toBe("RETRY_SAME_STRATEGY");
    expect(evalResult.reasonCode).toBe("TRANSIENT_RETRY_ALLOWED");

    await releaseProjectRuntime(projectDir);
  });

  it("9. deterministic-failure-requires-strategy-change", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-det-fail";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m6" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-det-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-7",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);

    ctx.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId: a1.id,
      attemptNumber: 1,
      actionFingerprint: "act-compile-fp",
      resultFingerprint: "res-type-error",
      tool: "bash",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: false,
      failureReason: "TS2322: Type 'string' is not assignable to type 'number'",
      evidenceIds: [],
    });

    const evalResult = ctx.runtime.transitionEngine.evaluate({
      runId: run.id,
      sessionId: sessionID,
      latestActionFingerprint: "act-compile-fp",
      latestError: "TS2322: Type 'string' is not assignable to type 'number'",
    });

    expect(evalResult.strategyDecision).toBe("CHANGE_STRATEGY");
    expect(evalResult.reasonCode).toBe("REPEATED_ACTION_BLOCKED");

    await releaseProjectRuntime(projectDir);
  });

  it("10. stall-enters-recovering", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-stall-rec";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m7" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    for (let i = 0; i < 5; i++) {
      ctx.runtime.progressObservationService.recordToolObservation({
        runId: run.id,
        sessionId: sessionID,
        tool: "read",
        args: { file: "stall.ts" },
        output: "same output",
      });
    }

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.currentPhase).toBe(OP.RECOVERING);
    expect(evalResult.strategyDecision).toBe("CHANGE_STRATEGY");

    await releaseProjectRuntime(projectDir);
  });

  it("11. recovering-progress-returns-to-executing", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-rec-prog";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m8" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    ctx.runtime.transitionEngine.transitionPhase(run.id, OP.EXECUTING);
    ctx.runtime.transitionEngine.transitionPhase(run.id, OP.RECOVERING);

    ctx.runtime.progressObservationService.recordToolObservation({
      runId: run.id,
      sessionId: sessionID,
      tool: "write",
      args: { file: "repaired.ts" },
      preRepositoryHash: "v1",
      postRepositoryHash: "v2",
    });

    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(evalResult.currentPhase).toBe(OP.EXECUTING);
    expect(evalResult.reasonCode).toBe("RECOVERY_PROGRESS");

    await releaseProjectRuntime(projectDir);
  });

  it("12. recovery-blocker-stops-autonomous-loop", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-blocker";
    const evalResult = ctx.runtime.transitionEngine.evaluate({ runId: "non-existent-run" });

    expect(evalResult.strategyDecision).toBe("BLOCK");
    expect(evalResult.requiresAction).toBe(false);

    const cont = ctx.runtime.continuationPolicy.evaluate({
      snapshot: {
        runId: "non-existent-run",
        sessionId: sessionID,
        phase: OP.EXECUTING,
        workItems: [],
        progress: { noProgressCount: 0, stalled: false, stallReasons: [], lastEvidenceDelta: 0, lastRepositoryDelta: 0 },
        childState: { active: 0, completed: 0, failed: 0, cancelRequested: 0 },
      },
      transition: evalResult,
    });
    expect(cont.decision).toBe("STOP_BLOCKED");

    await releaseProjectRuntime(projectDir);
  });

  it("13. attempt-history-is-durable", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-att-dur";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-att-d" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const assignmentId = "as-att-dur";

    ctx.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId,
      attemptNumber: 1,
      actionFingerprint: "act-dur",
      resultFingerprint: "res-dur",
      tool: "write",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: true,
      evidenceIds: ["ev-1"],
    });

    const attempts = ctx.runtime.transitionEngine.listAttempts(run.id, assignmentId);
    expect(attempts.length).toBe(1);
    expect(attempts[0].evidenceIds).toEqual(["ev-1"]);

    await releaseProjectRuntime(projectDir);
  });

  it("14. attempt-number-survives-restart", async () => {
    const ctx1 = acquireProjectRuntime(projectDir);
    const sessionID = "sess-att-rst";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-att-rst" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;
    const assignmentId = "as-restart-att";

    ctx1.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId,
      attemptNumber: 3,
      actionFingerprint: "act-r3",
      resultFingerprint: "res-r3",
      tool: "edit",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: false,
      evidenceIds: [],
    });

    await disposeProjectRuntime(projectDir);
    closeAllConnections();
    _resetRouteState();

    const ctx2 = acquireProjectRuntime(projectDir);
    const attempts = ctx2.runtime.transitionEngine.listAttempts(run.id, assignmentId);
    expect(attempts.length).toBe(1);
    expect(attempts[0].attemptNumber).toBe(3);

    await releaseProjectRuntime(projectDir);
  });

  it("15. action/result-fingerprints-survive-restart", async () => {
    const ctx1 = acquireProjectRuntime(projectDir);
    const sessionID = "sess-fp-rst";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m-fp-rst" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;
    const assignmentId = "as-fp-restart";

    ctx1.runtime.transitionEngine.recordAttempt({
      runId: run.id,
      assignmentId,
      attemptNumber: 1,
      actionFingerprint: "fp-action-persistent",
      resultFingerprint: "fp-result-persistent",
      tool: "bash",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progressProduced: true,
      evidenceIds: ["ev-fp"],
    });

    await disposeProjectRuntime(projectDir);
    closeAllConnections();
    _resetRouteState();

    const ctx2 = acquireProjectRuntime(projectDir);
    const attempts = ctx2.runtime.transitionEngine.listAttempts(run.id, assignmentId);
    expect(attempts[0].actionFingerprint).toBe("fp-action-persistent");
    expect(attempts[0].resultFingerprint).toBe("fp-result-persistent");

    await releaseProjectRuntime(projectDir);
  });

  it("16. required-child-running-waits", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-child-wait";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m9" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "call-w1", args: { subagent_type: "backend-coder" } });

    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(trans.reasonCode).toBe("WAITING_FOR_CHILDREN");
    expect(trans.requiresAction).toBe(false);

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const cont = ctx.runtime.continuationPolicy.evaluate({ snapshot: snap, transition: trans });
    expect(cont.decision).toBe("WAIT_FOR_CHILD");

    await releaseProjectRuntime(projectDir);
  });

  it("17. parallel-partial-completion-waits", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-par-part";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m10" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c1", args: { subagent_type: "coder" } });
    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c2", args: { subagent_type: "reviewer" } });

    await ctx.adapter.onToolExecuteAfter({ tool: "task", sessionID, callID: "c1", args: {} }, { output: "c1 done", metadata: {} });

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snap.childState.active).toBe(1);
    expect(snap.childState.completed).toBe(1);

    const cont = ctx.runtime.continuationPolicy.evaluate({
      snapshot: snap,
      transition: ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID }),
    });
    expect(cont.decision).toBe("WAIT_FOR_CHILD");

    await releaseProjectRuntime(projectDir);
  });

  it("18. parallel-all-complete-advances", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-par-all";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m11" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c3", args: { subagent_type: "coder" } });
    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c4", args: { subagent_type: "reviewer" } });

    await ctx.adapter.onToolExecuteAfter({ tool: "task", sessionID, callID: "c3", args: {} }, { output: "c3 done", metadata: {} });
    await ctx.adapter.onToolExecuteAfter({ tool: "task", sessionID, callID: "c4", args: {} }, { output: "c4 done", metadata: {} });

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snap.childState.active).toBe(0);
    expect(snap.childState.completed).toBe(2);

    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(trans.reasonCode).toBe("READY_FOR_VERIFICATION");

    await releaseProjectRuntime(projectDir);
  });

  it("19. failed-child-enters-recovery", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-child-fail";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m12" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c-fail", args: { subagent_type: "coder" } });
    await ctx.runtime.childExecutionLifecycleService.markFailed({ taskCallId: "c-fail", error: "Child failed" });

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    expect(snap.childState.failed).toBe(1);

    await releaseProjectRuntime(projectDir);
  });

  it("20. duplicate-child-result-does-not-double-transition", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-dup-child";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m13" }] }
    );
    const _run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c-dup", args: { subagent_type: "coder" } });
    const trans1 = await ctx.runtime.childExecutionLifecycleService.markCompleted({ taskCallId: "c-dup", output: "done" });
    expect(trans1?.changed).toBe(true);

    const trans2 = await ctx.runtime.childExecutionLifecycleService.markCompleted({ taskCallId: "c-dup", output: "done again" });
    expect(trans2?.changed).toBe(false);

    await releaseProjectRuntime(projectDir);
  });

  it("21. query-does-not-mutate-workflow", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-query-truth";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m14" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap1 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "What is the status of the run?", id: "2", sessionID, messageID: "m15" }] }
    );
    const snap2 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID);

    expect(snap2?.phase).toBe(snap1?.phase);
    expect(snap2?.workItems.length).toBe(snap1?.workItems.length);

    await releaseProjectRuntime(projectDir);
  });

  it("22. acknowledge-does-not-mutate-workflow", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-ack-truth";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m16" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    const snap1 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "ok understood", id: "3", sessionID, messageID: "m17" }] }
    );
    const snap2 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID);

    expect(snap2?.phase).toBe(snap1?.phase);

    await releaseProjectRuntime(projectDir);
  });

  it("23. modify-invalidates-stale-work-state", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-mod-inval";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m18" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Instead of telemetry, create an end-to-end load test", id: "2", sessionID, messageID: "m19" }] }
    );

    const latestDecision = ctx.runtime.routingDecisionRepository.getLatestDecisionForRun(run.id);
    expect(latestDecision?.decisionVersion).toBeGreaterThan(1);

    await releaseProjectRuntime(projectDir);
  });

  it("24. replace-cancels-old-continuation", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-replace-cont";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m20" }] }
    );
    const run1 = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.runtime.services.runService.cancelRun(run1.id, "Replaced by user");
    const snap1 = ctx.runtime.orchestrationSnapshotService.getSnapshot(run1.id, sessionID)!;
    const trans1 = ctx.runtime.transitionEngine.evaluate({ runId: run1.id, sessionId: sessionID });

    const cont = ctx.runtime.continuationPolicy.evaluate({ snapshot: snap1, transition: trans1 });
    expect(cont.decision).toBe("STOP_TERMINAL");

    await releaseProjectRuntime(projectDir);
  });

  it("25. cancel-prevents-continuation", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-cancel-cont";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m21" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.runtime.services.runService.cancelRun(run.id, "User requested cancellation");
    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });

    const cont = ctx.runtime.continuationPolicy.evaluate({ snapshot: snap, transition: trans });
    expect(cont.decision).toBe("STOP_TERMINAL");

    await releaseProjectRuntime(projectDir);
  });

  it("26. idle-is-trigger-not-progress", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-idle-trig";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m22" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const diagBefore = ctx.runtime.progressObservationService.getDiagnosticsForRun(run.id);

    await ctx.adapter.onEvent({ type: "session.idle", properties: { sessionID } } as any);

    const diagAfter = ctx.runtime.progressObservationService.getDiagnosticsForRun(run.id);
    expect(diagAfter.noProgressCount).toBe(diagBefore.noProgressCount);

    await releaseProjectRuntime(projectDir);
  });

  it("27. idle-with-running-child-does-not-continue", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-idle-child";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m23" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.adapter.onToolExecuteBefore({ tool: "task", sessionID, callID: "c-run", args: { subagent_type: "coder" } });

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    const cont = ctx.runtime.continuationPolicy.evaluate({ snapshot: snap, transition: trans });

    expect(cont.decision).toBe("WAIT_FOR_CHILD");

    await releaseProjectRuntime(projectDir);
  });

  it("28. idle-with-valid-next-action-returns-continue-now", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-idle-next";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m24" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-idle-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-idle",
    });

    const snap = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    const cont = ctx.runtime.continuationPolicy.evaluate({ snapshot: snap, transition: trans });

    expect(cont.decision).toBe("CONTINUE_NOW");

    await releaseProjectRuntime(projectDir);
  });

  it("29. stale-idle-after-user-message-does-not-continue", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-stale-idle";
    const snap: any = {
      runId: "run-stale",
      sessionId: sessionID,
      phase: OP.EXECUTING,
      workItems: [],
      progress: { noProgressCount: 0, stalled: false, stallReasons: [], lastEvidenceDelta: 0, lastRepositoryDelta: 0 },
      childState: { active: 0, completed: 0, failed: 0, cancelRequested: 0 },
    };
    const trans: any = {
      runId: "run-stale",
      currentPhase: OP.EXECUTING,
      requiresAction: true,
      strategyDecision: "EXECUTE_CURRENT",
      reasonCode: "PROGRESS_CONFIRMED",
    };

    const cont = ctx.runtime.continuationPolicy.evaluate({
      snapshot: snap,
      transition: trans,
      isStaleEvent: true,
    });

    expect(cont.decision).toBe("STOP_TERMINAL");

    await releaseProjectRuntime(projectDir);
  });

  it("30. snapshot-cold-restart-equality", async () => {
    const ctx1 = acquireProjectRuntime(projectDir);
    const sessionID = "sess-snap-eq";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m25" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;

    await ctx1.runtime.services.assignmentService.createAssignment({
      id: "as-eq-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-eq",
    });

    const snap1 = ctx1.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    await disposeProjectRuntime(projectDir);
    closeAllConnections();
    _resetRouteState();

    const ctx2 = acquireProjectRuntime(projectDir);
    const snap2 = ctx2.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    expect(snap2.runId).toBe(snap1.runId);
    expect(snap2.phase).toBe(snap1.phase);
    expect(snap2.workItems.length).toBe(snap1.workItems.length);
    expect(snap2.workItems[0].id).toBe(snap1.workItems[0].id);

    await releaseProjectRuntime(projectDir);
  });

  it("31. recovering-state-cold-restart", async () => {
    const ctx1 = acquireProjectRuntime(projectDir);
    const sessionID = "sess-rec-cold";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m26" }] }
    );
    const run = (await ctx1.adapter.resolveActiveRunForSession(sessionID))!;
    ctx1.runtime.transitionEngine.transitionPhase(run.id, OP.EXECUTING);
    ctx1.runtime.transitionEngine.transitionPhase(run.id, OP.RECOVERING);

    await disposeProjectRuntime(projectDir);
    closeAllConnections();
    _resetRouteState();

    const ctx2 = acquireProjectRuntime(projectDir);
    const snap2 = ctx2.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;

    expect(snap2.phase).toBe(OP.RECOVERING);

    await releaseProjectRuntime(projectDir);
  });

  it("32. implementation-complete-returns-ready-for-verification", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-impl-comp";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m27" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-comp-1",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-comp",
    });
    await ctx.runtime.services.assignmentService.startAssignment(a1.id);
    await ctx.runtime.services.assignmentService.completeAssignment(a1.id);

    const trans = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(trans.reasonCode).toBe("READY_FOR_VERIFICATION");
    expect(trans.currentPhase).toBe(OP.VERIFYING);

    await releaseProjectRuntime(projectDir);
  });

  it("33. implementation-complete-does-not-complete-run", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-no-false-comp";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m28" }] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const a1 = await ctx.runtime.services.assignmentService.createAssignment({
      id: "as-comp-2",
      runId: run.id,
      agentId: "coder",
      role: "backend",
      correlationId: "cor-comp-2",
    });
    await ctx.runtime.services.assignmentService.completeAssignment(a1.id);

    ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });

    const taskRun = ctx.runtime.db.query("SELECT * FROM task_runs WHERE run_id = ?").get(run.id) as any;
    expect(taskRun.state).toBe("verifying");
    expect(taskRun.completed_at).toBeNull();

    await releaseProjectRuntime(projectDir);
  });
});
