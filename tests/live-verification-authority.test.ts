import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { OrchestrationPhase as OP } from "../src/orchestration/types/runs";
import { acquireProjectRuntime, disposeProjectRuntime, releaseProjectRuntime } from "../src/runtime/project-registry";

let testDir = "";

async function createCompletedChild(
  ctx: Awaited<ReturnType<typeof acquireProjectRuntime>>,
  sessionID: string,
  output?: string,
  includeAuthoritativeTestEvidence = false,
) {
  await ctx.adapter.onChatMessage(
    { sessionID, agent: "heidi", messageID: `${sessionID}-m1` },
    { message: {} as any, parts: [{ type: "text", text: "Refactor backend telemetry services across repos", id: "1", sessionID, messageID: `${sessionID}-m1` }] },
  );
  const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
  const initialSnapshot = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
  ctx.runtime.transitionEngine.transitionPhase({
    runId: run.id,
    targetPhase: OP.EXECUTING,
    expectedPhase: initialSnapshot.phase,
    expectedAggregateVersion: initialSnapshot.aggregateVersion,
    authority: "transition_engine",
  });
  const delegation = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
    runId: run.id,
    parentSessionId: sessionID,
    taskCallId: `${sessionID}-delegation`,
    targetAgent: "coder",
  });
  ctx.runtime.childExecutionLifecycleService.bindChildSession({
    parentSessionId: sessionID,
    childSessionId: `${sessionID}-child`,
    agentId: "coder",
    taskCallId: delegation.taskCallId,
  });
  await ctx.runtime.childExecutionLifecycleService.markStarted({ childSessionId: `${sessionID}-child` });
  await ctx.runtime.childExecutionLifecycleService.markCompleted({ childSessionId: `${sessionID}-child`, output });
  if (includeAuthoritativeTestEvidence) {
    ctx.runtime.db.query(`
      INSERT INTO assignment_results (
        id, assignment_id, step_number, status, tests_passed, tests_failed,
        output_summary, started_at, completed_at
      ) VALUES (?, ?, 1, 'passed', 1, 0, 'Persisted command/test evidence', datetime('now'), datetime('now'))
    `).run(`${sessionID}-assignment-result`, delegation.assignmentId);
  }
  return { run, delegation };
}

async function triggerAuthoritativeIdle(ctx: Awaited<ReturnType<typeof acquireProjectRuntime>>, sessionID: string) {
  // Preserve the existing FAST_DIRECT retirement semantics before the next idle
  // event acts as the authoritative lifecycle trigger.
  await ctx.adapter.onSessionIdle(sessionID);
  await ctx.adapter.onSessionIdle(sessionID);
}

