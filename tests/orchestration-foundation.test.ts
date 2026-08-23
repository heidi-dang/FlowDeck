import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateProjectRuntime,
  getProjectRuntime,
  disposeProjectRuntime,
  _resetAllProjectRuntimes,
} from "../src/runtime/project-registry";
import { getSessionMetricsDiagnostics, cleanupSessionState } from "../src/index";
import { _resetRouteState, getRouteDecision } from "../src/services/heidi-route-state";
import { closeAllConnections } from "../src/orchestration/persistence/connection";
import { RunStatus } from "../src/orchestration/types/runs";

describe("FlowDeck Orchestration Foundation Integration Tests", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    await _resetAllProjectRuntimes();
    closeAllConnections();
    _resetRouteState();
    dirA = mkdtempSync(join(tmpdir(), "fdx-test-a-"));
    dirB = mkdtempSync(join(tmpdir(), "fdx-test-b-"));
  });

  afterEach(async () => {
    await _resetAllProjectRuntimes();
    closeAllConnections();
    _resetRouteState();
    try { rmSync(dirA, { recursive: true, force: true }); } catch {}
    try { rmSync(dirB, { recursive: true, force: true }); } catch {}
  });

  it("1. runtime-project-isolation: project A and B have separate databases and runtimes", async () => {
    const ctxA = getOrCreateProjectRuntime(dirA);
    const ctxB = getOrCreateProjectRuntime(dirB);

    expect(ctxA.runtime).not.toBe(ctxB.runtime);
    expect(ctxA.dbPath).toContain(dirA);
    expect(ctxB.dbPath).toContain(dirB);
    expect(existsSync(ctxA.dbPath)).toBe(true);
    expect(existsSync(ctxB.dbPath)).toBe(true);

    // Dispose A does not affect B
    await disposeProjectRuntime(dirA);
    expect(getProjectRuntime(dirA)).toBeNull();
    expect(getProjectRuntime(dirB)).not.toBeNull();
  });

  it("2. runtime-reload: dispose and re-initialize same project directory cleanly", async () => {
    const ctx1 = getOrCreateProjectRuntime(dirA);
    const dbPath1 = ctx1.dbPath;
    await disposeProjectRuntime(dirA);
    expect(getProjectRuntime(dirA)).toBeNull();

    const ctx2 = getOrCreateProjectRuntime(dirA);
    expect(ctx2.dbPath).toBe(dbPath1);
    expect(ctx2.disposed).toBe(false);
  });

  it("3. routing-persistence-roundtrip: classify, persist, destroy memory, reopen DB, restore exact ExecutionClass", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
    const adapter = ctx.adapter;

    const messageText = "We need frontend UI in react and backend in node simultaneously";
    await adapter.onChatMessage(
      { sessionID: "sess-roundtrip-1", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: messageText, id: "1", sessionID: "sess-roundtrip-1", messageID: "msg-1" }] }
    );

    const initialRoute = getRouteDecision("sess-roundtrip-1");
    expect(initialRoute).not.toBeNull();
    expect(initialRoute?.decision.executionClass).toBe("PARALLEL_SPECIALISTS");

    // Clear all in-memory registries
    _resetRouteState();
    expect(getRouteDecision("sess-roundtrip-1")).toBeNull();

    // Re-hydrate directly from SQLite
    await adapter.hydrateSessionRoute("sess-roundtrip-1");
    const restored = getRouteDecision("sess-roundtrip-1");
    expect(restored).not.toBeNull();
    expect(restored?.decision.executionClass).toBe("PARALLEL_SPECIALISTS");
    expect(restored?.goal).toBe(messageText);
  });

  it("4. session-run-affinity-roundtrip: persist session/run, restart, recover correct binding", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
    const adapter = ctx.adapter;

    await adapter.onChatMessage(
      { sessionID: "sess-affinity-test", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor backend architecture across all services", id: "1", sessionID: "sess-affinity-test", messageID: "msg-1" }] }
    );

    const sessionRow = ctx.runtime.sessionRepo.findById("sess-affinity-test");
    expect(sessionRow).toBeDefined();
    expect(sessionRow?.agentId).toBe("heidi");

    // Reopen in a new runtime instance over same DB
    await disposeProjectRuntime(dirA);
    _resetRouteState();

    const freshCtx = getOrCreateProjectRuntime(dirA);
    const recoveredSession = freshCtx.runtime.sessionRepo.findById("sess-affinity-test");
    expect(recoveredSession).toBeDefined();
    expect(recoveredSession?.runId).toBe(sessionRow?.runId);

    await freshCtx.adapter.hydrateSessionRoute("sess-affinity-test");
    const restoredRoute = getRouteDecision("sess-affinity-test");
    expect(restoredRoute).not.toBeNull();
    expect(restoredRoute?.decision.executionClass).toBe("SPECIALIST");
  });

  it("5. same-session-new-run: task A then task B in same session; B becomes active, A remains history", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
    const adapter = ctx.adapter;

    // Task A: complex planning task
    await adapter.onChatMessage(
      { sessionID: "sess-multi-task", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Implement a new OAuth authentication flow across multiple files", id: "1", sessionID: "sess-multi-task", messageID: "msg-1" }] }
    );

    const sessionA = ctx.runtime.sessionRepo.findById("sess-multi-task");
    expect(sessionA).toBeDefined();
    const runIdA = sessionA!.runId;
    expect(runIdA).toBeDefined();

    // Mark Run A complete in database
    await ctx.runtime.services.runService.updateRun(runIdA, { status: RunStatus.COMPLETED, stage: "completed" });

    // Task B in same OpenCode session
    _resetRouteState(); // Simulates new turn or reload
    await adapter.onChatMessage(
      { sessionID: "sess-multi-task", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Security audit on permissions and roles across modules", id: "2", sessionID: "sess-multi-task", messageID: "msg-2" }] }
    );

    const sessionB = ctx.runtime.sessionRepo.findById("sess-multi-task");
    expect(sessionB).toBeDefined();
    const runIdB = sessionB!.runId;
    expect(runIdB).toBeDefined();
    expect(runIdB).not.toBe(runIdA);

    // Check Run A still exists in history
    const runA = await ctx.runtime.services.runRepo.findById(runIdA);
    expect(runA).not.toBeNull();
    expect(runA?.status).toBe(RunStatus.COMPLETED);

    // Check Run B is active
    const runB = await ctx.runtime.services.runRepo.findById(runIdB);
    expect(runB).not.toBeNull();
    expect(runB?.status).toBe(RunStatus.PENDING);
  });

  it("6. terminal-run-not-restored: terminal run is not restored as active route", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
    const adapter = ctx.adapter;

    await adapter.onChatMessage(
      { sessionID: "sess-terminal", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Security vulnerability audit on all endpoints", id: "1", sessionID: "sess-terminal", messageID: "msg-1" }] }
    );

    const sessionRow = ctx.runtime.sessionRepo.findById("sess-terminal");
    expect(sessionRow).toBeDefined();
    await ctx.runtime.services.runService.updateRun(sessionRow!.runId, { status: RunStatus.COMPLETED, stage: "completed" });

    _resetRouteState();
    await adapter.hydrateSessionRoute("sess-terminal");

    expect(getRouteDecision("sess-terminal")).toBeNull();
  });

  it("7. missing-run-binding-safe: session pointing to non-existent run fails safely without fabrication", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
    // Disable FK temporarily to simulate orphaned data or corruption
    ctx.runtime.db.run("PRAGMA foreign_keys = OFF");
    ctx.runtime.db.run("INSERT INTO agent_sessions (id, run_id, agent_id, started_at) VALUES ('sess-corrupt', 'non-existent-run', 'heidi', datetime('now'))");
    ctx.runtime.db.run("PRAGMA foreign_keys = ON");

    _resetRouteState();
    await ctx.adapter.hydrateSessionRoute("sess-corrupt");
    expect(getRouteDecision("sess-corrupt")).toBeNull();
  });

  it("8. missing-routing-decision-safe: run without routing decision fails safely without fabrication", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
    const run = await ctx.runtime.services.runService.createRun({
      runType: "simple",
      correlationId: "c-1",
      sessionId: "sess-no-rd"
    });

    ctx.runtime.sessionRepo.create({
      id: "sess-no-rd",
      runId: run.id,
      agentId: "heidi"
    });

    _resetRouteState();
    await ctx.adapter.hydrateSessionRoute("sess-no-rd");
    expect(getRouteDecision("sess-no-rd")).toBeNull();
  });

  it("9. duplicate-chat-message-idempotent: exact duplicate user message does not create new run", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
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

  it("10. session-cleanup-preserves-history: cleanupSessionState clears in-memory route but keeps DB row", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
    const adapter = ctx.adapter;

    await adapter.onChatMessage(
      { sessionID: "sess-cleanup", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Security pentest across all endpoints", id: "1", sessionID: "sess-cleanup", messageID: "msg-1" }] }
    );

    expect(getRouteDecision("sess-cleanup")).not.toBeNull();
    cleanupSessionState("sess-cleanup");
    expect(getRouteDecision("sess-cleanup")).toBeNull();

    // Durable DB row still exists
    const sessionRow = ctx.runtime.sessionRepo.findById("sess-cleanup");
    expect(sessionRow).toBeDefined();
  });

  it("11. session-diagnostics-real-values: tool call updates appear accurately in session metrics", async () => {
    const ctx = getOrCreateProjectRuntime(dirA);
    const adapter = ctx.adapter;

    await adapter.onChatMessage(
      { sessionID: "sess-diag", agent: "heidi" },
      { message: {} as any, parts: [{ type: "text", text: "Review PR diff across multiple services", id: "1", sessionID: "sess-diag", messageID: "msg-1" }] }
    );

    // Simulate tool executions
    await adapter.onToolExecuteAfter({ tool: "grep", sessionID: "sess-diag", callID: "c1", args: {} }, { output: "ok", metadata: {} });
    await adapter.onToolExecuteAfter({ tool: "read", sessionID: "sess-diag", callID: "c2", args: {} }, { output: "ok", metadata: {} });

    const diag = getSessionMetricsDiagnostics("sess-diag", dirA);
    expect(diag.toolCalls).toBe(2);
    expect(diag.sessionID).toBe("sess-diag");
    expect(diag.status).toBe("running");
  });

  it("12. fresh-project-db-bootstrap: creates .flowdeck directory and initializes schema automatically", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "fdx-fresh-"));
    const ctx = getOrCreateProjectRuntime(freshDir);
    expect(existsSync(join(freshDir, ".flowdeck", "flowdeck.db"))).toBe(true);
    expect(ctx.runtime.db).toBeDefined();
    rmSync(freshDir, { recursive: true, force: true });
  });
});
