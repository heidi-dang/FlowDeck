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
import { RunStatus, isTerminalRunStatus } from "../src/orchestration/types/runs";
import {
  buildCanonicalRoutingDecision,
  reconstructRouterDecision,
  PRESERVE_CONFIGURED_MODEL,
  UNKNOWN_SOURCE_SHA,
  resolveSourceSha,
} from "../src/orchestration/routing/fast-router-adapter";
import { classifyUserTurnIntent } from "../src/services/user-turn-intent";
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

  it("3. fast-direct-replaced-before-idle & late-idle-does-not-deactivate-new-durable-run", async () => {
    const ctx = acquireProjectRuntime(dirA);
    const adapter = ctx.adapter;

    // Message 1: FAST_DIRECT
    await adapter.onChatMessage(
      { sessionID: "sess-fast-race", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "fix typo in readme.md", id: "1", sessionID: "sess-fast-race", messageID: "msg-1" }] }
    );

    const firstRoute = getRouteDecision("sess-fast-race");
    expect(firstRoute).not.toBeNull();
    expect(firstRoute?.decision.executionClass).toBe("FAST_DIRECT");

    // Message 2 arriving BEFORE idle: Security audit task
    await adapter.onChatMessage(
      { sessionID: "sess-fast-race", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Perform security vulnerability scan on authentication routes", id: "2", sessionID: "sess-fast-race", messageID: "msg-2" }] }
    );

    const secondRoute = getRouteDecision("sess-fast-race");
    expect(secondRoute).not.toBeNull();
    expect(secondRoute?.decision.executionClass).toBe("SPECIALIST");
    expect(secondRoute?.active).toBe(true);

    const sessionRow = ctx.runtime.sessionRepo.findById("sess-fast-race");
    expect(sessionRow).toBeDefined();
    const runId = sessionRow!.runId;

    // Deliver late session.idle from turn 1
    await adapter.onEvent({ type: "session.idle", properties: { sessionID: "sess-fast-race" } });

    // Durable route and Run must remain ACTIVE
    const afterIdleRoute = getRouteDecision("sess-fast-race");
    expect(afterIdleRoute).not.toBeNull();
    expect(afterIdleRoute?.active).toBe(true);
    expect(afterIdleRoute?.decision.executionClass).toBe("SPECIALIST");

    const run = await ctx.runtime.services.runRepo.findById(runId);
    expect(run).toBeDefined();
    expect(isTerminalRunStatus(run!.status)).toBe(false);
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

  it("6. user-turn-intent-classifier: unit tests for all domain intents", () => {
    expect(classifyUserTurnIntent({ newMessage: "x", messageHash: "h1", lastMessageHash: "h1" }).intent).toBe("REPLAY");
    expect(classifyUserTurnIntent({ newMessage: "continue" }).intent).toBe("CONTINUE");
    expect(classifyUserTurnIntent({ newMessage: "keep going with the implementation" }).intent).toBe("CONTINUE");
    expect(classifyUserTurnIntent({ newMessage: "what have you completed so far?" }).intent).toBe("QUERY");
    expect(classifyUserTurnIntent({ newMessage: "status" }).intent).toBe("QUERY");
    expect(classifyUserTurnIntent({ newMessage: "also add pagination to /v2/users" }).intent).toBe("MODIFY");
    expect(classifyUserTurnIntent({ newMessage: "change timeout to 5000" }).intent).toBe("MODIFY");
    expect(classifyUserTurnIntent({ newMessage: "forget that, perform a security audit instead" }).intent).toBe("REPLACE");
    expect(classifyUserTurnIntent({ newMessage: "new task: build GraphQL schema" }).intent).toBe("REPLACE");
    expect(classifyUserTurnIntent({ newMessage: "cancel this task" }).intent).toBe("CANCEL");
    expect(classifyUserTurnIntent({ newMessage: "stop execution" }).intent).toBe("CANCEL");
  });

  it("7. user-turn-intent-active-run-lifecycle: verify MODIFY, REPLACE, and CANCEL transitions against active Run", async () => {
    const ctx = acquireProjectRuntime(dirA);
    const adapter = ctx.adapter;

    // Start Run A
    await adapter.onChatMessage(
      { sessionID: "sess-intent-flow", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement REST API for accounts", id: "1", sessionID: "sess-intent-flow", messageID: "msg-1" }] }
    );
    const sessionRow1 = ctx.runtime.sessionRepo.findById("sess-intent-flow")!;
    const runIdA = sessionRow1.runId;

    // 1. MODIFY: keeps same run, updates route goal and appends modification event
    await adapter.onChatMessage(
      { sessionID: "sess-intent-flow", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "also add pagination and change the endpoint to /v2/users", id: "2", sessionID: "sess-intent-flow", messageID: "msg-2" }] }
    );
    const runAModified = await ctx.runtime.services.runRepo.findById(runIdA);
    expect(runAModified?.id).toBe(runIdA);
    const routeModified = getRouteDecision("sess-intent-flow");
    expect(routeModified?.goal).toContain("Modified: also add pagination");

    // 2. QUERY / CONTINUE: preserves run
    await adapter.onChatMessage(
      { sessionID: "sess-intent-flow", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "what have you completed so far?", id: "3", sessionID: "sess-intent-flow", messageID: "msg-3" }] }
    );
    const runAAfterQuery = await ctx.runtime.services.runRepo.findById(runIdA);
    expect(isTerminalRunStatus(runAAfterQuery!.status)).toBe(false);

    // 3. REPLACE: supersedes Run A, creates Run B
    await adapter.onChatMessage(
      { sessionID: "sess-intent-flow", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "forget that, perform a security audit instead", id: "4", sessionID: "sess-intent-flow", messageID: "msg-4" }] }
    );
    const runASuperseded = await ctx.runtime.services.runRepo.findById(runIdA);
    expect(runASuperseded?.status).toBe("cancelled");

    const sessionRow2 = ctx.runtime.sessionRepo.findById("sess-intent-flow")!;
    expect(sessionRow2.runId).not.toBe(runIdA);
    const runB = await ctx.runtime.services.runRepo.findById(sessionRow2.runId);
    expect(isTerminalRunStatus(runB!.status)).toBe(false);

    // 4. CANCEL: cancels Run B
    await adapter.onChatMessage(
      { sessionID: "sess-intent-flow", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "cancel this task", id: "5", sessionID: "sess-intent-flow", messageID: "msg-5" }] }
    );
    const runBCancelled = await ctx.runtime.services.runRepo.findById(sessionRow2.runId);
    expect(runBCancelled?.status).toBe("cancelled");
    expect(getRouteDecision("sess-intent-flow")?.active).toBe(false);
  });

  it("8. forced-explicit-signal-roundtrip & fail-closed reconstruction", () => {
    const validDecision = buildCanonicalRoutingDecision({
      runId: "run-forced-1",
      decision: {
        executionClass: "SPECIALIST",
        specialists: ["SECURITY"],
        suggestedAgents: ["security-auditor"],
        reason: "Security audit",
        reasonCode: "SPECIALIST_SECURITY",
        confidence: 0.95,
        forcedByExplicitSignal: true,
      },
      goal: "Perform full security audit",
      lastUserMessageHash: "hash-forced-1",
    });

    const reconstructed = reconstructRouterDecision(validDecision);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed?.decision.forcedByExplicitSignal).toBe(true);
    expect(reconstructed?.decision.executionClass).toBe("SPECIALIST");
    expect(reconstructed?.decision.specialists).toEqual(["SECURITY"]);

    // Malformed specialists -> fails closed
    const badSpec = JSON.parse(JSON.stringify(validDecision));
    badSpec.assessment.evidence.find((e: any) => e.signal === "specialists").value = JSON.stringify(["INVALID_SPEC"]);
    expect(reconstructRouterDecision(badSpec)).toBeNull();

    // Malformed agents -> fails closed
    const badAgents = JSON.parse(JSON.stringify(validDecision));
    badAgents.assessment.evidence.find((e: any) => e.signal === "suggestedAgents").value = JSON.stringify([123]);
    expect(reconstructRouterDecision(badAgents)).toBeNull();

    // Malformed code mode telemetry -> fails closed
    const badTelemetry = JSON.parse(JSON.stringify(validDecision));
    badTelemetry.assessment.evidence.push({
      id: "ev-bad-telemetry",
      kind: "code_mode",
      signal: "telemetry",
      value: JSON.stringify({ codeModeConsidered: "not_a_boolean" }),
      weight: 50,
    });
    expect(reconstructRouterDecision(badTelemetry)).toBeNull();
  });

  it("9. routing-model-preserves-configured-model & routing-has-no-fake-ownership", () => {
    const decision = buildCanonicalRoutingDecision({
      runId: "run-clean-1",
      decision: {
        executionClass: "STANDARD",
        reason: "Standard feature implementation",
        reasonCode: "STANDARD_FEATURE",
        confidence: 0.85,
        forcedByExplicitSignal: false,
      },
      goal: "Implement new service",
      lastUserMessageHash: "hash-clean-1",
    });

    expect(decision.modelRecommendation).toBe(PRESERVE_CONFIGURED_MODEL);
    expect(decision.delegations).toEqual([]);
    expect(decision.workstreams).toEqual([]);
  });

  it("10. source-sha-unavailable-is-explicit", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "fdx-non-git-"));
    const resolved = resolveSourceSha(nonGitDir);
    expect(resolved).toBe(UNKNOWN_SOURCE_SHA);
    rmSync(nonGitDir, { recursive: true, force: true });
  });

  it("11. cleanup-uses-task-id-only: clears HeidiTaskState using the actual taskId from the session route", async () => {
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

  it("12. diagnostics-does-not-create-runtime & runtime-read-does-not-acquire-lease", () => {
    const uninitDir = mkdtempSync(join(tmpdir(), "fdx-uninit-"));
    const diag = getSessionMetricsDiagnostics("sess-none", uninitDir);

    expect(diag.toolCalls).toBe(0);
    expect(existsSync(join(uninitDir, ".flowdeck"))).toBe(false);
    expect(getProjectRuntime(uninitDir)).toBeNull();

    // Acquire dirA and test that getProjectRuntime does not increment refCount
    const owner = acquireProjectRuntime(dirA);
    expect(owner.refCount).toBe(1);

    const read1 = getProjectRuntime(dirA);
    expect(read1).toBe(owner);
    expect(owner.refCount).toBe(1);

    const read2 = getProjectRuntime(dirA);
    expect(read2).toBe(owner);
    expect(owner.refCount).toBe(1);

    rmSync(uninitDir, { recursive: true, force: true });
  });

  it("13. always-approve-does-not-bypass-governance: structural invariant blocks are never bypassed by globalAlwaysApprove", async () => {
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

  it("14. project-shared-runtime-lifecycle: refCount ensures shared runtime is kept alive until all owners release", async () => {
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
