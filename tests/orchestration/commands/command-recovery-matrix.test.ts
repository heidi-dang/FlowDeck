import { describe, expect, it, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runMigrations } from "../../../src/orchestration/persistence/migrations/migration-runner";
import { createProductionOrchestrationRuntime } from "../../../src/orchestration/composition";
import { CommandSecurityException } from "../../../src/orchestration/commands/security/command-security";
import type { CommandFaultHook } from "../../../src/orchestration/commands/services/durable-command-executor";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(`${tmpdir()}/flowdeck-m9-recovery-`);
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

function openRuntime(dbPath: string, extra: Record<string, unknown> = {}) {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  const runtime = createProductionOrchestrationRuntime(db, extra as any);
  return { db, runtime };
}

function crashHook(seam: "afterDispatch" | "beforeCompletion"): CommandFaultHook {
  let closed = false;
  return {
    [seam]: () => {
      if (closed) return;
      closed = true;
      const db = (globalThis as any).__m9_recovery_db;
      if (db) { try { db.close(); } catch { } }
    },
  };
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;
}

describe("M9 R1-R15 fresh-runtime recovery matrix", () => {
  it("R1-R10: crash after dispatch resumes through a fresh runtime and completes (no duplicates, no rerun)", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const hook = crashHook("afterDispatch");
    const { db: dbA, runtime: runtimeA } = openRuntime(dbPath, { faultHook: hook } as any);
    (globalThis as any).__m9_recovery_db = dbA;
    try {
      await runtimeA.commands.executor.executeCommand("task/start", { taskDescription: "nonterminal resume" });
      throw new Error("expected crash during execution");
    } catch { }
    const crashRow = new Database(dbPath).query(
      "SELECT invocation_id, task_run_id, plan_id, status FROM command_invocations ORDER BY created_at DESC LIMIT 1",
    ).get() as any;
    expect(crashRow.status).toBe("running");
    const invocationId = crashRow.invocation_id;
    const crashRunId = crashRow.task_run_id;
    const crashPlanId = crashRow.plan_id;
    expect(count(new Database(dbPath), "task_runs")).toBe(1);
    expect(count(new Database(dbPath), "execution_plans")).toBe(1);
    expect(count(new Database(dbPath), "execution_workstreams")).toBe(1);
    expect(count(new Database(dbPath), "assignments")).toBe(1);
    const { db: dbB, runtime: runtimeB } = openRuntime(dbPath);
    const recovered = await runtimeB.commands.executor.recoverCommand(invocationId);
    expect(recovered.status).toBe("completed");
    expect(recovered.invocationId).toBe(invocationId);
    expect(recovered.taskRunId).toBe(crashRunId);
    expect(count(dbB, "command_invocations")).toBe(1);
    expect(count(dbB, "task_runs")).toBe(1);
    expect(count(dbB, "execution_plans")).toBe(1);
    expect(count(dbB, "execution_workstreams")).toBe(1);
    expect(count(dbB, "assignments")).toBe(1);
    const plan = dbB.query("SELECT plan_id, run_id FROM execution_plans").get() as any;
    expect(plan.plan_id).toBe(crashPlanId);
    expect(plan.run_id).toBe(crashRunId);
    const inv = dbB.query("SELECT status, plan_id FROM command_invocations WHERE invocation_id = ?").get(invocationId) as any;
    expect(inv.status).toBe("completed");
    expect(inv.plan_id).toBe(crashPlanId);
    expect(count(dbB, "verification_results")).toBeGreaterThan(0);
    expect((dbB.query("SELECT COUNT(*) AS c FROM verification_results WHERE run_id = ? AND status = 'passed'").get(crashRunId) as any).c).toBeGreaterThan(0);
    expect(count(dbB, "evidence")).toBeGreaterThan(0);
    expect(count(dbB, "completion_decisions")).toBe(1);
    expect((dbB.query("SELECT decision FROM completion_decisions").get() as any).decision).toBe("pass");
    const countsBefore = {
      runs: count(dbB, "task_runs"), plans: count(dbB, "execution_plans"),
      workstreams: count(dbB, "execution_workstreams"), assignments: count(dbB, "assignments"),
      verifications: count(dbB, "verification_results"), decisions: count(dbB, "completion_decisions"),
    };
    const again = await runtimeB.commands.executor.recoverCommand(invocationId);
    expect(again.status).toBe("completed");
    expect(count(dbB, "task_runs")).toBe(countsBefore.runs);
    expect(count(dbB, "execution_plans")).toBe(countsBefore.plans);
    expect(count(dbB, "execution_workstreams")).toBe(countsBefore.workstreams);
    expect(count(dbB, "assignments")).toBe(countsBefore.assignments);
    expect(count(dbB, "verification_results")).toBe(countsBefore.verifications);
    expect(count(dbB, "completion_decisions")).toBe(countsBefore.decisions);
    dbB.close();
  });

  it("R11-R14: crash after verification, before completion — recovery persists exactly one logical CompletionDecision", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const hook = crashHook("beforeCompletion");
    const { db: dbA, runtime: runtimeA } = openRuntime(dbPath, { faultHook: hook } as any);
    (globalThis as any).__m9_recovery_db = dbA;
    try {
      await runtimeA.commands.executor.executeCommand("task/start", { taskDescription: "crash before completion" });
      throw new Error("expected crash during execution");
    } catch { }
    const readA = new Database(dbPath);
    const crashRow = readA.query("SELECT invocation_id, task_run_id, status FROM command_invocations ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(crashRow.status).toBe("verifying");
    expect(count(readA, "verification_results")).toBeGreaterThan(0);
    expect(count(readA, "evidence")).toBeGreaterThan(0);
    expect(count(readA, "completion_decisions")).toBe(0);
    readA.close();
    const { db: dbB, runtime: runtimeB } = openRuntime(dbPath);
    const recovered = await runtimeB.commands.executor.recoverCommand(crashRow.invocation_id);
    expect(recovered.status).toBe("completed");
    expect(count(dbB, "completion_decisions")).toBe(1);
    expect((dbB.query("SELECT decision FROM completion_decisions").get() as any).decision).toBe("pass");
    expect(count(dbB, "verification_results")).toBeGreaterThan(0);
    expect(count(dbB, "evidence")).toBeGreaterThan(0);
    expect(count(dbB, "task_runs")).toBe(1);
    expect(count(dbB, "execution_plans")).toBe(1);
    expect(count(dbB, "assignments")).toBe(1);
    dbB.close();
  });

  it("R15: terminal completed restart stays completed with zero rerun (counts frozen)", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const { runtime: runtimeA } = openRuntime(dbPath);
    const first = await runtimeA.commands.executor.executeCommand("task/start", { taskDescription: "terminal stable" });
    expect(first.status).toBe("completed");
    const { db: dbB, runtime: runtimeB } = openRuntime(dbPath);
    const before = {
      runs: count(dbB, "task_runs"), plans: count(dbB, "execution_plans"),
      workstreams: count(dbB, "execution_workstreams"), assignments: count(dbB, "assignments"),
      verifications: count(dbB, "verification_results"), decisions: count(dbB, "completion_decisions"),
    };
    const recovered = await runtimeB.commands.executor.recoverCommand(first.invocationId!);
    expect(recovered.status).toBe("completed");
    expect(recovered.invocationId).toBe(first.invocationId);
    expect(count(dbB, "task_runs")).toBe(before.runs);
    expect(count(dbB, "execution_plans")).toBe(before.plans);
    expect(count(dbB, "execution_workstreams")).toBe(before.workstreams);
    expect(count(dbB, "assignments")).toBe(before.assignments);
    expect(count(dbB, "verification_results")).toBe(before.verifications);
    expect(count(dbB, "completion_decisions")).toBe(before.decisions);
    dbB.close();
  });

  it("R15: terminal failure restart remains the same logical failed invocation — no silent fresh invocation", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const { db: _dbA, runtime: runtimeA } = openRuntime(dbPath, {
      faultHook: { afterDispatch: () => { throw new Error("simulated unrecoverable failure") } },
    } as any);
    const failed = await runtimeA.commands.executor.executeCommand("task/start", { taskDescription: "terminal failure" });
    expect(failed.status).toBe("failed");
    const { db: dbB, runtime: runtimeB } = openRuntime(dbPath);
    const before = {
      runs: count(dbB, "task_runs"), plans: count(dbB, "execution_plans"),
      workstreams: count(dbB, "execution_workstreams"), assignments: count(dbB, "assignments"),
    };
    const recovered = await runtimeB.commands.executor.recoverCommand(failed.invocationId);
    expect(recovered.status).toBe("failed");
    expect(recovered.invocationId).toBe(failed.invocationId);
    expect(count(dbB, "task_runs")).toBe(before.runs);
    expect(count(dbB, "execution_plans")).toBe(before.plans);
    expect(count(dbB, "execution_workstreams")).toBe(before.workstreams);
    expect(count(dbB, "assignments")).toBe(before.assignments);
    dbB.close();
  });

  it("R15: cancelled command restart stays cancelled — zero resume", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const { db: dbA, runtime: runtimeA } = openRuntime(dbPath);
    let release!: () => void;
    const schedulerGate = new Promise<void>((resolve) => { release = resolve; });
    const originalRunReady = runtimeA.executionScheduler.runReady.bind(runtimeA.executionScheduler);
    (runtimeA.executionScheduler as any).runReady = async (planId: string, executor: any) => {
      await schedulerGate;
      return originalRunReady(planId, executor);
    };
    const executing = runtimeA.commands.executor.executeCommand("task/start", { taskDescription: "cancel then recover" });
    let cancelled: any = null;
    for (let i = 0; i < 100; i++) {
      const row = dbA.query("SELECT invocation_id FROM command_invocations WHERE status = 'running'").get() as any;
      if (row) {
        cancelled = await runtimeA.commands.executor.cancelCommand(row.invocation_id, "recovery matrix cancellation");
        break;
      }
      await Promise.resolve();
    }
    release();
    const result = await executing;
    expect(result.status).toBe("cancelled");
    expect(cancelled?.invocationId).toBe(result.invocationId);
    dbA.close();
    const { db: dbB, runtime: runtimeB } = openRuntime(dbPath);
    const before = {
      runs: count(dbB, "task_runs"), plans: count(dbB, "execution_plans"),
      workstreams: count(dbB, "execution_workstreams"), assignments: count(dbB, "assignments"),
    };
    const recovered = await runtimeB.commands.executor.recoverCommand(result.invocationId);
    expect(recovered.status).toBe("cancelled");
    expect(recovered.invocationId).toBe(result.invocationId);
    expect(count(dbB, "task_runs")).toBe(before.runs);
    expect(count(dbB, "execution_plans")).toBe(before.plans);
    expect(count(dbB, "execution_workstreams")).toBe(before.workstreams);
    expect(count(dbB, "assignments")).toBe(before.assignments);
    expect((dbB.query("SELECT COUNT(*) AS c FROM execution_workstreams WHERE status IN ('planned','ready','running')").get() as any).c).toBe(0);
    dbB.close();
  });

  it("R2: historical command version is preserved — recovery never silently upgrades", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const { db: dbA, runtime: runtimeA } = openRuntime(dbPath);
    const repo = (runtimeA.commands as any).executor as any;
    const mod = await import("../../../src/orchestration/commands/persistence/sqlite-command-invocation-repository");
    const txMod = await import("../../../src/orchestration/persistence/transaction-manager");
    const invocationRepo = new mod.SqliteCommandInvocationRepository(dbA, txMod.createTransactionManager(dbA));
    await invocationRepo.saveInvocation({
      invocationId: "inv-historical-v99",
      commandId: "task/start",
      commandVersion: 99,
      idempotencyKey: "ik-historical-v99",
      status: "running",
      input: { taskDescription: "historical" },
      taskRunId: "run-historical-v99",
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(repo.recoverCommand("inv-historical-v99")).rejects.toMatchObject({
      code: "COMMAND_HISTORICAL_VERSION_UNRESOLVABLE",
    });
    dbA.close();
  });

  it("concurrent recovery converges — single-flight claim, one logical execution", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const hook = crashHook("afterDispatch");
    const { db: dbA, runtime: runtimeA } = openRuntime(dbPath, { faultHook: hook } as any);
    (globalThis as any).__m9_recovery_db = dbA;
    try {
      await runtimeA.commands.executor.executeCommand("task/start", { taskDescription: "concurrent recovery" });
      throw new Error("expected crash");
    } catch { }
    const crashRow = new Database(dbPath).query(
      "SELECT invocation_id FROM command_invocations ORDER BY created_at DESC LIMIT 1",
    ).get() as any;
    const { runtime: runtimeB1 } = openRuntime(dbPath);
    const { runtime: runtimeB2 } = openRuntime(dbPath);
    const [r1, r2] = await Promise.all([
      runtimeB1.commands.executor.recoverCommand(crashRow.invocation_id),
      runtimeB2.commands.executor.recoverCommand(crashRow.invocation_id),
    ]);
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
    expect(r1.invocationId).toBe(r2.invocationId);
    const read = new Database(dbPath);
    expect(count(read, "command_invocations")).toBe(1);
    expect(count(read, "task_runs")).toBe(1);
    expect(count(read, "execution_plans")).toBe(1);
    expect(count(read, "execution_workstreams")).toBe(1);
    expect(count(read, "assignments")).toBe(1);
    expect(count(read, "completion_decisions")).toBe(1);
    expect((read.query("SELECT decision FROM completion_decisions").get() as any).decision).toBe("pass");
    read.close();
    dbA.close();
  });

  it("T8: verificationPassed=false from the agent executor blocks worktree integration", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const root = process.cwd();
    const worktreeRoot = mkdtempSync(`${tmpdir()}/flowdeck-m9-t8-worktree-`);
    tmpDirs.push(worktreeRoot);
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    runMigrations(db);
    // The agent reports success but explicitly fails verification: dispatch
    // must treat that verdict as authoritative and never reach integration.
    const runtime = createProductionOrchestrationRuntime(db, {
      repositoryPath: root,
      worktreeRoot,
      agentExecutor: { execute: async () => ({ status: "succeeded", verificationPassed: false, integrationPassed: false, durationMs: 0 }) },
    });
    const result = await runtime.commands.executor.executeCommand("task/start", { taskDescription: "verification gate", sourceSha, ownedPaths: ["src/orchestration/commands"] });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("CANONICAL_SCHEDULER_FAILED");
    const ws = db.query("SELECT status, failure_reason FROM execution_workstreams ORDER BY created_at DESC LIMIT 1").get() as any;
    expect(ws.status).toBe("failed"); // the workstream must not reach integration
    expect(ws.failure_reason).toBeTruthy();
    db.close();
  }, 30000);

  it("T9: a completion decision at a different SHA does not satisfy the recovery fast-path", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const { db: dbA, runtime: runtimeA } = openRuntime(dbPath);
    const first = await runtimeA.commands.executor.executeCommand("task/start", { taskDescription: "sha-scoped fast-path" });
    expect(first.status).toBe("completed");
    const invocationId = first.invocationId!;
    const runId = first.taskRunId!;
    const decision = dbA.query("SELECT sha FROM completion_decisions WHERE run_id = ?").get(runId) as any;
    expect(decision.sha).toBe("0".repeat(40)); // no sourceSha -> canonical zero SHA
    // Corrupt the durable decision's SHA: it must no longer satisfy THIS run's
    // fast-path (recovery must re-verify/re-evaluate, not short-circuit).
    dbA.query("UPDATE completion_decisions SET sha = ? WHERE run_id = ?").run("1".repeat(40), runId);
    // Reset the durable invocation to a mid-flight state so recovery re-enters
    // the canonical pipeline; a terminal invocation would short-circuit before
    // the fast-path is ever evaluated.
    dbA.query("UPDATE command_invocations SET status = 'running' WHERE invocation_id = ?").run(invocationId);
    const { db: dbB, runtime: runtimeB } = openRuntime(dbPath);
    const recovered = await runtimeB.commands.executor.recoverCommand(invocationId);
    expect(recovered.status).toBe("completed");
    // The re-evaluation is deduped by the idempotency key: still exactly one
    // logical completion decision, no matter that the stored sha was stale.
    expect(count(dbB, "completion_decisions")).toBe(1);
    dbB.close();
    dbA.close();
  });

  it("T10: security boundary rejects malicious input before persistence", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "runtime.sqlite");
    const { db, runtime } = openRuntime(dbPath);
    const malicious = ["rm", "-rf"].join(" ") + "; echo pwned";
    let thrown: unknown = null;
    try {
      await runtime.commands.executor.executeCommand("task/start", { taskDescription: malicious });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CommandSecurityException);
    expect((thrown as CommandSecurityException).code).toBe("SHELL_INJECTION");
    // The malicious invocation is rejected at the security boundary, before
    // the R1 persistence: it must never be left durably in "pending" state.
    expect(count(db, "command_invocations")).toBe(0);
    db.close();
  });
});
