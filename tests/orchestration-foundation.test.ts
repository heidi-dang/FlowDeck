import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireProjectRuntime,
  releaseProjectRuntime,
  getProjectRuntime,
  disposeProjectRuntime,
  _resetAllProjectRuntimes,
} from "../src/runtime/project-registry";
import { getSessionMetricsDiagnostics, cleanupSessionState } from "../src/index";
import { _resetRouteState, getRouteDecision } from "../src/services/heidi-route-state";
import { createTaskState, getTaskState, _resetAllTaskState } from "../src/services/heidi-task-state";
import { closeAllConnections } from "../src/orchestration/persistence/connection";
import { RunStatus } from "../src/orchestration/types/runs";
import {
  buildCanonicalRoutingDecision,
  reconstructRouterDecision,
} from "../src/orchestration/routing/fast-router-adapter";
import flowDeckPlugin from "../src/index";

describe("FlowDeck Orchestration Foundation Integration Tests", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    await _resetAllProjectRuntimes();
    closeAllConnections();
    _resetRouteState();
    _resetAllTaskState();
    dirA = mkdtempSync(join(tmpdir(), "fdx-test-a-"));
    dirB = mkdtempSync(join(tmpdir(), "fdx-test-b-"));
  });

  afterEach(async () => {
    await _resetAllProjectRuntimes();
    closeAllConnections();
    _resetRouteState();
    _resetAllTaskState();
    try { rmSync(dirA, { recursive: true, force: true }); } catch {}
    try { rmSync(dirB, { recursive: true, force: true }); } catch {}
  });

  it("1. runtime-project-isolation: project A and B have separate databases and runtimes", async () => {
    const ctxA = acquireProjectRuntime(dirA);
    const ctxB = acquireProjectRuntime(dirB);

    expect(ctxA.runtime).not.toBe(ctxB.runtime);
    expect(ctxA.dbPath).toContain(dirA);
    expect(ctxB.dbPath).toContain(dirB);
    expect(existsSync(ctxA.dbPath)).toBe(true);
    expect(existsSync(ctxB.dbPath)).toBe(true);

    // Dispose A does not affect B
    await releaseProjectRuntime(dirA);
    expect(getProjectRuntime(dirA)).toBeNull();
    expect(getProjectRuntime(dirB)).not.toBeNull();
  });

  it("2. runtime-reload: dispose and re-initialize same project directory cleanly", async () => {
    const ctx1 = acquireProjectRuntime(dirA);
    const dbPath1 = ctx1.dbPath;
    await releaseProjectRuntime(dirA);
    expect(getProjectRuntime(dirA)).toBeNull();

    const ctx2 = acquireProjectRuntime(dirA);
    expect(ctx2.dbPath).toBe(dbPath1);
    expect(ctx2.disposed).toBe(false);
  });

  it("3. fast-direct-followed-by-new-task: FAST_DIRECT finishes on idle and allows next task to classify independently", async () => {
    const ctx = acquireProjectRuntime(dirA);
    const adapter = ctx.adapter;

    // 1. Send FAST_DIRECT prompt
    await adapter.onChatMessage(
      { sessionID: "sess-fast-direct", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "fix typo in readme.md", id: "1", sessionID: "sess-fast-direct", messageID: "msg-1" }] }
    );

    const firstRoute = getRouteDecision("sess-fast-direct");
    expect(firstRoute).not.toBeNull();
    expect(firstRoute?.decision.executionClass).toBe("FAST_DIRECT");

    // FAST_DIRECT does NOT create heavy Run in SQLite
    const sessionRow = ctx.runtime.sessionRepo.findById("sess-fast-direct");
    expect(sessionRow).toBeUndefined();

    // 2. Session reaches idle (turn completes)
    await adapter.onEvent({ type: "session.idle", properties: { sessionID: "sess-fast-direct" } });

    // 3. Next message is a heavy security audit task
    await adapter.onChatMessage(
      { sessionID: "sess-fast-direct", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Perform security vulnerability scan on authentication routes", id: "2", sessionID: "sess-fast-direct", messageID: "msg-2" }] }
    );

    const nextRoute = getRouteDecision("sess-fast-direct");
    expect(nextRoute).not.toBeNull();
    expect(nextRoute?.decision.executionClass).toBe("SPECIALIST");
  });

  it("4. terminal-run-new-task-without-reset: new task classifies independently after prior run completes without calling reset", async () => {
    const ctx = acquireProjectRuntime(dirA);
    const adapter = ctx.adapter;

    // Task 1: Complex planned task
    await adapter.onChatMessage(
      { sessionID: "sess-no-manual-reset", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement full feature for user billing across files", id: "1", sessionID: "sess-no-manual-reset", messageID: "msg-1" }] }
    );

    const sessionRow1 = ctx.runtime.sessionRepo.findById("sess-no-manual-reset");
    expect(sessionRow1).toBeDefined();
    const runId1 = sessionRow1!.runId;

    // Mark Run 1 completed in SQLite (authoritative truth)
    await ctx.runtime.services.runService.updateRun(runId1, { status: RunStatus.COMPLETED, stage: "completed" });

    // Task 2: Sent in SAME session WITHOUT manual _resetRouteState()
    await adapter.onChatMessage(
      { sessionID: "sess-no-manual-reset", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "We need frontend UI in react and backend in node simultaneously", id: "2", sessionID: "sess-no-manual-reset", messageID: "msg-2" }] }
    );

    const route2 = getRouteDecision("sess-no-manual-reset");
    expect(route2).not.toBeNull();
    expect(route2?.decision.executionClass).toBe("PARALLEL_SPECIALISTS");

    const sessionRow2 = ctx.runtime.sessionRepo.findById("sess-no-manual-reset");
    expect(sessionRow2!.runId).not.toBe(runId1);
  });

  it("5. cold-restart-durability: all durable execution classes survive cold restart and restore without fabrication", async () => {
    const testCases = [
      { text: "Diagnose and debug why the test is failing with stack trace", expectedClass: "SPECIALIST" },
      { text: "We need frontend UI in react and backend in node simultaneously", expectedClass: "PARALLEL_SPECIALISTS" },
      { text: "Implement new feature across several files and modules", expectedClass: "STANDARD" },
      { text: "Full architecture migration and breaking overhaul", expectedClass: "DEEP" },
    ];

    for (let i = 0; i < testCases.length; i++) {
      const tc = testCases[i];
      const sessionID = `sess-cold-${i}`;

      const ctx = acquireProjectRuntime(dirA);
      await ctx.adapter.onChatMessage(
        { sessionID, agent: "heidi" },
        { message: {} as any, parts: [{ type: "text", text: tc.text, id: "1", sessionID, messageID: `msg-${i}` }] }
      );

      // Verify created in memory
      expect(getRouteDecision(sessionID)?.decision.executionClass).toBe(tc.expectedClass);

      // COLD RESTART: dispose runtime, clear all in-memory state, close DB connections
      await disposeProjectRuntime(dirA);
      _resetRouteState();
      closeAllConnections();

      expect(getRouteDecision(sessionID)).toBeNull();

      // Fresh runtime opens same DB
      const freshCtx = acquireProjectRuntime(dirA);
      await freshCtx.adapter.hydrateSessionRoute(sessionID);

      const restored = getRouteDecision(sessionID);
      expect(restored).not.toBeNull();
      expect(restored?.decision.executionClass).toBe(tc.expectedClass);
      expect(restored?.goal).toBe(tc.text);

      await releaseProjectRuntime(dirA);
    }
  });

  it("6. active-run-duplicate-replay: duplicate message replay is idempotent", async () => {
    const ctx = acquireProjectRuntime(dirA);
    const adapter = ctx.adapter;

    const msg = "Implement a new OAuth authentication flow across files";
    await adapter.onChatMessage(
      { sessionID: "sess-idempotent", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: msg, id: "1", sessionID: "sess-idempotent", messageID: "msg-1" }] }
    );

    const firstSession = ctx.runtime.sessionRepo.findById("sess-idempotent");
    const firstRunId = firstSession?.runId;

    // Send identical text again
    await adapter.onChatMessage(
      { sessionID: "sess-idempotent", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: msg, id: "2", sessionID: "sess-idempotent", messageID: "msg-2" }] }
    );

    const secondSession = ctx.runtime.sessionRepo.findById("sess-idempotent");
    expect(secondSession?.runId).toBe(firstRunId);
  });

  it("7. routing-reconstruction-missing-required-evidence: fails closed when evidence is missing or malformed", () => {
    const validDecision = buildCanonicalRoutingDecision({
      runId: "run-valid-1",
      decision: {
        executionClass: "SPECIALIST",
        specialists: ["DEBUG"],
        suggestedAgents: ["debug-specialist"],
        reason: "Debug test failure",
        reasonCode: "SPECIALIST_DEBUG",
        confidence: 0.9,
        forcedByExplicitSignal: false,
      },
      goal: "Debug failure in auth",
      lastUserMessageHash: "hash-valid-1",
    });

    const good = reconstructRouterDecision(validDecision);
    expect(good).not.toBeNull();
    expect(good?.decision.executionClass).toBe("SPECIALIST");

    // Malform by removing executionClass evidence
    const badDecision = JSON.parse(JSON.stringify(validDecision));
    badDecision.assessment.evidence = badDecision.assessment.evidence.filter(
      (e: any) => e.signal !== "executionClass"
    );
    expect(reconstructRouterDecision(badDecision)).toBeNull();

    // Malform by setting invalid executionClass string
    const invalidClassDecision = JSON.parse(JSON.stringify(validDecision));
    invalidClassDecision.assessment.evidence.find((e: any) => e.signal === "executionClass").value = "FABRICATED_CLASS";
    expect(reconstructRouterDecision(invalidClassDecision)).toBeNull();
  });

  it("8. cleanup-removes-task-by-taskId: clears HeidiTaskState using the actual taskId from the session route", async () => {
    const ctx = acquireProjectRuntime(dirA);
    const adapter = ctx.adapter;

    await adapter.onChatMessage(
      { sessionID: "sess-cleanup-task", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Security pentest across all endpoints", id: "1", sessionID: "sess-cleanup-task", messageID: "msg-1" }] }
    );

    const route = getRouteDecision("sess-cleanup-task");
    expect(route).not.toBeNull();
    const taskId = route!.taskId;

    // Create matching HeidiTaskState
    createTaskState(taskId, "Security pentest", "SPECIALIST");
    expect(getTaskState(taskId)).toBeDefined();

    cleanupSessionState("sess-cleanup-task");

    expect(getRouteDecision("sess-cleanup-task")).toBeNull();
    expect(getTaskState(taskId)).toBeUndefined();
  });

  it("9. diagnostics-does-not-create-runtime: reading diagnostics on uninitialized dir does not create files/DB", () => {
    const uninitDir = mkdtempSync(join(tmpdir(), "fdx-uninit-"));
    const diag = getSessionMetricsDiagnostics("sess-none", uninitDir);

    expect(diag.toolCalls).toBe(0);
    expect(existsSync(join(uninitDir, ".flowdeck"))).toBe(false);
    expect(getProjectRuntime(uninitDir)).toBeNull();

    rmSync(uninitDir, { recursive: true, force: true });
  });

  it("10. always-approve-does-not-bypass-governance: structural invariant blocks are never bypassed by globalAlwaysApprove", async () => {
    // Write governance mode strict in .flowdeck.json
    writeFileSync(
      join(dirA, ".flowdeck.json"),
      JSON.stringify({ governance: { mode: "strict" }, heidi: { globalAlwaysApprove: true } })
    );

    const pluginInstance = await (flowDeckPlugin.server as any)({
      directory: dirA,
      client: {} as any,
    });

    await pluginInstance.config({
      heidi: { globalAlwaysApprove: true },
      governance: { mode: "strict" },
    });

    // Researcher agent attempting to use write (forbidden in its contract)
    const res = await pluginInstance.permission({
      sessionID: "sess-gov",
      agent: { name: "researcher" },
      tool: "write",
      args: {},
    });

    // Must be blocked because researcher cannot run write under strict governance
    expect(res).toBeDefined();
    expect(res.status).toBe("deny");

    await pluginInstance.dispose();
  });

  it("11. project-shared-runtime-lifecycle: refCount ensures shared runtime is kept alive until all owners release", async () => {
    const owner1 = acquireProjectRuntime(dirA);
    expect(owner1.refCount).toBe(1);

    const owner2 = acquireProjectRuntime(dirA);
    expect(owner2.runtime).toBe(owner1.runtime);
    expect(owner1.refCount).toBe(2);

    // Release 1st owner
    await releaseProjectRuntime(dirA);
    expect(getProjectRuntime(dirA)).not.toBeNull();
    expect(owner1.disposed).toBe(false);

    // Release 2nd owner
    await releaseProjectRuntime(dirA);
    expect(getProjectRuntime(dirA)).toBeNull();
    expect(owner1.disposed).toBe(true);
  });
});
