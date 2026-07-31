/**
 * E2E comprehensive orchestration pipeline validation.
 * Uses actual repository interfaces with correct schema FK setup.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, unlinkSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Database } from "bun:sqlite"
import { closeAllConnections } from "../../src/orchestration/persistence/connection"
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../../src/orchestration/persistence/transaction-manager"
import { EventsRepository } from "../../src/orchestration/persistence/repositories/event"
import { TaskRunsRepository } from "../../src/orchestration/persistence/repositories/task-run"
import { WorktreesRepository } from "../../src/orchestration/persistence/repositories/worktree"
import { deterministicCleanup } from "./harness/cleanup"

/** Bootstrap FK parent rows needed by task_runs. */

let tempDir = ""

function freshDb(): Database {
  const path = join(tempDir, "test.db")
  const sidecars = [path + "-wal", path + "-shm", path]
  for (const p of sidecars) {
    if (existsSync(p)) {
      try { unlinkSync(p) } catch { /* ignore EBUSY on Windows */ }
    }
  }
  const db = new Database(path, { create: true })
  db.query("PRAGMA journal_mode = WAL").run()
  db.query("PRAGMA foreign_keys = ON").run()
  runMigrations(db)
  return db
}

/** Seed DB with default FK parents and return reusable contract/family IDs. */
const CFG = { contract: "ct-e2e", family: "fam-e2e" }
function seed(db: Database): void {
  db.query("INSERT OR IGNORE INTO contract_families (family_id, name, description, created_by, created_at) VALUES (?, 'e2e-family', 'test', 'test', datetime('now'))").run(CFG.family)
  db.query(`INSERT OR IGNORE INTO task_contracts (contract_id, family_id, version, title, description, in_scope, out_of_scope, payload_hash, repo_url, repo_sha, created_by, created_at)
    VALUES (?, ?, 1, 'E2E', 'test', '[]', '[]', 'hash', 'https://r', 's', 'test', datetime('now'))`).run(CFG.contract, CFG.family)
  db.query("INSERT OR IGNORE INTO repositories (repository_id, url, canonical_path, created_at) VALUES ('repo-1', 'https://repo', '/tmp/r', datetime('now'))").run()
  db.query("INSERT OR IGNORE INTO repositories (repository_id, url, canonical_path, created_at) VALUES ('r1', 'https://r1', '/tmp/r1', datetime('now'))").run()
}

