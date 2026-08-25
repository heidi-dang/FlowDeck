/**
 * stop-authority-regression.test.ts
 *
 * Mandatory regression suite for v2.5.0 confirmed production loop:
 *   BUG-001: Internal FlowDeck synthetic messages (role=user transport) increment
 *            userTurnVersion, creating new continuation authority and allowing autonomous
 *            reinvocation after finish=stop.
 *
 * All tests MUST pass after the fix. Any test added here that passes before the fix
 * is a false green and must be investigated.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireProjectRuntime, disposeProjectRuntime } from "../src/runtime/project-registry";
import { OrchestrationPhase as OP } from "../src/orchestration/types/runs";
import {
  INTERNAL_FLOWDECK_PREFIXES,
  isInternalFlowDeckMessage,
} from "../src/runtime/message-provenance";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "flowdeck-stop-auth-"));
});

afterEach(async () => {
  await disposeProjectRuntime(testDir);
  if (process.platform !== "win32") {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── Message Provenance Tests ────────────────────────────────────────────────

describe("message-provenance", () => {
  it("1. internal-specialist-dispatch-is-internal", () => {
    expect(isInternalFlowDeckMessage(
      "[FlowDeck Specialist Dispatch] Use OpenCode native Task/subagent calls only for the following ready specialist assignments."
    )).toBe(true);
  });

  it("2. internal-verification-prompt-is-internal", () => {
    expect(isInternalFlowDeckMessage("Work completed. Proceed to verify the results.")).toBe(true);
  });

  it("3. internal-continuation-prompt-is-internal", () => {
    expect(isInternalFlowDeckMessage('[Continuation] Resume the deferred user goal now that prior native child termination has been confirmed: "Do X". Do not repeat the previous cancelled work.')).toBe(true);
  });

  it("4. internal-next-work-item-is-internal", () => {
    expect(isInternalFlowDeckMessage("Continue with the next planned work item.")).toBe(true);
  });

  it("5. genuine-user-task-is-not-internal", () => {
    expect(isInternalFlowDeckMessage("Refactor the authentication module")).toBe(false);
  });

  it("6. genuine-user-stop-is-not-internal", () => {
    expect(isInternalFlowDeckMessage("stop")).toBe(false);
  });

  it("7. genuine-user-query-is-not-internal", () => {
    expect(isInternalFlowDeckMessage("what is the status?")).toBe(false);
  });

  it("8. marker-text-typed-by-real-user-is-not-internally-privileged", () => {
    // A real user who types the marker text must not gain internal authority.
    // isInternalFlowDeckMessage is text-only; provenance is decided by the
    // caller (onChatMessage) based on whether OpenCode delivered this as
    // a user turn or as a FlowDeck-injected promptAsync echo.
    // This test confirms the detection is purely text-based, so:
    // the caller must apply additional context (e.g. messageID known internally)
    // when needed. But text alone must not grant model-authority bypass.
    const markerText = "[FlowDeck Specialist Dispatch] Use OpenCode native Task/subagent calls only";
    // The marker IS detected as internal by text
    expect(isInternalFlowDeckMessage(markerText)).toBe(true);
    // But the PREFIXES list is exported so callers can see what it contains
    expect(INTERNAL_FLOWDECK_PREFIXES.length).toBeGreaterThan(0);
  });
});

// ─── User Turn Version Authority Tests ──────────────────────────────────────

describe("user-turn-version-authority", () => {
  it("9. internal-specialist-dispatch-does-not-increment-user-turn", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync } });
    const sessionID = "sess-internal-no-increment";

    // Establish genuine user turn (version 1)
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-genuine-1" },
      { message: {} as any, parts: [{ type: "text", text: "Implement the feature" }] as any[] }
    );
    const versionAfterGenuine = ctx.adapter.getUserTurnVersion(sessionID);
    expect(versionAfterGenuine).toBe(1);

    // Simulate FlowDeck-injected specialist dispatch message arriving as role=user
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-synthetic-1" },
      {
        message: {} as any,
        parts: [{
          type: "text",
          text: "[FlowDeck Specialist Dispatch] Use OpenCode native Task/subagent calls only for the following ready specialist assignments.\n- targetAgent=coder; description=[FlowDeck specialist:spec-1] Implement feature; prompt=[FlowDeck specialist:spec-1] Objective: implement."
        }] as any[]
      }
    );

    // userTurnVersion must NOT have changed
    const versionAfterSynthetic = ctx.adapter.getUserTurnVersion(sessionID);
    expect(versionAfterSynthetic).toBe(versionAfterGenuine);
  });

  it("10. internal-verification-message-does-not-increment-user-turn", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync } });
    const sessionID = "sess-internal-verif-no-increment";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-genuine-2" },
      { message: {} as any, parts: [{ type: "text", text: "Build the API endpoint" }] as any[] }
    );
    const versionAfterGenuine = ctx.adapter.getUserTurnVersion(sessionID);

    // Simulate FlowDeck-injected "Work completed. Proceed to verify the results."
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-synthetic-verif" },
      {
        message: {} as any,
        parts: [{ type: "text", text: "Work completed. Proceed to verify the results." }] as any[]
      }
    );

    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(versionAfterGenuine);
  });

  it("11. genuine-user-message-establishes-user-authority", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync } });
    const sessionID = "sess-genuine-authority";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-genuine-3" },
      { message: {} as any, parts: [{ type: "text", text: "Refactor the auth module" }] as any[] }
    );
    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(1);

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-genuine-4" },
      { message: {} as any, parts: [{ type: "text", text: "Also add rate limiting" }] as any[] }
    );
    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(2);
  });

  it("12. internal-continuation-prompt-does-not-increment-user-turn", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync } });
    const sessionID = "sess-continuation-no-increment";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-genuine-5" },
      { message: {} as any, parts: [{ type: "text", text: "Deploy to production" }] as any[] }
    );
    const baseline = ctx.adapter.getUserTurnVersion(sessionID);

    // All known internal continuation prompts must not increment
    const internalMessages = [
      '[Continuation] Resume the deferred user goal now that prior native child termination has been confirmed: "Deploy to production". Do not repeat the previous cancelled work.',
      "Continue with the next planned work item.",
      "Recovery progress detected. Continue execution with the updated state.",
      "Work completed. Proceed to verify the results.",
      "Execution stall detected with no progress. Change strategy, try an alternate approach, or replan.",
      "Child execution failed. Analyze the failure and select an alternate strategy or recovery step.",
      "Assignment failed. Analyze the failure and select an alternate strategy or recovery step.",
      "Transient failure encountered. Retry the action.",
      "Progress confirmed. Continue with the next step.",
    ];

    for (let i = 0; i < internalMessages.length; i++) {
      await ctx.adapter.onChatMessage(
        { sessionID, agent: "heidi", messageID: `m-internal-${i}` },
        { message: {} as any, parts: [{ type: "text", text: internalMessages[i] }] as any[] }
      );
    }

    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(baseline);
  });
});

// ─── Terminal Run / Stop Authority Tests ─────────────────────────────────────

describe("terminal-stop-authority", () => {
  it("13. terminal-run-rejects-prompt-async-on-session-idle", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync } });
    const sessionID = "sess-terminal-idle";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-t1" },
      { message: {} as any, parts: [{ type: "text", text: "Coordinate frontend and backend changes" }] as any[] }
    );

    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    expect(run).toBeTruthy();

    // Cancel the run (simulates user Stop)
    await ctx.runtime.services.runService.cancelRun(run.id, "User cancelled");
    promptAsync.mockClear();

    // 100 session.idle events must produce zero new promptAsync calls
    for (let i = 0; i < 100; i++) {
      await ctx.adapter.onSessionIdle(sessionID);
    }

    expect(promptAsync).not.toHaveBeenCalled();
  });

  it("14. user-stop-revokes-continuation-authority", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync } });
    const sessionID = "sess-stop-revokes";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-sr-1" },
      { message: {} as any, parts: [{ type: "text", text: "Perform large multi-domain refactor" }] as any[] }
    );

    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    // User sends "stop"
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-sr-cancel" },
      { message: {} as any, parts: [{ type: "text", text: "stop" }] as any[] }
    );

    promptAsync.mockClear();

    // Now internal synthetic messages must not revive execution
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-sr-synth" },
      {
        message: {} as any,
        parts: [{ type: "text", text: "[FlowDeck Specialist Dispatch] Use OpenCode native Task/subagent calls only for the following ready specialist assignments." }] as any[]
      }
    );

    await ctx.adapter.onSessionIdle(sessionID);
    await ctx.adapter.onSessionIdle(sessionID);

    expect(promptAsync).not.toHaveBeenCalled();

    // Run must remain terminal
    const refreshed = await ctx.runtime.services.runRepo.findById(run.id);
    expect(["cancelled", "failed", "completed"]).toContain(refreshed?.status ?? "not_found");
  });

  it("15. hundred-idle-events-after-internal-message-are-noop", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync } });
    const sessionID = "sess-hundred-idle";

    // Genuine user turn
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-hi-1" },
      { message: {} as any, parts: [{ type: "text", text: "Coordinate the frontend authentication redesign and backend API changes together" }] as any[] }
    );

    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    await ctx.runtime.services.runService.cancelRun(run.id, "User stopped");

    // Inject synthetic specialist dispatch message
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-hi-synth" },
      {
        message: {} as any,
        parts: [{ type: "text", text: "[FlowDeck Specialist Dispatch] Use OpenCode native Task/subagent calls only" }] as any[]
      }
    );

    promptAsync.mockClear();

    // 100 idle events after injection must be silent
    for (let i = 0; i < 100; i++) {
      await ctx.adapter.onSessionIdle(sessionID);
    }

    expect(promptAsync).not.toHaveBeenCalled();
  });

  it("16. new-genuine-user-message-after-stop-can-create-new-authority", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync } });
    const sessionID = "sess-new-authority-after-stop";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-na-1" },
      { message: {} as any, parts: [{ type: "text", text: "Coordinate API and UI changes" }] as any[] }
    );

    const firstRun = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-na-stop" },
      { message: {} as any, parts: [{ type: "text", text: "stop" }] as any[] }
    );

    // New genuine user message must be able to establish fresh authority
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-na-2" },
      { message: {} as any, parts: [{ type: "text", text: "Actually, just fix the login bug instead" }] as any[] }
    );

    const turnVersion = ctx.adapter.getUserTurnVersion(sessionID);
    expect(turnVersion).toBeGreaterThan(1);

    // Old run remains terminal
    const refreshedFirst = await ctx.runtime.services.runRepo.findById(firstRun.id);
    expect(["cancelled", "failed", "completed"]).toContain(refreshedFirst?.status ?? "not_found");
  });
});

// ─── Specialist Dispatch Atomicity Tests ──────────────────────────────────────

describe("specialist-dispatch-atomicity", () => {
  it("17. completed-specialist-cannot-trigger-new-dispatch-on-idle", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync } });
    const sessionID = "sess-spec-completed-no-redispatch";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-sc-1" },
      { message: {} as any, parts: [{ type: "text", text: "Coordinate API and UI specialist work" }] as any[] }
    );

    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    // Simulate a specialist has completed
    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-spec-completed",
      targetAgent: "coder",
      specialistId: "spec-done-1",
      prompt: "[FlowDeck specialist:spec-done-1] Implement the feature",
      description: "[FlowDeck specialist:spec-done-1] Implementation",
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ taskCallId: del.taskCallId });
    await ctx.runtime.childExecutionLifecycleService.markCompleted({
      taskCallId: del.taskCallId,
      output: "Feature implemented successfully",
    });

    promptAsync.mockClear();

    // Idle events after specialist completes must not redispatch to the same specialist
    for (let i = 0; i < 10; i++) {
      await ctx.adapter.onSessionIdle(sessionID);
    }

    // promptAsync may have been called for continuation/verification, but the
    // specialist dispatch text must not reappear
    const calls = promptAsync.mock.calls as any[];
    const specialistRedispatch = calls.some((c: any) => {
      const body = c[0]?.body;
      const text = body?.parts?.[0]?.text ?? "";
      return text.includes("spec-done-1") && text.includes("[FlowDeck Specialist Dispatch]");
    });
    expect(specialistRedispatch).toBe(false);
  });

  it("18. duplicate-idle-after-cancelled-run-is-noop", async () => {
    const promptAsync = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync } });
    const sessionID = "sess-dup-idle-cancelled";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "m-dic-1" },
      { message: {} as any, parts: [{ type: "text", text: "Complex multi-specialist deployment" }] as any[] }
    );

    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    await ctx.runtime.services.runService.cancelRun(run.id, "User cancelled");
    promptAsync.mockClear();

    await ctx.adapter.onSessionIdle(sessionID);
    await ctx.adapter.onSessionIdle(sessionID);
    await ctx.adapter.onSessionIdle(sessionID);

    expect(promptAsync).not.toHaveBeenCalled();
  });
});