describe("Live Verification Authority", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "flowdeck-live-verification-"));
  });

  afterEach(async () => {
    await disposeProjectRuntime(testDir);
    if (process.platform !== "win32") {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("completes exactly once only after one durable live verification pass and policy review", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync } });
    const sessionID = "live-verification-pass";
    const { run } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);
    ctx.runtime.db.query("UPDATE task_runs SET baseline_sha = ? WHERE run_id = ?").run("a".repeat(40), run.id);

    await triggerAuthoritativeIdle(ctx, sessionID);

    const verificationPage = await ctx.runtime.services.verificationService.listVerifications(
      { runId: run.id },
      { page: 1, limit: 10 },
    );
    expect(verificationPage.total).toBe(1);
    expect(verificationPage.items[0]?.status).toBe("passed");
    expect(verificationPage.items[0]?.stateFingerprint).toBeDefined();
    expect(verificationPage.items[0]?.evidenceIds?.length).toBeGreaterThan(0);
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.phase).toBe(OP.COMPLETED);
    const reviews = ctx.runtime.db.query("SELECT * FROM heidi_completion_reviews WHERE task_run_id = ?").all(run.id) as any[];
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.status).toBe("completed");
    expect(reviews[0]?.verification_id).toBe(verificationPage.items[0]?.id);
    expect(promptAsync).not.toHaveBeenCalled();

    // A duplicate session.idle observes the same durable request and result.
    await triggerAuthoritativeIdle(ctx, sessionID);
    const replayPage = await ctx.runtime.services.verificationService.listVerifications(
      { runId: run.id },
      { page: 1, limit: 10 },
    );
    expect(replayPage.total).toBe(1);
    expect(replayPage.items[0]?.id).toBe(verificationPage.items[0]?.id);
    expect(ctx.runtime.db.query("SELECT COUNT(*) AS c FROM heidi_completion_reviews WHERE task_run_id = ?").get(run.id)).toEqual({ c: 1 });
    expect(ctx.runtime.db.query("SELECT COUNT(*) AS c FROM event_outbox WHERE source_component = 'completion_policy' AND aggregate_id = ?").get(run.id)).toEqual({ c: 1 });
  });

  it("rejects the legacy direct completion service backdoor", async () => {
    const ctx = acquireProjectRuntime(testDir);
    await expect(ctx.runtime.services.completionService.completeRun("legacy-completion", "caller supplied success", "success"))
      .rejects.toMatchObject({ code: "COMPLETION_POLICY_REQUIRED" });
  });

  it("fails closed when the CompletionPolicy has no durable passed verification", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "completion-policy-missing-verification";
    const { run } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);
    ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });

    const result = ctx.runtime.completionPolicy.evaluateAndComplete({
      runId: run.id,
      sessionId: sessionID,
      verificationId: "missing-live-verification",
    });
    expect(result.status).toBe("BLOCKED");
    expect(result.blockerReasons).toContain("LIVE_VERIFICATION_MISSING");
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.phase).toBe(OP.VERIFYING);
  });

  it("fails closed when a passed verification becomes stale or its authority JSON is corrupt", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "completion-policy-stale-corrupt";
    const { run, delegation } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);
    ctx.runtime.db.query("UPDATE task_runs SET baseline_sha = ? WHERE run_id = ?").run("b".repeat(40), run.id);
    ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    const snapshot = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const fingerprint = ctx.runtime.orchestrationSnapshotService.computeStateFingerprint(run.id, sessionID)!;
    const request = await ctx.runtime.services.verificationService.requestLiveVerification({
      runId: run.id,
      stateVersion: snapshot.aggregateVersion,
      stateFingerprint: fingerprint,
      checkType: "live_orchestration",
      correlationId: run.id,
      targetSha: "b".repeat(40),
      evidenceIds: snapshot.workItems.flatMap(item => item.evidenceIds),
    });
    await ctx.runtime.services.verificationService.evaluateLiveVerification(request.id, {
      requiredChecksComplete: true,
      requiredChecksPassed: true,
      evidenceIds: request.evidenceIds ?? [],
      failureReasons: [],
    });

    ctx.runtime.db.query(
      "INSERT INTO assignment_files (id, assignment_id, file_path, change_type, content_hash) VALUES (?, ?, 'src/stale.ts', 'modify', 'stale-after-pass')",
    ).run("completion-policy-stale-artifact", delegation.assignmentId);
    const stale = ctx.runtime.completionPolicy.evaluateAndComplete({ runId: run.id, sessionId: sessionID, verificationId: request.id });
    expect(stale.status).toBe("BLOCKED");
    expect(stale.blockerReasons).toContain("VERIFICATION_STATE_FINGERPRINT_STALE");

    ctx.runtime.db.query("UPDATE verification_results SET evidence_json = '{bad-json' WHERE id = ?").run(request.id);
    const corrupt = ctx.runtime.completionPolicy.evaluateAndComplete({ runId: run.id, sessionId: sessionID, verificationId: request.id });
    expect(corrupt.status).toBe("BLOCKED");
    expect(corrupt.blockerReasons).toContain("LIVE_VERIFICATION_EVIDENCE_JSON_CORRUPT");
    await expect(ctx.runtime.services.verificationService.getVerification(request.id)).rejects.toThrow("CORRUPT_LIVE_VERIFICATION_ROW:evidence_json");
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.phase).toBe(OP.VERIFYING);
  });

  it("persists a verification failure and routes the Run through recovering rather than terminal completion", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "live-verification-fail";
    const { run } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS");

    await triggerAuthoritativeIdle(ctx, sessionID);

    const verificationPage = await ctx.runtime.services.verificationService.listVerifications(
      { runId: run.id },
      { page: 1, limit: 10 },
    );
    expect(verificationPage.total).toBe(1);
    expect(verificationPage.items[0]?.status).toBe("failed");
    expect(verificationPage.items[0]?.failureReasons).toContain("NO_DURABLE_EVIDENCE");
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.phase).toBe(OP.RECOVERING);
  });

  it("does not request verification while an unresolved deferred replacement blocks the Run", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "live-verification-deferred-block";
    const { run } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);

    ctx.runtime.db.query(`
      INSERT INTO deferred_replacements (
        id, parent_session_id, old_run_id, source_intent, agent_id, effective_goal,
        message_hash, message_id, correlation_id, routing_decision, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'MODIFY_RECLASSIFICATION', 'heidi', 'preserve verification barrier', ?, ?, ?, ?, 'handoff_pending', datetime('now'), datetime('now'))
    `).run("deferred-live-verification-block", sessionID, run.id, "hash", "message", run.id, JSON.stringify({ executionClass: "STANDARD", reason: "fixture", reasonCode: "FIXTURE", confidence: 1, forcedByExplicitSignal: false }));

    await triggerAuthoritativeIdle(ctx, sessionID);

    const verificationPage = await ctx.runtime.services.verificationService.listVerifications(
      { runId: run.id },
      { page: 1, limit: 10 },
    );
    expect(verificationPage.total).toBe(0);
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.phase).toBe(OP.EXECUTING);
  });

  it("quarantines corrupt deferred replacement authority and retains its completion barrier", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "corrupt-deferred-replacement";
    const { run } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);
    ctx.runtime.db.query(`
      INSERT INTO deferred_replacements (
        id, parent_session_id, old_run_id, source_intent, agent_id, effective_goal,
        message_hash, message_id, correlation_id, routing_decision, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'REPLACE', 'heidi', 'corrupt durable authority', 'hash', 'message', ?, '{bad-json', 'pending_termination', datetime('now'), datetime('now'))
    `).run("corrupt-deferred-authority", sessionID, run.id, run.id);

    expect(ctx.runtime.deferredReplacementRepo.findCurrentForSession(sessionID)).toBeNull();
    expect(ctx.runtime.db.query("SELECT status FROM deferred_replacements WHERE id = ?").get("corrupt-deferred-authority")).toEqual({ status: "blocked" });
    const transition = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(transition.reasonCode).not.toBe("READY_FOR_VERIFICATION");
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.lifecycleBlocks.unresolvedDeferredReplacement).toBe(true);
  });

  it("invalidates a verification result when persisted repository artifacts change", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "live-verification-repository-mutation";
    const { run, delegation } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);

    ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    const before = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const fingerprint = ctx.runtime.orchestrationSnapshotService.computeStateFingerprint(run.id, sessionID)!;
    const request = await ctx.runtime.services.verificationService.requestLiveVerification({
      runId: run.id,
      stateVersion: before.aggregateVersion,
      stateFingerprint: fingerprint,
      checkType: "live_orchestration",
      correlationId: run.id,
      evidenceIds: before.workItems.flatMap(item => item.evidenceIds),
    });

    ctx.runtime.db.query(
      "INSERT INTO assignment_files (id, assignment_id, file_path, change_type, content_hash) VALUES (?, ?, 'src/verification.ts', 'modify', 'post-request-change')",
    ).run("repository-mutation-evidence", delegation.assignmentId);
    expect(ctx.runtime.orchestrationSnapshotService.computeStateFingerprint(run.id, sessionID)).not.toBe(fingerprint);

    const result = await ctx.runtime.services.verificationService.evaluateLiveVerification(request.id, {
      requiredChecksComplete: true,
      requiredChecksPassed: true,
      evidenceIds: request.evidenceIds ?? [],
      failureReasons: [],
    });
    const observed = ctx.runtime.transitionEngine.observeVerificationResult({
      runId: run.id,
      stateVersion: result.stateVersion!,
      stateFingerprint: result.stateFingerprint!,
      status: "passed",
    });
    expect(observed.reasonCode).toBe("VERIFICATION_STALE");
  });

  it("preserves passed and pending verification records across restart without duplication", async () => {
    let ctx = acquireProjectRuntime(testDir);
    const passedSession = "live-verification-restart-pass";
    const { run: passedRun } = await createCompletedChild(ctx, passedSession, "Worker prose: PASS", true);
    await triggerAuthoritativeIdle(ctx, passedSession);
    const passedBeforeRestart = await ctx.runtime.services.verificationService.listVerifications({ runId: passedRun.id }, { page: 1, limit: 10 });
    expect(passedBeforeRestart.items[0]?.status).toBe("passed");

    await releaseProjectRuntime(testDir);
    ctx = acquireProjectRuntime(testDir);
    const passedAfterRestart = await ctx.runtime.services.verificationService.listVerifications({ runId: passedRun.id }, { page: 1, limit: 10 });
    expect(passedAfterRestart.total).toBe(1);
    expect(passedAfterRestart.items[0]?.id).toBe(passedBeforeRestart.items[0]?.id);
    expect(passedAfterRestart.items[0]?.status).toBe("passed");

    const pendingSession = "live-verification-restart-pending";
    const { run: pendingRun } = await createCompletedChild(ctx, pendingSession, "Worker prose: PASS", true);
    ctx.runtime.transitionEngine.evaluate({ runId: pendingRun.id, sessionId: pendingSession });
    const pendingBefore = ctx.runtime.orchestrationSnapshotService.getSnapshot(pendingRun.id, pendingSession)!;
    const pendingFingerprint = ctx.runtime.orchestrationSnapshotService.computeStateFingerprint(pendingRun.id, pendingSession)!;
    const pendingRequest = await ctx.runtime.services.verificationService.requestLiveVerification({
      runId: pendingRun.id,
      stateVersion: pendingBefore.aggregateVersion,
      stateFingerprint: pendingFingerprint,
      checkType: "live_orchestration",
      correlationId: pendingRun.id,
      evidenceIds: pendingBefore.workItems.flatMap(item => item.evidenceIds),
    });
    expect(pendingRequest.status).toBe("pending");

    await releaseProjectRuntime(testDir);
    ctx = acquireProjectRuntime(testDir);
    const resumedSnapshot = ctx.runtime.orchestrationSnapshotService.getSnapshot(pendingRun.id, pendingSession)!;
    const resumedFingerprint = ctx.runtime.orchestrationSnapshotService.computeStateFingerprint(pendingRun.id, pendingSession)!;
    const resumedRequest = await ctx.runtime.services.verificationService.requestLiveVerification({
      runId: pendingRun.id,
      stateVersion: resumedSnapshot.aggregateVersion,
      stateFingerprint: resumedFingerprint,
      checkType: "live_orchestration",
      correlationId: pendingRun.id,
      evidenceIds: resumedSnapshot.workItems.flatMap(item => item.evidenceIds),
    });
    expect(resumedRequest.id).toBe(pendingRequest.id);
    expect(resumedRequest.status).toBe("pending");
  });

  it("does not allow a late passing verifier result to resurrect a cancelled Run", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "live-verification-cancel-race";
    const { run } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);

    ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    const snapshot = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const fingerprint = ctx.runtime.orchestrationSnapshotService.computeStateFingerprint(run.id, sessionID)!;
    const request = await ctx.runtime.services.verificationService.requestLiveVerification({
      runId: run.id,
      stateVersion: snapshot.aggregateVersion,
      stateFingerprint: fingerprint,
      checkType: "live_orchestration",
      correlationId: run.id,
      evidenceIds: snapshot.workItems.flatMap(item => item.evidenceIds),
    });
    const result = await ctx.runtime.services.verificationService.evaluateLiveVerification(request.id, {
      requiredChecksComplete: true,
      requiredChecksPassed: true,
      evidenceIds: request.evidenceIds ?? [],
      failureReasons: [],
    });

    await ctx.runtime.services.runService.cancelRun(run.id, "user authority during verification");
    const observed = ctx.runtime.transitionEngine.observeVerificationResult({
      runId: run.id,
      stateVersion: result.stateVersion!,
      stateFingerprint: result.stateFingerprint!,
      status: "passed",
    });
    expect(observed.reasonCode).toBe("BLOCKED");
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.phase).toBe(OP.CANCELLED);
  });

  it("marks a result stale when the authoritative Run fingerprint changes before application", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "live-verification-stale";
    const { run, delegation } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);

    const readiness = ctx.runtime.transitionEngine.evaluate({ runId: run.id, sessionId: sessionID });
    expect(readiness.reasonCode).toBe("READY_FOR_VERIFICATION");
    const before = ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)!;
    const fingerprint = ctx.runtime.orchestrationSnapshotService.computeStateFingerprint(run.id, sessionID)!;
    const request = await ctx.runtime.services.verificationService.requestLiveVerification({
      runId: run.id,
      stateVersion: before.aggregateVersion,
      stateFingerprint: fingerprint,
      checkType: "live_orchestration",
      correlationId: run.id,
      evidenceIds: before.workItems.flatMap(item => item.evidenceIds),
    });

    // A required work-item mutation creates a newer authoritative state.
    ctx.runtime.db.query("UPDATE assignments SET status = 'pending' WHERE id = ?").run(delegation.assignmentId);
    const result = await ctx.runtime.services.verificationService.evaluateLiveVerification(request.id, {
      requiredChecksComplete: true,
      requiredChecksPassed: true,
      evidenceIds: request.evidenceIds ?? [],
      failureReasons: [],
    });
    const observed = ctx.runtime.transitionEngine.observeVerificationResult({
      runId: run.id,
      stateVersion: result.stateVersion!,
      stateFingerprint: result.stateFingerprint!,
      status: "passed",
    });
    expect(observed.reasonCode).toBe("VERIFICATION_STALE");

    const stale = await ctx.runtime.services.verificationService.markLiveVerificationStale(result.id, "STATE_CHANGED_BEFORE_APPLICATION");
    expect(stale.isStale).toBe(true);
  });
});
