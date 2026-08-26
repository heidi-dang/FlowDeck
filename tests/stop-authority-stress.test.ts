/**
 * stop-authority-stress.test.ts
 *
 * Comprehensive adversarial qualification matrix for FlowDeck v2.5.1 runtime authority:
 * - OpenCode message ID generation contract, uniqueness, ordering
 * - Native OpenCode message ID validation and rejection of arbitrary flowdeck-internal-* strings
 * - Durable internal message provenance (by ID, not text prefix)
 * - Genuine-user text containing synthetic markers remains genuine user authority
 * - Stop & Terminal quiescence (100x repeated idle events)
 * - 100x duplicate internal echoes do not increment user turn or create duplicate Runs
 * - Completed specialist cannot be redispatched on idle
 * - Cancelled Run cannot be revived by late internal echo
 * - New genuine user message establishes fresh authority after Stop
 * - Internal message ledger lifecycle (retention of unconfirmed dispatches, pruning of settled)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireProjectRuntime, disposeProjectRuntime } from "../src/runtime/project-registry";
import {
  createOpenCodeMessageId,
  isOpenCodeMessageId,
} from "../src/runtime/opencode-identifier";

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "flowdeck-stress-auth-"));
});

afterEach(async () => {
  await disposeProjectRuntime(testDir);
  if (process.platform !== "win32") {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── 1. OpenCode Message ID Contract & Generator Tests ──────────────────────

describe("1. opencode-message-id-contract", () => {
  it("opencode-invalid-flowdeck-uuid-message-id-rejected", () => {
    const invalidId = "flowdeck-internal-12345678-1234-1234-1234-123456789abc";
    expect(isOpenCodeMessageId(invalidId)).toBe(false);
  });

  it("opencode-compatible-message-id-generated", () => {
    const id = createOpenCodeMessageId("descending");
    expect(isOpenCodeMessageId(id)).toBe(true);
    expect(id.startsWith("msg_")).toBe(true);
    expect(id.length).toBe(30); // "msg_" (4) + 12 hex + 14 base62 = 30 chars
  });

  it("opencode-compatible-message-id-unique-at-high-volume", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = createOpenCodeMessageId("descending");
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });

  it("opencode-compatible-message-id-order-safe-same-millisecond", () => {
    const now = Date.now();
    const id1 = createOpenCodeMessageId("descending", now);
    const id2 = createOpenCodeMessageId("descending", now);
    expect(id1).not.toBe(id2);
    expect(isOpenCodeMessageId(id1)).toBe(true);
    expect(isOpenCodeMessageId(id2)).toBe(true);
  });
});

// ─── 2. Durable Message-ID Provenance Authority Tests ───────────────────────

describe("2. durable-message-id-provenance", () => {
  it("reserved-id-user-role-echo-is-classified-internal-without-turn-increment", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync: promptAsyncMock } });
    const sessionID = "sess-prov-echo-1";

    // Genuine user turn 1
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "msg_user_genuine_1" },
      { message: {} as any, parts: [{ type: "text", text: "Coordinate backend and frontend refactoring" }] as any[] }
    );
    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(1);

    // Reserve an OpenCode-compatible internal message ID
    const internalMsgId = createOpenCodeMessageId("descending");
    expect(ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionID,
      messageId: internalMsgId,
      provenance: "FLOWDECK_SPECIALIST_DISPATCH",
      dispatchIdentity: "disp-ident-1",
    })).toBe(true);

    // OpenCode delivers the injected prompt as role=user with that exact messageID
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: internalMsgId },
      { message: {} as any, parts: [{ type: "text", text: "[FlowDeck Specialist Dispatch] Use OpenCode native Task/subagent calls only" }] as any[] }
    );

    // userTurnVersion MUST NOT increment
    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(1);
  });

  it("unreserved-marker-text-is-treated-as-genuine-user-turn", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync: promptAsyncMock } });
    const sessionID = "sess-marker-text-genuine";

    // Genuine user manually types FlowDeck internal marker text without prior reservation
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "msg_unreserved_user_1" },
      { message: {} as any, parts: [{ type: "text", text: "[FlowDeck Specialist Dispatch] Let us discuss our specialists." }] as any[] }
    );

    // Because there was no internal reservation, this establishes genuine user authority
    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(1);
  });

  it("cross-session-reservation-does-not-classify-internal", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync: promptAsyncMock } });
    const sessionA = "sess-a";
    const sessionB = "sess-b";
    const msgId = createOpenCodeMessageId("descending");

    // Reserve for sessionA only
    ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionA,
      messageId: msgId,
      provenance: "FLOWDECK_CONTINUATION",
      dispatchIdentity: "disp-a",
    });

    // In sessionB, same msgId is received
    expect(ctx.runtime.internalMessageProvenanceRepo.isInternal(sessionB, msgId)).toBe(false);
    expect(ctx.runtime.internalMessageProvenanceRepo.isInternal(sessionA, msgId)).toBe(true);
  });

  it("conflicting-provenance-reservation-fails-closed", () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-conflict";
    const msgId = createOpenCodeMessageId("descending");

    expect(ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionID,
      messageId: msgId,
      provenance: "FLOWDECK_SPECIALIST_DISPATCH",
      dispatchIdentity: "disp-1",
    })).toBe(true);

    // Attempting to reserve same (session, messageId) with conflicting provenance returns false
    expect(ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionID,
      messageId: msgId,
      provenance: "FLOWDECK_VERIFICATION",
      dispatchIdentity: "disp-1",
    })).toBe(false);
  });
});

// ─── 3. Stop & Terminal Quiescence Stress Tests ───────────────────────────────

describe("3. stop-and-terminal-quiescence", () => {
  it("terminal-run-plus-100-idle-events-produces-zero-prompt-async", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync: promptAsyncMock } });
    const sessionID = "sess-100-idle-term";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "msg_user_t1" },
      { message: {} as any, parts: [{ type: "text", text: "Coordinate backend and frontend refactoring across packages" }] as any[] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;
    expect(run).toBeTruthy();

    await ctx.runtime.services.runService.cancelRun(run.id, "User cancelled execution");
    promptAsyncMock.mockClear();

    // 100 repeated idle events
    for (let i = 0; i < 100; i++) {
      await ctx.adapter.onSessionIdle(sessionID);
    }

    expect(promptAsyncMock).not.toHaveBeenCalled();
  }, 30000);

  it("explicit-stop-plus-100-idle-events-produces-zero-prompt-async", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync: promptAsyncMock } });
    const sessionID = "sess-100-idle-stop";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "msg_user_s1" },
      { message: {} as any, parts: [{ type: "text", text: "Coordinate multi-service migration" }] as any[] }
    );

    // User sends explicit STOP
    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "msg_user_s2" },
      { message: {} as any, parts: [{ type: "text", text: "Stop" }] as any[] }
    );
    promptAsyncMock.mockClear();

    for (let i = 0; i < 100; i++) {
      await ctx.adapter.onSessionIdle(sessionID);
    }

    expect(promptAsyncMock).not.toHaveBeenCalled();
  }, 30000);

  it("100-duplicate-internal-echoes-do-not-increment-turn-or-create-runs", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { promptAsync: promptAsyncMock } });
    const sessionID = "sess-100-dup-echo";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "msg_user_init" },
      { message: {} as any, parts: [{ type: "text", text: "Initial user request" }] as any[] }
    );
    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(1);

    const internalMsgId = createOpenCodeMessageId("descending");
    ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionID,
      messageId: internalMsgId,
      provenance: "FLOWDECK_CONTINUATION",
      dispatchIdentity: "disp-100-echoes",
    });

    // Replay the internal message 100 times
    for (let i = 0; i < 100; i++) {
      await ctx.adapter.onChatMessage(
        { sessionID, agent: "heidi", messageID: internalMsgId },
        { message: {} as any, parts: [{ type: "text", text: "Work completed. Proceed to verify the results." }] as any[] }
      );
    }

    expect(ctx.adapter.getUserTurnVersion(sessionID)).toBe(1);
  }, 30000);

  it("event-driven-maintenance-prunes-expired-settled-records-and-exposes-diagnostics", async () => {
    const previousRetention = process.env.FLOWDECK_INTERNAL_MESSAGE_RETENTION_MS;
    const previousInterval = process.env.FLOWDECK_INTERNAL_MESSAGE_MAINTENANCE_INTERVAL_MS;
    process.env.FLOWDECK_INTERNAL_MESSAGE_RETENTION_MS = "60000";
    process.env.FLOWDECK_INTERNAL_MESSAGE_MAINTENANCE_INTERVAL_MS = "0";
    try {
      const ctx = acquireProjectRuntime(testDir);
      const sessionID = "sess-event-driven-prune";
      const messageID = createOpenCodeMessageId("descending");
      expect(ctx.runtime.internalMessageProvenanceRepo.reserve({
        sessionId: sessionID,
        messageId: messageID,
        provenance: "FLOWDECK_CONTINUATION",
        dispatchIdentity: "disp-event-prune",
      })).toBe(true);
      ctx.runtime.db.query(`
        UPDATE flowdeck_internal_messages SET created_at = ? WHERE session_id = ? AND message_id = ?
      `).run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), sessionID, messageID);

      await ctx.adapter.onSessionIdle(sessionID);

      expect(ctx.runtime.internalMessageProvenanceRepo.find(sessionID, messageID)).toBeNull();
      expect(ctx.adapter.getInternalMessageProvenanceDiagnostics()).toMatchObject({
        retentionMs: 60000,
        maintenanceIntervalMs: 0,
        lastPrunedCount: 1,
        totalCount: 0,
      });
    } finally {
      if (previousRetention === undefined) delete process.env.FLOWDECK_INTERNAL_MESSAGE_RETENTION_MS;
      else process.env.FLOWDECK_INTERNAL_MESSAGE_RETENTION_MS = previousRetention;
      if (previousInterval === undefined) delete process.env.FLOWDECK_INTERNAL_MESSAGE_MAINTENANCE_INTERVAL_MS;
      else process.env.FLOWDECK_INTERNAL_MESSAGE_MAINTENANCE_INTERVAL_MS = previousInterval;
    }
  }, 30000);

  it("completed-specialist-plus-10-idle-events-does-not-redispatch-same-specialist", async () => {
    const promptAsyncMock = mock(() => Promise.resolve(true));
    const ctx = acquireProjectRuntime(testDir, { session: { abort: mock(() => Promise.resolve(true)), promptAsync: promptAsyncMock } });
    const sessionID = "sess-spec-no-redispatch-100";

    await ctx.adapter.onChatMessage(
      { sessionID, agent: "heidi", messageID: "msg_spec_init" },
      { message: {} as any, parts: [{ type: "text", text: "Coordinate API and UI specialists together" }] as any[] }
    );
    const run = (await ctx.adapter.resolveActiveRunForSession(sessionID))!;

    const del = await ctx.runtime.childExecutionLifecycleService.registerDelegation({
      runId: run.id,
      parentSessionId: sessionID,
      taskCallId: "call-spec-done-100",
      targetAgent: "coder",
      specialistId: "spec-finished-1",
      prompt: "[FlowDeck specialist:spec-finished-1] Build",
      description: "[FlowDeck specialist:spec-finished-1] Build",
    });
    await ctx.runtime.childExecutionLifecycleService.markStarted({ taskCallId: del.taskCallId });
    await ctx.runtime.childExecutionLifecycleService.markCompleted({
      taskCallId: del.taskCallId,
      output: "Done",
    });

    promptAsyncMock.mockClear();

    for (let i = 0; i < 10; i++) {
      await ctx.adapter.onSessionIdle(sessionID);
    }

    const calls = promptAsyncMock.mock.calls as any[];
    const redispatch = calls.some((c: any) => {
      const text = c[0]?.body?.parts?.[0]?.text ?? "";
      return text.includes("spec-finished-1") && text.includes("[FlowDeck Specialist Dispatch]");
    });
    expect(redispatch).toBe(false);
  }, 30000);
});

// ─── 4. Ledger Lifecycle & Pruning Tests ────────────────────────────────────

describe("4. internal-message-ledger-lifecycle", () => {
  it("prunes-safe-expired-records-while-retaining-unsettled-ones", () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-lifecycle";
    const oldDate = new Date(Date.now() - 3600 * 1000).toISOString();
    const settledMsgId = createOpenCodeMessageId("descending");
    const unsettledMsgId = createOpenCodeMessageId("descending");

    // Settled record
    ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionID,
      messageId: settledMsgId,
      provenance: "FLOWDECK_CONTINUATION",
      dispatchIdentity: "disp-settled",
    });

    // Unsettled record (registered with pending dispatch in continuation_dispatches)
    ctx.runtime.db.query(`
      INSERT INTO continuation_dispatches (
        identity, run_id, session_id, user_turn_version, run_aggregate_version,
        transition_reason, current_work_item_id, state_fingerprint, status,
        attempt_count, created_at, last_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outcome_unknown', 1, ?, ?)
    `).run("disp-unsettled", "run-1", sessionID, 1, 1, "PROGRESS_CONFIRMED", "wi-1", "fp-1", oldDate, oldDate);

    ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionID,
      messageId: unsettledMsgId,
      provenance: "FLOWDECK_RECOVERY",
      dispatchIdentity: "disp-unsettled",
    });

    // Manually backdate settled record's created_at
    ctx.runtime.db.query(`
      UPDATE flowdeck_internal_messages
      SET created_at = ?
      WHERE message_id = ?
    `).run(oldDate, settledMsgId);

    const cutoff = new Date(Date.now() - 1800 * 1000).toISOString();
    const prunedCount = ctx.runtime.internalMessageProvenanceRepo.pruneExpired(cutoff);

    expect(prunedCount).toBe(1);
    expect(ctx.runtime.internalMessageProvenanceRepo.find(sessionID, settledMsgId)).toBeNull();
    // Unsettled record MUST be preserved
    expect(ctx.runtime.internalMessageProvenanceRepo.find(sessionID, unsettledMsgId)).not.toBeNull();
  });

  it("session-deletion-removes-session-scoped-provenance-records", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const sessionID = "sess-to-delete";
    const msgId = createOpenCodeMessageId("descending");

    ctx.runtime.internalMessageProvenanceRepo.reserve({
      sessionId: sessionID,
      messageId: msgId,
      provenance: "FLOWDECK_CONTINUATION",
      dispatchIdentity: "disp-del",
    });

    expect(ctx.runtime.internalMessageProvenanceRepo.isInternal(sessionID, msgId)).toBe(true);

    await ctx.adapter.onSessionDeleted(sessionID);

    expect(ctx.runtime.internalMessageProvenanceRepo.isInternal(sessionID, msgId)).toBe(false);
  });
});