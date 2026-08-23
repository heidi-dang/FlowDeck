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
  isCodeModeTelemetry,
} from "../src/orchestration/routing/fast-router-adapter";
import { classifyUserTurnIntent } from "../src/services/user-turn-intent";
import { AuthoritativeRoutingService } from "../src/orchestration/routing/authoritative";
import flowDeckPlugin from "../src/index";

const dummyActivationEvidence = {
  milestone1: true,
  executionPlanner: true,
  adaptiveBudget: true,
  performanceIntelligence: true,
  determinism: true,
  safety: true,
  modelAuthority: true,
  budgetAuthority: true,
  completionAuthority: true,
};

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
    expect(classifyUserTurnIntent({ newMessage: "thanks" }).intent).toBe("ACKNOWLEDGE");
    expect(classifyUserTurnIntent({ newMessage: "okay" }).intent).toBe("ACKNOWLEDGE");
    expect(classifyUserTurnIntent({ newMessage: "ok" }).intent).toBe("ACKNOWLEDGE");
    expect(classifyUserTurnIntent({ newMessage: "sounds good" }).intent).toBe("ACKNOWLEDGE");
    expect(classifyUserTurnIntent({ newMessage: "got it" }).intent).toBe("ACKNOWLEDGE");
    expect(classifyUserTurnIntent({ newMessage: "great" }).intent).toBe("ACKNOWLEDGE");
    expect(classifyUserTurnIntent({ newMessage: "yes" }).intent).toBe("ACKNOWLEDGE");
    expect(classifyUserTurnIntent({ newMessage: "understood" }).intent).toBe("ACKNOWLEDGE");
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

    const res = await pluginInstance.permission({
      sessionID: "sess-gov",
      agent: { name: "researcher" },
      tool: "write",
      args: {},
    });

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

    await releaseProjectRuntime(dirA);
    expect(getProjectRuntime(dirA)).not.toBeNull();
    expect(owner1.disposed).toBe(false);

    await releaseProjectRuntime(dirA);
    expect(getProjectRuntime(dirA)).toBeNull();
    expect(owner1.disposed).toBe(true);
  });

  it("15. modify-survives-cold-restart: full runtime destruction, reopen, and assert modified goal/hash/version", async () => {
    const sessionID = "sess-modify-restart";
    const ctx1 = acquireProjectRuntime(dirA);
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement REST API for accounts", id: "1", sessionID, messageID: "msg-1" }] }
    );

    const sessionRow1 = ctx1.runtime.sessionRepo.findById(sessionID);
    expect(sessionRow1).toBeDefined();
    const runId = sessionRow1!.runId;

    // User modifies task
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "also add pagination", id: "2", sessionID, messageID: "msg-2" }] }
    );

    // Verify in-memory state updated
    const memRoute = getRouteDecision(sessionID);
    expect(memRoute?.goal).toBe("Implement REST API for accounts (Modified: also add pagination)");

    // CRITICAL PERSISTENCE TEST: Full cold restart destruction
    await disposeProjectRuntime(dirA);
    _resetRouteState();
    _resetAllTaskState();
    closeAllConnections();

    expect(getRouteDecision(sessionID)).toBeNull();

    // Reopen project runtime from scratch
    const ctx2 = acquireProjectRuntime(dirA);
    await ctx2.adapter.hydrateSessionRoute(sessionID);

    // Assert restored route state in memory
    const restoredRoute = getRouteDecision(sessionID);
    expect(restoredRoute).not.toBeNull();
    expect(restoredRoute?.goal).toBe("Implement REST API for accounts (Modified: also add pagination)");

    // Assert authoritative SQLite events persistence
    const latestDecision = ctx2.runtime.routingDecisionRepository.getLatestDecisionForRun(runId);
    expect(latestDecision).not.toBeNull();
    expect(latestDecision?.decisionVersion).toBe(2);
    const reconstructed = reconstructRouterDecision(latestDecision!);
    expect(reconstructed?.goal).toBe("Implement REST API for accounts (Modified: also add pagination)");
    expect(reconstructed?.lastUserMessageHash).toBe(restoredRoute?.lastUserMessageHash);

    // Assert historical v1 remains available
    const allDecisions = ctx2.runtime.routingDecisionRepository.listDecisionsForRun(runId);
    expect(allDecisions.length).toBe(2);
    expect(allDecisions[0].decisionVersion).toBe(1);
    expect(reconstructRouterDecision(allDecisions[0])?.goal).toBe("Implement REST API for accounts");
    expect(allDecisions[1].decisionVersion).toBe(2);
    expect(reconstructRouterDecision(allDecisions[1])?.goal).toBe("Implement REST API for accounts (Modified: also add pagination)");

    await releaseProjectRuntime(dirA);
  });

  it("16. multiple-modifications-restore-latest-version: v1 -> v2 -> v3 preserves base goal without recursive nesting and restores v3 on restart", async () => {
    const sessionID = "sess-multi-modify";
    const ctx1 = acquireProjectRuntime(dirA);

    // v1
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement API", id: "1", sessionID, messageID: "msg-1" }] }
    );
    const runId = ctx1.runtime.sessionRepo.findById(sessionID)!.runId;

    // v2
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "also add pagination", id: "2", sessionID, messageID: "msg-2" }] }
    );

    // v3
    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "change page size to 50", id: "3", sessionID, messageID: "msg-3" }] }
    );

    // Cold restart
    await disposeProjectRuntime(dirA);
    _resetRouteState();
    closeAllConnections();

    const ctx2 = acquireProjectRuntime(dirA);
    await ctx2.adapter.hydrateSessionRoute(sessionID);

    const latest = ctx2.runtime.routingDecisionRepository.getLatestDecisionForRun(runId);
    expect(latest).not.toBeNull();
    expect(latest?.decisionVersion).toBe(3);
    const rec = reconstructRouterDecision(latest!);
    expect(rec?.goal).toBe("Implement API (Modified: also add pagination; change page size to 50)");

    const all = ctx2.runtime.routingDecisionRepository.listDecisionsForRun(runId);
    expect(all.map(d => d.decisionVersion)).toEqual([1, 2, 3]);

    await releaseProjectRuntime(dirA);
  });

  it("17. modified-message-replay-after-restart: replay of latest modified message after restart is detected as REPLAY without appending version", async () => {
    const sessionID = "sess-replay-test";
    const ctx1 = acquireProjectRuntime(dirA);

    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement API for orders", id: "1", sessionID, messageID: "msg-1" }] }
    );
    const runId = ctx1.runtime.sessionRepo.findById(sessionID)!.runId;

    await ctx1.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "also add pagination", id: "2", sessionID, messageID: "msg-2" }] }
    );

    // Cold restart
    await disposeProjectRuntime(dirA);
    _resetRouteState();
    closeAllConnections();

    const ctx2 = acquireProjectRuntime(dirA);
    await ctx2.adapter.hydrateSessionRoute(sessionID);

    // Re-send exact same modification message
    await ctx2.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "also add pagination", id: "3", sessionID, messageID: "msg-3" }] }
    );

    // Must NOT create a 3rd version because intent was REPLAY
    const latest = ctx2.runtime.routingDecisionRepository.getLatestDecisionForRun(runId);
    expect(latest?.decisionVersion).toBe(2);

    await releaseProjectRuntime(dirA);
  });

  it("18. modify-material-route-change-policy: material execution class change supersedes run via canonical cancellation and starts new run", async () => {
    const sessionID = "sess-material-change";
    const ctx = acquireProjectRuntime(dirA);

    // Initial: small endpoint (STANDARD)
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement new feature endpoint for products", id: "1", sessionID, messageID: "msg-1" }] }
    );
    const runIdA = ctx.runtime.sessionRepo.findById(sessionID)!.runId;
    const initialRun = await ctx.runtime.services.runRepo.findById(runIdA);
    expect(initialRun?.runType).toBe("planned");

    // Modification that materially changes complexity/domain to parallel multi-domain execution
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "change plan to rebuild frontend UI in react and backend in node simultaneously", id: "2", sessionID, messageID: "msg-2" }] }
    );

    // Old run must be cancelled/superseded
    const oldRun = await ctx.runtime.services.runRepo.findById(runIdA);
    expect(oldRun?.status).toBe("cancelled");

    // New run B must be active and bound to session
    const newSessionRow = ctx.runtime.sessionRepo.findById(sessionID)!;
    expect(newSessionRow.runId).not.toBe(runIdA);
    const newRun = await ctx.runtime.services.runRepo.findById(newSessionRow.runId);
    expect(newRun?.status).toBe("pending");
    expect(newRun?.runType).toBe("delegated");

    await releaseProjectRuntime(dirA);
  });

  it("19. cancel-uses-run-service-cleanup: cancelRun invokes ExecutionRegistry cleanup callbacks and unregisters run", async () => {
    const sessionID = "sess-cancel-cleanup";
    const ctx = acquireProjectRuntime(dirA);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement inventory management system", id: "1", sessionID, messageID: "msg-1" }] }
    );
    const runId = ctx.runtime.sessionRepo.findById(sessionID)!.runId;

    // Register active execution with cleanup callback in ExecutionRegistry
    let cleanupInvoked = false;
    const handle = ctx.runtime.executionRegistry.registerRun(runId, new AbortController(), () => {
      cleanupInvoked = true;
    });
    // Mark execution stopped so cleanup proceeds
    handle.resolveExecution?.();

    expect(ctx.runtime.executionRegistry.hasActiveRun(runId)).toBe(true);

    // Send cancel turn
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "cancel this task", id: "2", sessionID, messageID: "msg-2" }] }
    );

    expect(cleanupInvoked).toBe(true);
    expect(ctx.runtime.executionRegistry.hasActiveRun(runId)).toBe(false);
    const run = await ctx.runtime.services.runRepo.findById(runId);
    expect(run?.status).toBe("cancelled");
    expect(getRouteDecision(sessionID)?.active).toBe(false);

    await releaseProjectRuntime(dirA);
  });

  it("20. replace-uses-run-service-cleanup: REPLACE invokes canonical cancelRun cleanup on old run before starting replacement run", async () => {
    const sessionID = "sess-replace-cleanup";
    const ctx = acquireProjectRuntime(dirA);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement payment gateway integration across checkout routes and backend services", id: "1", sessionID, messageID: "msg-1" }] }
    );
    const runIdA = ctx.runtime.sessionRepo.findById(sessionID)!.runId;

    let runACleanedUp = false;
    const handle = ctx.runtime.executionRegistry.registerRun(runIdA, new AbortController(), () => {
      runACleanedUp = true;
    });
    handle.resolveExecution?.();

    // User replaces task with a security audit
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "stop that and perform a security audit instead", id: "2", sessionID, messageID: "msg-2" }] }
    );

    expect(runACleanedUp).toBe(true);
    expect(ctx.runtime.executionRegistry.hasActiveRun(runIdA)).toBe(false);
    const runA = await ctx.runtime.services.runRepo.findById(runIdA);
    expect(runA?.status).toBe("cancelled");

    const sessionRowB = ctx.runtime.sessionRepo.findById(sessionID)!;
    expect(sessionRowB.runId).not.toBe(runIdA);
    const runB = await ctx.runtime.services.runRepo.findById(sessionRowB.runId);
    expect(runB?.status).toBe("pending");

    await releaseProjectRuntime(dirA);
  });

  it("21. replace-pattern-wins-over-generic-stop: replacement phrases with stop/cancel words match REPLACE instead of CANCEL", () => {
    expect(classifyUserTurnIntent({ newMessage: "stop" }).intent).toBe("CANCEL");
    expect(classifyUserTurnIntent({ newMessage: "stop this task" }).intent).toBe("CANCEL");
    expect(classifyUserTurnIntent({ newMessage: "stop that and perform security audit" }).intent).toBe("REPLACE");
    expect(classifyUserTurnIntent({ newMessage: "cancel that and instead build X" }).intent).toBe("REPLACE");
    expect(classifyUserTurnIntent({ newMessage: "forget that, audit security" }).intent).toBe("REPLACE");
  });

  it("22. acknowledgement-does-not-modify-goal: conversational acknowledgements preserve active run and do not mutate goal", async () => {
    const sessionID = "sess-ack-test";
    const ctx = acquireProjectRuntime(dirA);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement user authentication", id: "1", sessionID, messageID: "msg-1" }] }
    );
    const runId = ctx.runtime.sessionRepo.findById(sessionID)!.runId;
    const initialDecision = ctx.runtime.routingDecisionRepository.getLatestDecisionForRun(runId);

    const acks = ["thanks", "okay", "ok", "sounds good", "got it", "great", "yes", "understood"];
    for (const ack of acks) {
      await ctx.adapter.onChatMessage(
        { sessionID, agent: "heidi" },
        { message: {} as any, parts: [{ type: "text", text: ack, id: "ack", sessionID, messageID: `msg-ack-${ack}` }] }
      );
      // Goal must remain unmodified
      const route = getRouteDecision(sessionID);
      expect(route?.goal).toBe("Implement user authentication");
      // Decision version must remain 1
      const latest = ctx.runtime.routingDecisionRepository.getLatestDecisionForRun(runId);
      expect(latest?.decisionVersion).toBe(initialDecision?.decisionVersion);
    }

    await releaseProjectRuntime(dirA);
  });

  it("23. ambiguous-message-does-not-modify-goal: ambiguous non-instructional messages do not mutate durable task state", async () => {
    const sessionID = "sess-ambiguous-test";
    const ctx = acquireProjectRuntime(dirA);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement billing invoice export", id: "1", sessionID, messageID: "msg-1" }] }
    );
    const runId = ctx.runtime.sessionRepo.findById(sessionID)!.runId;

    // Ambiguous message without modification/replace/cancel keywords
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Let me check the logs on my machine first", id: "2", sessionID, messageID: "msg-2" }] }
    );

    const route = getRouteDecision(sessionID);
    expect(route?.goal).toBe("Implement billing invoice export");
    const latest = ctx.runtime.routingDecisionRepository.getLatestDecisionForRun(runId);
    expect(latest?.decisionVersion).toBe(1);

    await releaseProjectRuntime(dirA);
  });

  it("24. complete-code-mode-telemetry-validation: valid full CodeModeTelemetry is accepted", () => {
    const valid = {
      codeModeConsidered: true,
      codeModeSelected: true,
      codeModeRejectedReason: "NOT_MCP_COMPOSITION" as const,
      estimatedToolCalls: 5,
      estimatedParallelWidth: 2,
      estimatedDependencyStages: 1,
      actualToolCalls: 4,
      actualDurationMs: 120.5,
      actualResultBytes: 1024,
      terminalStatus: "success" as const,
    };
    expect(isCodeModeTelemetry(valid)).toBe(true);
  });

  it("25. malformed-code-mode-numeric-field-rejected: string numeric fields in CodeModeTelemetry are rejected", () => {
    const invalid = {
      codeModeConsidered: true,
      codeModeSelected: true,
      estimatedToolCalls: "10",
    };
    expect(isCodeModeTelemetry(invalid)).toBe(false);
  });

  it("26. invalid-code-mode-terminal-status-rejected: non-standard terminalStatus is rejected", () => {
    const invalid = {
      codeModeConsidered: true,
      codeModeSelected: true,
      terminalStatus: "finished",
    };
    expect(isCodeModeTelemetry(invalid)).toBe(false);
  });

  it("27. invalid-code-mode-rejection-reason-rejected: invalid codeModeRejectedReason is rejected", () => {
    const invalid = {
      codeModeConsidered: true,
      codeModeSelected: false,
      codeModeRejectedReason: "INVALID_REASON",
    };
    expect(isCodeModeTelemetry(invalid)).toBe(false);
  });

  it("28. recommendation-only-specialist-routing-cannot-activate: recommendation-only SPECIALIST routing fails closed on activation", () => {
    const decision = buildCanonicalRoutingDecision({
      runId: "run-spec-rec",
      decision: {
        executionClass: "SPECIALIST",
        specialists: ["SECURITY"],
        reason: "Security audit recommendation",
        reasonCode: "SPECIALIST_SECURITY",
        confidence: 0.9,
        forcedByExplicitSignal: false,
      },
      goal: "Run security audit",
      lastUserMessageHash: "hash-spec",
    });
    expect(decision.routingMode).toBe("recommendation");

    const service = new AuthoritativeRoutingService({ savePlan: () => { throw new Error("must not persist") } } as never);
    const result = service.activate(decision, decision.sourceSha, dummyActivationEvidence);
    expect(result.fallback).toBe(true);
    expect((result as { reason: string }).reason).toContain("RECOMMENDATION_ONLY");
  });

  it("29. recommendation-only-parallel-routing-cannot-activate: recommendation-only PARALLEL_SPECIALISTS routing fails closed on activation", () => {
    const decision = buildCanonicalRoutingDecision({
      runId: "run-par-rec",
      decision: {
        executionClass: "PARALLEL_SPECIALISTS",
        specialists: ["UI", "BACKEND"],
        reason: "Parallel components",
        reasonCode: "PARALLEL_SPECIALISTS_DISJOINT",
        confidence: 0.9,
        forcedByExplicitSignal: false,
      },
      goal: "Build frontend and backend",
      lastUserMessageHash: "hash-par",
    });
    expect(decision.routingMode).toBe("recommendation");

    const service = new AuthoritativeRoutingService({ savePlan: () => { throw new Error("must not persist") } } as never);
    const result = service.activate(decision, decision.sourceSha, dummyActivationEvidence);
    expect(result.fallback).toBe(true);
    expect((result as { reason: string }).reason).toContain("RECOMMENDATION_ONLY");
  });

  it("30. routing-decision-version-increments-atomically: multiple decisions on same run have monotonically increasing versions", () => {
    const ctx = acquireProjectRuntime(dirA);
    const repo = ctx.runtime.routingDecisionRepository;
    const runId = "run-version-atomic";

    const d1 = buildCanonicalRoutingDecision({ runId, decision: { executionClass: "STANDARD", reason: "r1", reasonCode: "rc1", confidence: 0.8, forcedByExplicitSignal: false }, goal: "g1", lastUserMessageHash: "h1" });
    const p1 = repo.saveDecision(d1);
    expect(p1.decisionVersion).toBe(1);

    const d2 = buildCanonicalRoutingDecision({ runId, decision: { executionClass: "STANDARD", reason: "r2", reasonCode: "rc2", confidence: 0.8, forcedByExplicitSignal: false }, goal: "g2", lastUserMessageHash: "h2" });
    const p2 = repo.saveDecision(d2);
    expect(p2.decisionVersion).toBe(2);

    const d3 = buildCanonicalRoutingDecision({ runId, decision: { executionClass: "STANDARD", reason: "r3", reasonCode: "rc3", confidence: 0.8, forcedByExplicitSignal: false }, goal: "g3", lastUserMessageHash: "h3" });
    const p3 = repo.saveDecision(d3);
    expect(p3.decisionVersion).toBe(3);

    const all = repo.listDecisionsForRun(runId);
    expect(all.map(d => d.decisionVersion)).toEqual([1, 2, 3]);
  });

  it("31. latest-routing-version-selected-after-restart: latest version is deterministically selected after DB reopen", async () => {
    const ctx1 = acquireProjectRuntime(dirA);
    const runId = "run-version-restart";

    ctx1.runtime.routingDecisionRepository.saveDecision(
      buildCanonicalRoutingDecision({ runId, decision: { executionClass: "STANDARD", reason: "r1", reasonCode: "rc1", confidence: 0.8, forcedByExplicitSignal: false }, goal: "task v1", lastUserMessageHash: "h1" })
    );
    ctx1.runtime.routingDecisionRepository.saveDecision(
      buildCanonicalRoutingDecision({ runId, decision: { executionClass: "STANDARD", reason: "r2", reasonCode: "rc2", confidence: 0.8, forcedByExplicitSignal: false }, goal: "task v2", lastUserMessageHash: "h2" })
    );
    ctx1.runtime.routingDecisionRepository.saveDecision(
      buildCanonicalRoutingDecision({ runId, decision: { executionClass: "STANDARD", reason: "r3", reasonCode: "rc3", confidence: 0.8, forcedByExplicitSignal: false }, goal: "task v3", lastUserMessageHash: "h3" })
    );

    await disposeProjectRuntime(dirA);
    closeAllConnections();

    const ctx2 = acquireProjectRuntime(dirA);
    const latest = ctx2.runtime.routingDecisionRepository.getLatestDecisionForRun(runId);
    expect(latest).not.toBeNull();
    expect(latest?.decisionVersion).toBe(3);
    expect(reconstructRouterDecision(latest!)?.goal).toBe("task v3");

    await releaseProjectRuntime(dirA);
  });

  it("32. cancel-vs-completion-race: RunService.cancelRun preserves COMPLETED terminal state when race occurs", async () => {
    const ctx = acquireProjectRuntime(dirA);
    const run = await ctx.runtime.services.runService.createRun({
      runType: "simple",
      sessionId: "sess-race",
      agentId: "heidi",
      correlationId: "corr-race-1",
    });

    // Simulate run completing before cancellation proceeds
    await ctx.runtime.services.runService.updateRun(run.id, {
      status: RunStatus.COMPLETED,
      stage: "completed",
    });

    // Attempt to cancel already-completed run
    try {
      await ctx.runtime.services.runService.cancelRun(run.id, "Late cancel");
    } catch (err: any) {
      expect(err.code).toBe("RUN_IN_TERMINAL_STATE");
    }

    const finalState = await ctx.runtime.services.runRepo.findById(run.id);
    expect(finalState?.status).toBe("completed");

    await releaseProjectRuntime(dirA);
  });
});
