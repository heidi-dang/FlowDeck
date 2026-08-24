import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { OrchestrationPhase as OP } from "../src/orchestration/types/runs";
import { acquireProjectRuntime, releaseProjectRuntime } from "../src/runtime/project-registry";

const TEST_DIR = join(import.meta.dir, ".tmp-live-verification-authority");

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
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await releaseProjectRuntime(TEST_DIR);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates one durable verification from persisted evidence and never completes the Run", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(TEST_DIR, { session: { promptAsync } });
    const sessionID = "live-verification-pass";
    const { run } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);

    await triggerAuthoritativeIdle(ctx, sessionID);

    const verificationPage = await ctx.runtime.services.verificationService.listVerifications(
      { runId: run.id },
      { page: 1, limit: 10 },
    );
    expect(verificationPage.total).toBe(1);
    expect(verificationPage.items[0]?.status).toBe("passed");
    expect(verificationPage.items[0]?.stateFingerprint).toBeDefined();
    expect(verificationPage.items[0]?.evidenceIds?.length).toBeGreaterThan(0);
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.phase).toBe(OP.VERIFYING);
    expect(promptAsync).not.toHaveBeenCalled();

    // A duplicate session.idle observes the same durable request and result.
    await triggerAuthoritativeIdle(ctx, sessionID);
    const replayPage = await ctx.runtime.services.verificationService.listVerifications(
      { runId: run.id },
      { page: 1, limit: 10 },
    );
    expect(replayPage.total).toBe(1);
    expect(replayPage.items[0]?.id).toBe(verificationPage.items[0]?.id);
  });

  it("persists a verification failure and routes the Run through recovering rather than terminal completion", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    const ctx = acquireProjectRuntime(TEST_DIR);
    const sessionID = "live-verification-deferred-block";
    const { run } = await createCompletedChild(ctx, sessionID, "Worker prose: PASS", true);

    ctx.runtime.db.query(`
      INSERT INTO deferred_replacements (
        id, parent_session_id, old_run_id, source_intent, agent_id, effective_goal,
        message_hash, message_id, correlation_id, routing_decision, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'modify', 'heidi', 'preserve verification barrier', ?, ?, ?, 'orchestrated', 'handoff_pending', datetime('now'), datetime('now'))
    `).run("deferred-live-verification-block", sessionID, run.id, "hash", "message", run.id);

    await triggerAuthoritativeIdle(ctx, sessionID);

    const verificationPage = await ctx.runtime.services.verificationService.listVerifications(
      { runId: run.id },
      { page: 1, limit: 10 },
    );
    expect(verificationPage.total).toBe(0);
    expect(ctx.runtime.orchestrationSnapshotService.getSnapshot(run.id, sessionID)?.phase).toBe(OP.EXECUTING);
  });

  it("invalidates a verification result when persisted repository artifacts change", async () => {
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    let ctx = acquireProjectRuntime(TEST_DIR);
    const passedSession = "live-verification-restart-pass";
    const { run: passedRun } = await createCompletedChild(ctx, passedSession, "Worker prose: PASS", true);
    await triggerAuthoritativeIdle(ctx, passedSession);
    const passedBeforeRestart = await ctx.runtime.services.verificationService.listVerifications({ runId: passedRun.id }, { page: 1, limit: 10 });
    expect(passedBeforeRestart.items[0]?.status).toBe("passed");

    await releaseProjectRuntime(TEST_DIR);
    ctx = acquireProjectRuntime(TEST_DIR);
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

    await releaseProjectRuntime(TEST_DIR);
    ctx = acquireProjectRuntime(TEST_DIR);
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
    const ctx = acquireProjectRuntime(TEST_DIR);
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
    const ctx = acquireProjectRuntime(TEST_DIR);
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
