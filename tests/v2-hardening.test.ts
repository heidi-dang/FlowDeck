import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runMigrations } from "../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../src/orchestration/persistence/transaction-manager"
import { SqliteExecutionRepository, GitWorktreeManager } from "../src/orchestration/execution"
import type { WorktreeLeaseInput } from "../src/orchestration/execution/sqlite-repository"

describe("v2 hardening boundaries", () => {
  it("allows exactly one live owner during a twenty-way lease race", async () => {
    const db = new Database(":memory:")
    try {
      runMigrations(db)
      const repo = new SqliteExecutionRepository(db, createTransactionManager(db))
      const base: WorktreeLeaseInput = { leaseId: "lease-0", runId: "race-run", planId: "race-plan", workstreamId: "race-workstream", agentId: "agent", worktreeId: "race-worktree", workspace: "/tmp/race-worktree", branch: "flowdeck/race", acquiredAt: "2026-08-09T00:00:00.000Z", renewedAt: "2026-08-09T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z" }
      const results = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() => { try { repo.acquireLease({ ...base, leaseId: `lease-${index}` }); return true } catch { return false } })))
      expect(results.filter(Boolean)).toHaveLength(1)
      expect(repo.listLeases("race-run").filter(lease => ["allocated", "active", "renewing"].includes(lease.state))).toHaveLength(1)
    } finally { db.close() }
  })

  it("rejects symlink escapes and traversal before integration", () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-security-"))
    const repo = join(root, "repo")
    const worktrees = join(root, "worktrees")
    const outside = join(root, "outside")
    mkdirSync(repo); mkdirSync(outside); writeFileSync(join(outside, "secret.txt"), "secret")
    execFileSync("git", ["init", "-q"], { cwd: repo }); execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo }); execFileSync("git", ["config", "user.name", "test"], { cwd: repo }); writeFileSync(join(repo, "README.md"), "root\n"); execFileSync("git", ["add", "README.md"], { cwd: repo }); execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo })
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
    const manager = new GitWorktreeManager(repo, worktrees)
    const allocation = manager.allocate("run", "../writer;rm -rf", sha)
    try {
      expect(allocation.branch).not.toContain("..")
      expect(() => manager.assertOwnedPath(allocation.workspace, "../escape")).toThrow("OWNERSHIP_PATH_ESCAPE")
      symlinkSync(join(outside, "secret.txt"), join(allocation.workspace, "linked.txt"))
      expect(() => manager.assertOwnedPath(allocation.workspace, "linked.txt")).toThrow("SYMLINK_ESCAPE")
      mkdirSync(join(allocation.workspace, "src"))
      symlinkSync(outside, join(allocation.workspace, "src", "external"))
      expect(() => manager.assertOwnedPath(allocation.workspace, "src/external/new.ts")).toThrow("SYMLINK_ESCAPE")
      expect(() => manager.assertOwnedPath(allocation.workspace, "C:/outside.txt")).toThrow("OWNERSHIP_PATH_ESCAPE")
    } finally { manager.remove(allocation); rmSync(root, { recursive: true, force: true }) }
  })

  it("keeps WAL recovery and integrity checks explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-wal-"))
    const db = new Database(join(root, "runtime.db"))
    try { runMigrations(db); expect(db.query("PRAGMA journal_mode = WAL").get()).toBeDefined(); expect((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok") } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
