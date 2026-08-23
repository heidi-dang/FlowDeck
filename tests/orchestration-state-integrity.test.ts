import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
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
import { getSessionMetricsDiagnostics } from "../src/index";
import {
  extractMutationTargets,
  getMutationTargetFingerprint,
} from "../src/runtime/mutation-observation-adapter";

describe("Orchestration State Integrity & Deterministic Progress Tests", () => {
  let projectDir: string;

  beforeEach(async () => {
    await _resetAllProjectRuntimes();
    closeAllConnections();
    _resetRouteState();
    _resetAllTaskState();
    projectDir = mkdtempSync(join(tmpdir(), "fdx-integrity-"));
  });

  afterEach(async () => {
    await _resetAllProjectRuntimes();
    closeAllConnections();
    _resetRouteState();
    _resetAllTaskState();
    try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  it("1. completed-terminal-is-immutable: late events cannot regress completed child", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-term-comp";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m1" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(run).not.toBeNull();

    await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run!.id,
      parentSessionId: sessionID,
      taskCallId: "call-c1",
      targetAgent: "reviewer",
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ taskCallId: "call-c1" });
    const compRes = await ctx.runtime.childExecutionLifecycleService.markCompleted({
      taskCallId: "call-c1",
      output: "Initial output",
    });
    expect(compRes?.changed).toBe(true);
    expect(compRes?.record.status).toBe("completed");

    // Attempt invalid late transitions
    const lateFail = await ctx.runtime.childExecutionLifecycleService.markFailed({
      taskCallId: "call-c1",
      error: "Late network error",
    });
    expect(lateFail?.changed).toBe(false);
    expect(lateFail?.record.status).toBe("completed");
    expect(lateFail?.record.result).toBe("Initial output");

    const lateCancel = await ctx.runtime.childExecutionLifecycleService.markCancelled({
      taskCallId: "call-c1",
      reason: "Late cancel",
    });
    expect(lateCancel?.changed).toBe(false);
    expect(lateCancel?.record.status).toBe("completed");

    const lateTimeout = await ctx.runtime.childExecutionLifecycleService.markTimedOut({
      taskCallId: "call-c1",
    });
    expect(lateTimeout?.changed).toBe(false);
    expect(lateTimeout?.record.status).toBe("completed");

    await releaseProjectRuntime(projectDir);
  });

  it("2. failed-terminal-is-immutable: late events cannot change failed child state", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-term-fail";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m2" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(run).not.toBeNull();

    await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run!.id,
      parentSessionId: sessionID,
      taskCallId: "call-f1",
      targetAgent: "reviewer",
    });

    await ctx.runtime.childExecutionLifecycleService.markStarted({ taskCallId: "call-f1" });
    const failRes = await ctx.runtime.childExecutionLifecycleService.markFailed({
      taskCallId: "call-f1",
      error: "Build failure",
    });
    expect(failRes?.changed).toBe(true);
    expect(failRes?.record.status).toBe("failed");

    const lateComp = await ctx.runtime.childExecutionLifecycleService.markCompleted({
      taskCallId: "call-f1",
      output: "Late output",
    });
    expect(lateComp?.changed).toBe(false);
    expect(lateComp?.record.status).toBe("failed");

    const lateCancel = await ctx.runtime.childExecutionLifecycleService.markCancelled({
      taskCallId: "call-f1",
      reason: "Late cancel",
    });
    expect(lateCancel?.changed).toBe(false);
    expect(lateCancel?.record.status).toBe("failed");

    await releaseProjectRuntime(projectDir);
  });

  it("3. cancelled-terminal-is-immutable: late events cannot change cancelled child state", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-term-canc";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m3" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(run).not.toBeNull();

    await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run!.id,
      parentSessionId: sessionID,
      taskCallId: "call-canc-1",
      targetAgent: "reviewer",
    });

    const cancRes = await ctx.runtime.childExecutionLifecycleService.markCancelled({
      taskCallId: "call-canc-1",
      confirmed: true,
      reason: "User cancelled",
    });
    expect(cancRes?.changed).toBe(true);
    expect(cancRes?.record.status).toBe("cancelled");

    const lateComp = await ctx.runtime.childExecutionLifecycleService.markCompleted({
      taskCallId: "call-canc-1",
      output: "Late output",
    });
    expect(lateComp?.changed).toBe(false);
    expect(lateComp?.record.status).toBe("cancelled");

    const lateFail = await ctx.runtime.childExecutionLifecycleService.markFailed({
      taskCallId: "call-canc-1",
      error: "Late fail",
    });
    expect(lateFail?.changed).toBe(false);
    expect(lateFail?.record.status).toBe("cancelled");

    await releaseProjectRuntime(projectDir);
  });

  it("4. timed-out-terminal-is-immutable: late events cannot change timed_out child state", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-term-to";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m4" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(run).not.toBeNull();

    await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run!.id,
      parentSessionId: sessionID,
      taskCallId: "call-to-1",
      targetAgent: "reviewer",
    });

    const toRes = await ctx.runtime.childExecutionLifecycleService.markTimedOut({
      taskCallId: "call-to-1",
    });
    expect(toRes?.changed).toBe(true);
    expect(toRes?.record.status).toBe("timed_out");

    const lateComp = await ctx.runtime.childExecutionLifecycleService.markCompleted({
      taskCallId: "call-to-1",
      output: "Late output",
    });
    expect(lateComp?.changed).toBe(false);
    expect(lateComp?.record.status).toBe("timed_out");

    const lateFail = await ctx.runtime.childExecutionLifecycleService.markFailed({
      taskCallId: "call-to-1",
      error: "Late error",
    });
    expect(lateFail?.changed).toBe(false);
    expect(lateFail?.record.status).toBe("timed_out");

    await releaseProjectRuntime(projectDir);
  });

  it("5. duplicate-terminal-transition-is-idempotent: replaying same terminal event returns changed=false", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-term-idemp";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m5" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(run).not.toBeNull();

    await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run!.id,
      parentSessionId: sessionID,
      taskCallId: "call-idemp",
      targetAgent: "reviewer",
    });

    const res1 = await ctx.runtime.childExecutionLifecycleService.markCompleted({
      taskCallId: "call-idemp",
      output: "Result A",
    });
    expect(res1?.changed).toBe(true);

    const res2 = await ctx.runtime.childExecutionLifecycleService.markCompleted({
      taskCallId: "call-idemp",
      output: "Result A",
    });
    expect(res2?.changed).toBe(false);
    expect(res2?.record.status).toBe("completed");

    await releaseProjectRuntime(projectDir);
  });

  it("6. parent-cancel-requests-native-child-stop & unconfirmed does not mark cancelled", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-unconfirmed-canc";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m6" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    expect(run).not.toBeNull();

    await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run!.id,
      parentSessionId: sessionID,
      taskCallId: "call-running-1",
      targetAgent: "backend-coder",
    });

    // Start child -> running
    await ctx.runtime.childExecutionLifecycleService.markStarted({ taskCallId: "call-running-1" });

    // Request cancellation WITHOUT confirmation
    const cancelRes = await ctx.runtime.childExecutionLifecycleService.markCancelled({
      taskCallId: "call-running-1",
      confirmed: false,
      reason: "User requested abort",
    });

    expect(cancelRes?.changed).toBe(true);
    expect(cancelRes?.record.status).toBe("running"); // Running state preserved truthfully
    expect(cancelRes?.record.cancelRequested).toBe(true);
    expect(cancelRes?.record.nativeTerminationConfirmed).toBe(false);

    // Native stop is confirmed later
    const confirmedRes = await ctx.runtime.childExecutionLifecycleService.confirmNativeTermination({
      taskCallId: "call-running-1",
      reason: "Native process confirmed exited",
    });

    expect(confirmedRes?.changed).toBe(true);
    expect(confirmedRes?.record.status).toBe("cancelled");
    expect(confirmedRes?.record.nativeTerminationConfirmed).toBe(true);

    await releaseProjectRuntime(projectDir);
  });

  it("7. cancel-request-state-survives-restart: restores cancelRequested and does not upgrade to cancelled automatically", async () => {
    const ctx1 = acquireProjectRuntime(projectDir);
    const sessionID = "sess-restart-canc";
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m7" }] }
    );
    const run = await ctx1.adapter.resolveActiveRunForSession(sessionID);
    expect(run).not.toBeNull();

    await ctx1.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run!.id,
      parentSessionId: sessionID,
      taskCallId: "call-restart-canc-1",
      targetAgent: "backend-coder",
    });

    await ctx1.runtime.childExecutionLifecycleService.markStarted({ taskCallId: "call-restart-canc-1" });
    await ctx1.runtime.childExecutionLifecycleService.markCancelled({
      taskCallId: "call-restart-canc-1",
      confirmed: false,
      reason: "Cancellation requested before crash",
    });

    // Destroy and reopen runtime
    await disposeProjectRuntime(projectDir);
    closeAllConnections();
    _resetRouteState();

    const ctx2 = acquireProjectRuntime(projectDir);
    const restored = ctx2.runtime.childExecutionLifecycleService.getChildExecution({
      taskCallId: "call-restart-canc-1",
    });

    expect(restored).not.toBeNull();
    expect(restored?.status).toBe("running"); // NOT upgraded to cancelled
    expect(restored?.cancelRequested).toBe(true);
    expect(restored?.nativeTerminationConfirmed).toBe(false);

    await releaseProjectRuntime(projectDir);
  });

  it("8. same-content-write-through-adapter-no-progress: identical bytes produce repositoryStateDelta=0", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-same-content";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m8" }] }
    );

    const testFile = "sample.ts";
    const fullPath = join(projectDir, testFile);
    writeFileSync(fullPath, "export const value = 42;\n");

    // Turn 1: write identical content
    await ctx.adapter.onToolExecuteBefore({
      tool: "write",
      sessionID,
      callID: "call-w1",
      args: { file: testFile },
    });
    // Write same bytes
    writeFileSync(fullPath, "export const value = 42;\n");

    await ctx.adapter.onToolExecuteAfter(
      { tool: "write", sessionID, callID: "call-w1", args: { file: testFile } },
      { output: "Wrote sample.ts", metadata: {} }
    );

    const diag = getSessionMetricsDiagnostics(sessionID, projectDir);
    expect(diag.lastRepositoryDelta).toBe(0);
    expect(diag.noProgressCount).toBe(1);

    await releaseProjectRuntime(projectDir);
  });

  it("9. changed-content-write-through-adapter-progress: byte change produces repositoryStateDelta=1 and progress", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-changed-content";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m9" }] }
    );

    const testFile = "sample.ts";
    const fullPath = join(projectDir, testFile);
    writeFileSync(fullPath, "export const value = 42;\n");

    // Turn 1: change bytes
    await ctx.adapter.onToolExecuteBefore({
      tool: "write",
      sessionID,
      callID: "call-w2",
      args: { file: testFile },
    });
    // Write modified bytes
    writeFileSync(fullPath, "export const value = 43;\n");

    await ctx.adapter.onToolExecuteAfter(
      { tool: "write", sessionID, callID: "call-w2", args: { file: testFile } },
      { output: "Wrote sample.ts", metadata: {} }
    );

    const diag = getSessionMetricsDiagnostics(sessionID, projectDir);
    expect(diag.lastRepositoryDelta).toBe(1);
    expect(diag.noProgressCount).toBe(0);
    expect(diag.lastProgressReason).toBe("repository_mutation");

    await releaseProjectRuntime(projectDir);
  });

  it("10. file-creation-and-deletion-through-adapter: create and delete produce repositoryStateDelta=1", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-create-del";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m10" }] }
    );

    const newFile = "created.txt";
    const fullPath = join(projectDir, newFile);

    // 1. Creation: missing -> created
    await ctx.adapter.onToolExecuteBefore({
      tool: "write",
      sessionID,
      callID: "call-create",
      args: { file: newFile },
    });
    writeFileSync(fullPath, "Hello World\n");
    await ctx.adapter.onToolExecuteAfter(
      { tool: "write", sessionID, callID: "call-create", args: { file: newFile } },
      { output: "Created file", metadata: {} }
    );

    let diag = getSessionMetricsDiagnostics(sessionID, projectDir);
    expect(diag.lastRepositoryDelta).toBe(1);
    expect(diag.noProgressCount).toBe(0);

    // 2. Deletion: created -> missing
    await ctx.adapter.onToolExecuteBefore({
      tool: "rm",
      sessionID,
      callID: "call-del",
      args: { file: newFile },
    });
    unlinkSync(fullPath);
    await ctx.adapter.onToolExecuteAfter(
      { tool: "rm", sessionID, callID: "call-del", args: { file: newFile } },
      { output: "Deleted file", metadata: {} }
    );

    diag = getSessionMetricsDiagnostics(sessionID, projectDir);
    expect(diag.lastRepositoryDelta).toBe(1);
    expect(diag.noProgressCount).toBe(0);

    await releaseProjectRuntime(projectDir);
  });

  it("11. multi-target-mutation-fingerprint: extracts and fingerprints multiple files from args", () => {
    const file1 = join(projectDir, "a.ts");
    const file2 = join(projectDir, "b.ts");
    writeFileSync(file1, "const a = 1;");
    writeFileSync(file2, "const b = 2;");

    const targets = extractMutationTargets("patch", { files: ["a.ts", "b.ts"] });
    expect(targets.kind).toBe("multi");
    expect(targets.targetPaths).toEqual(["a.ts", "b.ts"]);

    const fp1 = getMutationTargetFingerprint(projectDir, targets.targetPaths);

    // Change one file
    writeFileSync(file2, "const b = 3;");
    const fp2 = getMutationTargetFingerprint(projectDir, targets.targetPaths);

    expect(fp1).not.toBe(fp2);
  });

  it("12. canonical-verification-observation: improvement counts as progress, regression does not", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-ver-canon";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m12" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    const runId = run!.id;

    // 1. Initial test run: 5 failures
    const obs1 = ctx.runtime.progressObservationService.recordVerificationObservation({
      runId,
      verificationId: "v1",
      status: "failed",
      passed: 95,
      failed: 5,
      fingerprint: "95:5:exit_1",
    });
    expect(obs1.verificationDelta).toBe(0);

    // 2. Same test run: identical results -> delta = 0
    const obs2 = ctx.runtime.progressObservationService.recordVerificationObservation({
      runId,
      verificationId: "v2",
      status: "failed",
      passed: 95,
      failed: 5,
      fingerprint: "95:5:exit_1",
    });
    expect(obs2.verificationDelta).toBe(0);
    expect(obs2.isProgress).toBe(false);

    // 3. Improved test run: 0 failures -> delta = 1 & progress = true
    const obs3 = ctx.runtime.progressObservationService.recordVerificationObservation({
      runId,
      verificationId: "v3",
      status: "passed",
      passed: 100,
      failed: 0,
      fingerprint: "100:0:exit_0",
    });
    expect(obs3.verificationDelta).toBe(1);
    expect(obs3.isProgress).toBe(true);
    expect(obs3.progressReason).toBe("verification_improvement");

    // 4. Regressed test run: 2 failures -> delta = 1, but NOT positive progress
    const obs4 = ctx.runtime.progressObservationService.recordVerificationObservation({
      runId,
      verificationId: "v4",
      status: "failed",
      passed: 98,
      failed: 2,
      fingerprint: "98:2:exit_1",
    });
    expect(obs4.verificationDelta).toBe(1);
    expect(obs4.isProgress).toBe(false);
    expect(obs4.progressReason).toBe("verification_regression");

    await releaseProjectRuntime(projectDir);
  });

  it("13. malformed-progress-state-fails-closed: corrupt schema fails closed on recovery", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-corrupt-canon";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m13" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    const runId = run!.id;

    // Write malformed JSON into execution_metadata
    ctx.runtime.db.query(
      `INSERT INTO execution_metadata (id, run_id, session_id, key, value, created_at)
       VALUES ('meta-corrupt', ?, NULL, ?, ?, datetime('now'))`
    ).run(runId, `progress_state:${runId}`, JSON.stringify({ noProgressCount: "NOT_A_NUMBER", repeatedFailure: -50 }));

    ctx.runtime.progressObservationService.reconcileAfterRestart(runId);

    const diag = ctx.runtime.progressObservationService.getDiagnosticsForRun(runId);
    expect(diag.corruptRecovery).toBe(true);
    expect(diag.noProgressCount).toBe(999);

    await releaseProjectRuntime(projectDir);
  });

  it("14. child-start-does-not-loop-progress: launching child records state delta without resetting noProgressCount", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-launch-canon";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m14" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    const runId = run!.id;

    const obsStart = ctx.runtime.progressObservationService.recordChildLifecycleObservation({
      runId,
      sessionId: sessionID,
      assignmentId: "a1",
      executionId: "e1",
      previousState: "queued",
      newState: "running",
    });

    expect(obsStart.executionStateDelta).toBe(1);
    expect(obsStart.assignmentStateDelta).toBe(1);
    expect(obsStart.isProgress).toBe(false);

    await releaseProjectRuntime(projectDir);
  });

  it("15. child-persistence-failure-fails-closed: database write failure prevents false successful in-memory transition", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-child-fail-closed";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m15" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    const runId = run!.id;

    const _rec = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId,
      parentSessionId: sessionID,
      taskCallId: "call-persist-fail",
      targetAgent: "reviewer",
    });

    // Make nativeChildRepo throw
    (ctx.runtime.childExecutionLifecycleService as any).nativeChildRepo.save = () => {
      throw new Error("Disk I/O failure on execution_metadata");
    };

    await expect(
      ctx.runtime.childExecutionLifecycleService.markCompleted({
        taskCallId: "call-persist-fail",
        output: "Success",
      })
    ).rejects.toThrow("Disk I/O failure on execution_metadata");

    await releaseProjectRuntime(projectDir);
  });

  it("16. progress-persistence-failure-fails-closed: progress persistence failure throws and fails closed", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-prog-fail-closed";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m16" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    const runId = run!.id;

    // Simulate db persistence write failure
    (ctx.runtime.progressObservationService as any).persistState = () => {
      throw new Error("SQLite disk full during progress observation write");
    };

    expect(() => {
      ctx.runtime.progressObservationService.recordToolObservation({
        runId,
        sessionId: sessionID,
        tool: "read",
        args: { file: "any.ts" },
        output: "novel content",
      });
    }).toThrow("SQLite disk full");

    await releaseProjectRuntime(projectDir);
  });

  it("17. duplicate-child-result-is-not-second-progress: completing same child twice emits progress=false on replay", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-dup-child-res";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m17" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    const runId = run!.id;

    const obs1 = ctx.runtime.progressObservationService.recordChildLifecycleObservation({
      runId,
      sessionId: sessionID,
      assignmentId: "a1",
      executionId: "exec-1",
      previousState: "running",
      newState: "completed",
      result: "Final output",
    });
    expect(obs1.isProgress).toBe(true);

    const obs2 = ctx.runtime.progressObservationService.recordChildLifecycleObservation({
      runId,
      sessionId: sessionID,
      assignmentId: "a1",
      executionId: "exec-1",
      previousState: "running",
      newState: "completed",
      result: "Final output",
    });
    expect(obs2.isProgress).toBe(false);
    expect(obs2.evidenceDelta).toBe(0);

    await releaseProjectRuntime(projectDir);
  });

  it("18. native-cancel-failure-preserves-running-truth: client abort failure preserves running status", async () => {
    const ctx = acquireProjectRuntime(projectDir);
    const sessionID = "sess-abort-fail";
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: "m18" }] }
    );
    const run = await ctx.adapter.resolveActiveRunForSession(sessionID);
    const runId = run!.id;

    await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId,
      parentSessionId: sessionID,
      taskCallId: "call-abort-fail",
      targetAgent: "backend-coder",
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ taskCallId: "call-abort-fail" });
    ctx.runtime.childExecutionLifecycleService.bindChildSession({
      parentSessionId: sessionID,
      childSessionId: "sess-child-running",
      taskCallId: "call-abort-fail",
    });

    const mockFailingClient = {
      session: {
        abort: async () => {
          throw new Error("Connection refused to container");
        },
      },
    };

    const res = await ctx.runtime.childExecutionLifecycleService.markCancelled({
      taskCallId: "call-abort-fail",
      confirmed: false,
      client: mockFailingClient,
      reason: "User cancelled",
    });

    expect(res?.changed).toBe(true);
    expect(res?.record.status).toBe("running"); // NOT marked cancelled because abort failed
    expect(res?.record.cancelRequested).toBe(true);
    expect(res?.record.nativeTerminationConfirmed).toBe(false);

    await releaseProjectRuntime(projectDir);
  });
});

