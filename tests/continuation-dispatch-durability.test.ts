import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireProjectRuntime, disposeProjectRuntime } from "../src/runtime/project-registry";
import { closeConnection, getConnectionCount, openConnection } from "../src/orchestration/persistence/connection";
import { ContinuationDispatcher, type ContinuationToken } from "../src/orchestration/services/continuation-policy";

let testDir = "";

function token(overrides: Partial<ContinuationToken> = {}): ContinuationToken {
  return {
    runId: "run-continuation-durable",
    sessionId: "session-continuation-durable",
    userTurnVersion: 1,
    runAggregateVersion: 1,
    transitionReason: "PROGRESS_CONFIRMED",
    currentWorkItemId: "assignment-durable",
    stateFingerprint: "durable-state-fingerprint",
    ...overrides,
  };
}

describe("Continuation dispatch durability", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "flowdeck-continuation-dispatch-"));
  });

  afterEach(async () => {
    await disposeProjectRuntime(testDir);
    // Bun's Windows WAL implementation can retain the main database handle
    // after close. Fixture uniqueness prevents interference; runner cleanup
    // removes this process-scoped temporary directory after assertions finish.
    if (process.platform !== "win32") {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("quarantines a corrupt durable claim and never invokes the native prompt", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);
    const dispatchToken = token();
    const identity = dispatcher.computeTokenIdentity(dispatchToken);
    ctx.runtime.db.query(`
      INSERT INTO continuation_dispatches (
        identity, run_id, session_id, user_turn_version, run_aggregate_version,
        transition_reason, current_work_item_id, state_fingerprint, status,
        attempt_count, created_at, last_attempt_at
      ) VALUES (?, 'wrong-run', ?, 1, 1, 'PROGRESS_CONFIRMED', 'assignment-durable', 'durable-state-fingerprint', 'failed', 1, datetime('now'), datetime('now'))
    `).run(identity, dispatchToken.sessionId);
    const promptAsync = mock(() => Promise.resolve(true));

    const result = await dispatcher.dispatch(dispatchToken, { client: { session: { promptAsync } } });

    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("dispatch_outcome_unknown");
    expect(promptAsync).not.toHaveBeenCalled();
    expect(ctx.runtime.db.query("SELECT status FROM continuation_dispatches WHERE identity = ?").get(identity)).toEqual({ status: "blocked" });
  });

  it("treats a post-native CAS race as outcome unknown and does not claim dispatch success", async () => {
    const ctx = acquireProjectRuntime(testDir);
    const dispatcher = new ContinuationDispatcher(ctx.runtime.db);
    const dispatchToken = token({ runId: "run-continuation-cas-race" });
    const identity = dispatcher.computeTokenIdentity(dispatchToken);
    const promptAsync = mock(() => {
      ctx.runtime.db.query("UPDATE continuation_dispatches SET status = 'outcome_unknown' WHERE identity = ? AND status = 'pending'").run(identity);
      return Promise.resolve(true);
    });

    const result = await dispatcher.dispatch(dispatchToken, { client: { session: { promptAsync } } });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(false);
    expect(result.reason).toBe("dispatch_outcome_unknown");
    expect(ctx.runtime.db.query("SELECT status FROM continuation_dispatches WHERE identity = ?").get(identity)).toEqual({ status: "outcome_unknown" });
  });

  it("terminal connection release evicts the registry even when Bun defers a held prepared statement", () => {
    const initialCount = getConnectionCount();
    const dbPath = join(testDir, "terminal-close.db");
    const db = openConnection({ path: dbPath });
    const statement = db.prepare("SELECT 1 AS value");
    expect(statement.get()).toEqual({ value: 1 });
    expect(getConnectionCount()).toBe(initialCount + 1);

    closeConnection(dbPath);

    // Bun may defer physical close while callers retain a statement. The
    // project-level guarantee is that no stale connection remains cached.
    expect(getConnectionCount()).toBe(initialCount);
  });
});