describe("E2E Orchestration Pipeline", () => {
  let db: Database
  let tx: ReturnType<typeof createTransactionManager>
  let eventsRepo: EventsRepository
  let runsRepo: TaskRunsRepository
  let workRepo: WorktreesRepository

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "e2e-"))
    db = freshDb()
    tx = createTransactionManager(db)
    eventsRepo = new EventsRepository(db, tx)
    runsRepo = new TaskRunsRepository(db, tx)
    workRepo = new WorktreesRepository(db, tx)
    seed(db) // create FK parent rows
  })

  afterEach(async () => {
    closeAllConnections()
    await deterministicCleanup({ db, dir: tempDir })
  })

  /* ─── Run lifecycle ─── */

  it("1. creates a task run and persists it", () => {
    const run = runsRepo.create({
      runId: "run-1", contractId: CFG.contract,
      strategy: "simple", baselineSha: "abc123", repoBranch: "main",
    })
    expect(run).toBeDefined()
    expect(run.runId).toBe("run-1")
    expect(run.state).toBe("created")
    expect(run.baselineSha).toBe("abc123")
    expect(run.repoBranch).toBe("main")

    const loaded = runsRepo.findById("run-1")
    expect(loaded).toBeDefined()
    expect(loaded!.state).toBe("created")
  })

  it("2. transitions run states — created → running → completed", () => {
    runsRepo.create({ runId: "run-2", contractId: CFG.contract, strategy: "simple", baselineSha: "def456", repoBranch: "feature/x" })
    expect(runsRepo.updateState("run-2", "executing")).toBe(true)
    expect(runsRepo.findById("run-2")!.state).toBe("executing")
    expect(runsRepo.updateState("run-2", "completed")).toBe(true)
    expect(runsRepo.findById("run-2")!.state).toBe("completed")
  })

  it("3. updateState with SHA tracking", () => {
    runsRepo.create({ runId: "run-3", contractId: CFG.contract, strategy: "simple", baselineSha: "aaa", repoBranch: "bugfix/y" })
    runsRepo.updateState("run-3", "executing", "bbb111")
    const run = runsRepo.findById("run-3")
    expect(run!.state).toBe("executing")
    expect(run!.currentSha).toBe("bbb111")
  })

  it("4. findByState — filter runs by current state", () => {
    runsRepo.create({ runId: "r1", contractId: CFG.contract, strategy: "simple", baselineSha: "a", repoBranch: "main" })
    runsRepo.create({ runId: "r2", contractId: CFG.contract, strategy: "simple", baselineSha: "b", repoBranch: "main" })
    runsRepo.updateState("r2", "executing")
    expect(runsRepo.findByState("created")).toHaveLength(1)
    expect(runsRepo.findByState("created")[0].runId).toBe("r1")
    expect(runsRepo.findByState("executing")).toHaveLength(1)
    expect(runsRepo.findByState("executing")[0].runId).toBe("r2")
  })

  /* ─── Events ─── */

  it("5. event ordering — global_sequence is monotonic", () => {
    const e1 = eventsRepo.append({ eventId: "e1", eventType: "RunCreated", aggregateType: "run", aggregateId: "r1", aggregateVersion: 1, data: "{}" })
    const e2 = eventsRepo.append({ eventId: "e2", eventType: "RunStarted", aggregateType: "run", aggregateId: "r1", aggregateVersion: 2, data: "{}" })
    const e3 = eventsRepo.append({ eventId: "e3", eventType: "RunCompleted", aggregateType: "run", aggregateId: "r1", aggregateVersion: 3, data: "{}" })
    expect(e1.globalSequence).toBe(1)
    expect(e2.globalSequence).toBe(2)
    expect(e3.globalSequence).toBe(3)
  })

  it("6. event replay — reconstruct run sequence from events", () => {
    eventsRepo.append({ eventId: "re1", eventType: "RunCreated", aggregateType: "run", aggregateId: "r-replay", aggregateVersion: 1, data: '{"state":"pending"}' })
    eventsRepo.append({ eventId: "re2", eventType: "RunAssigned", aggregateType: "run", aggregateId: "r-replay", aggregateVersion: 2, data: '{"worker":"w1"}' })
    eventsRepo.append({ eventId: "re3", eventType: "RunStarted", aggregateType: "run", aggregateId: "r-replay", aggregateVersion: 3, data: '{"state":"running"}' })
    eventsRepo.append({ eventId: "re4", eventType: "RunCompleted", aggregateType: "run", aggregateId: "r-replay", aggregateVersion: 4, data: '{"outcome":"success"}' })

    const all = eventsRepo.queryRange(1).filter(e => e.aggregateId === "r-replay")
    expect(all).toHaveLength(4)
    expect(all.map(e => e.eventType)).toEqual(["RunCreated", "RunAssigned", "RunStarted", "RunCompleted"])
    for (let i = 0; i < all.length; i++) expect(all[i].aggregateVersion).toBe(i + 1)
  })

  it("7. aggregate version tracking", () => {
    eventsRepo.append({ eventId: "av1", eventType: "RunCreated", aggregateType: "run", aggregateId: "r-av", aggregateVersion: 1, data: "{}" })
    expect(eventsRepo.getMaxAggregateVersion("run", "r-av")).toBe(1)
    eventsRepo.append({ eventId: "av2", eventType: "RunUpdated", aggregateType: "run", aggregateId: "r-av", aggregateVersion: 2, data: "{}" })
    expect(eventsRepo.getMaxAggregateVersion("run", "r-av")).toBe(2)
    expect(eventsRepo.getMaxAggregateVersion("run", "nonexistent")).toBe(0)
  })

  it("8. queryRange with toSeq", () => {
    eventsRepo.append({ eventId: "q1", eventType: "E", aggregateType: "run", aggregateId: "r-q", aggregateVersion: 1, data: "{}" })
    eventsRepo.append({ eventId: "q2", eventType: "E", aggregateType: "run", aggregateId: "r-q", aggregateVersion: 2, data: "{}" })
    eventsRepo.append({ eventId: "q3", eventType: "E", aggregateType: "run", aggregateId: "r-q", aggregateVersion: 3, data: "{}" })
    expect(eventsRepo.queryRange(2, 2)).toHaveLength(1)
    expect(eventsRepo.queryRange(2, 3)).toHaveLength(2)
  })

  /* ─── Outbox & Subscribers ─── */

  it("9. outbox — insert and verify pending status", () => {
    eventsRepo.append({ eventId: "e-out", eventType: "RunCreated", aggregateType: "run", aggregateId: "r-out", aggregateVersion: 1, data: "{}" })
    const out = eventsRepo.insertOutbox({
      id: "out-1", eventId: "e-out", eventType: "RunCreated", aggregateId: "r-out",
      data: "{}", idempotencyKey: "ik-1", sourceComponent: "orchestrator",
    })
    expect(out.status).toBe("pending")
    expect(out.idempotencyKey).toBe("ik-1")
  })

  it("10. subscriber registration — INSERT OR IGNORE", () => {
    eventsRepo.registerSubscriber("sub-1", "EventHandler", "webhook", "RunCreated,RunCompleted")
    eventsRepo.registerSubscriber("sub-1", "EventHandler", "webhook", "RunCreated,RunCompleted")
  })

  /* ─── Worktrees ─── */

  it("11. worktree CRUD", () => {
    runsRepo.create({ runId: "run-wt", contractId: CFG.contract, strategy: "simple", baselineSha: "a", repoBranch: "main" })
    const wt = workRepo.create({ id: "wt-1", runId: "run-wt", repositoryId: "repo-1", path: "/tmp/wt1", branch: "feature/x", phase: 1 })
    expect(wt.id).toBe("wt-1")
    expect(wt.path).toBe("/tmp/wt1")
    expect(wt.status).toBe("active")

    const loaded = workRepo.findById("wt-1")
    expect(loaded!.id).toBe("wt-1")
  })

  it("12. worktree findByRun", () => {
    runsRepo.create({ runId: "run-A", contractId: CFG.contract, strategy: "simple", baselineSha: "a", repoBranch: "main" })
    runsRepo.create({ runId: "run-B", contractId: CFG.contract, strategy: "simple", baselineSha: "a", repoBranch: "main" })
    workRepo.create({ id: "wt-a", runId: "run-A", repositoryId: "r1", path: "/tmp/a", branch: "b1", phase: 1 })
    workRepo.create({ id: "wt-b", runId: "run-A", repositoryId: "r1", path: "/tmp/b", branch: "b2", phase: 2 })
    workRepo.create({ id: "wt-c", runId: "run-B", repositoryId: "r1", path: "/tmp/c", branch: "b3", phase: 1 })
    expect(workRepo.findByRun("run-A")).toHaveLength(2)
    expect(workRepo.findByRun("run-B")).toHaveLength(1)
  })

  /* ─── Failure recovery & idempotency ─── */

  it("13. failure recovery from event log after crash", () => {
    eventsRepo.append({ eventId: "cr1", eventType: "RunCreated", aggregateType: "run", aggregateId: "r-crash", aggregateVersion: 1, data: '{"taskType":"build"}' })
    eventsRepo.append({ eventId: "cr2", eventType: "RunAssigned", aggregateType: "run", aggregateId: "r-crash", aggregateVersion: 2, data: '{"worker":"w1"}' })
    eventsRepo.append({ eventId: "cr3", eventType: "RunStarted", aggregateType: "run", aggregateId: "r-crash", aggregateVersion: 3, data: '{"state":"running"}' })
    const recovered = eventsRepo.queryRange(1).filter(e => e.aggregateId === "r-crash")
    expect(recovered).toHaveLength(3)
    let state = "unknown"
    for (const e of recovered) {
      if (e.eventType === "RunCreated") state = "pending"
      else if (e.eventType === "RunAssigned") state = "assigned"
      else if (e.eventType === "RunStarted") state = "running"
    }
    expect(state).toBe("running")
    eventsRepo.append({ eventId: "cr4", eventType: "RunCompleted", aggregateType: "run", aggregateId: "r-crash", aggregateVersion: 4, data: '{"outcome":"success"}' })
    expect(eventsRepo.queryRange(1).filter(e => e.aggregateId === "r-crash")).toHaveLength(4)
  })

  it("14. idempotency — duplicate eventId rejected", () => {
    eventsRepo.append({ eventId: "idem-1", eventType: "RunCreated", aggregateType: "run", aggregateId: "r-idem", aggregateVersion: 1, data: "{}" })
    try { eventsRepo.append({ eventId: "idem-1", eventType: "RunCreated", aggregateType: "run", aggregateId: "r-idem", aggregateVersion: 1, data: "{}" }) }
    catch { /* expected */ }
    expect(eventsRepo.queryRange(1).filter(e => e.aggregateId === "r-idem")).toHaveLength(1)
  })

  /* ─── Cross-aggregate ordering & edge cases ─── */

  it("15. cross-aggregate global sequence ordering", () => {
    eventsRepo.append({ eventId: "x1", eventType: "RunCreated", aggregateType: "run", aggregateId: "r-a", aggregateVersion: 1, data: "{}" })
    eventsRepo.append({ eventId: "x2", eventType: "RunCreated", aggregateType: "run", aggregateId: "r-b", aggregateVersion: 1, data: "{}" })
    eventsRepo.append({ eventId: "x3", eventType: "RunStarted", aggregateType: "run", aggregateId: "r-a", aggregateVersion: 2, data: "{}" })
    eventsRepo.append({ eventId: "x4", eventType: "RunStarted", aggregateType: "run", aggregateId: "r-b", aggregateVersion: 2, data: "{}" })
    eventsRepo.append({ eventId: "x5", eventType: "RunCompleted", aggregateType: "run", aggregateId: "r-a", aggregateVersion: 3, data: "{}" })
    const all = eventsRepo.queryRange(1)
    expect(all).toHaveLength(5)
    for (let i = 1; i < all.length; i++) expect(all[i].globalSequence).toBe(all[i - 1].globalSequence + 1)
  })

  it("16. edge cases — empty queries, non-existent lookups", () => {
    expect(eventsRepo.queryRange(9999)).toHaveLength(0)
    expect(runsRepo.findById("no-such-run")).toBeUndefined()
    expect(eventsRepo.queryRange(10, 5)).toHaveLength(0)
  })
})
