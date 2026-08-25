import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { openConnection, closeConnection } from "../../src/orchestration/persistence/connection"
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../../src/orchestration/persistence/transaction-manager"
import { SqliteSessionRepository } from "../../src/orchestration/persistence/repositories/session"
import { SqliteContextItemRepository } from "../../src/orchestration/persistence/repositories/context-item"
import { TaskRunsRepository } from "../../src/orchestration/persistence/repositories/task-run"
import type { Database } from "bun:sqlite"


function seedContract(db: Database, contractId: string = "contract-1", familyId: string = "fam-1") {
  db.query(
    `INSERT OR IGNORE INTO contract_families (family_id, name, created_by, created_at)
     VALUES (?, 'Family 1', 'system', datetime('now'))`
  ).run(familyId)
  db.query(
    `INSERT OR IGNORE INTO task_contracts (
      contract_id, family_id, version, title, description, repo_url, repo_sha, created_by, created_at
    ) VALUES (?, ?, 1, 'Contract Title', 'Description', 'https://repo', 'abc', 'system', datetime('now'))`
  ).run(contractId, familyId)
}

describe("Session and Context Persistence (Phase 3 Gap)", () => {
  let db: Database
  let testDirectory: string
  let testDb: string

  beforeEach(() => {
    testDirectory = mkdtempSync(join(tmpdir(), "flowdeck-session-context-"))
    testDb = join(testDirectory, "session-context.db")
    db = openConnection({ path: testDb })
    runMigrations(db)
  })

  afterEach(() => {
    closeConnection(testDb)
    rmSync(testDirectory, { recursive: true, force: true })
  })

  it("persists agent session and updates status and metrics", () => {
    const tx = createTransactionManager(db)
    const taskRunsRepo = new TaskRunsRepository(db, tx)
    const sessionRepo = new SqliteSessionRepository(db, tx)

    seedContract(db, "contract-1")

    taskRunsRepo.create({
      runId: "run-100",
      contractId: "contract-1",
      strategy: "simple",
      baselineSha: "abc",
      repoBranch: "main",
    })

    const created = sessionRepo.create({
      id: "sess-1",
      runId: "run-100",
      agentId: "heidi",
      depth: 0,
      status: "created",
    })

    expect(created.id).toBe("sess-1")
    expect(created.runId).toBe("run-100")
    expect(created.agentId).toBe("heidi")
    expect(created.status).toBe("created")

    const updated = sessionRepo.updateStatus("sess-1", "running")
    expect(updated).toBe(true)

    sessionRepo.incrementMetrics("sess-1", 5, 2)
    const fetched = sessionRepo.findById("sess-1")
    expect(fetched?.status).toBe("running")
    expect(fetched?.toolCalls).toBe(5)
    expect(fetched?.delegations).toBe(2)

    const runSessions = sessionRepo.findByRunId("run-100")
    expect(runSessions.length).toBe(1)
    expect(runSessions[0].id).toBe("sess-1")
  })

  it("persists context items and retrieves by run and session", () => {
    const tx = createTransactionManager(db)
    const taskRunsRepo = new TaskRunsRepository(db, tx)
    const sessionRepo = new SqliteSessionRepository(db, tx)
    const contextRepo = new SqliteContextItemRepository(db, tx)

    seedContract(db, "contract-1")

    taskRunsRepo.create({
      runId: "run-200",
      contractId: "contract-1",
      strategy: "simple",
      baselineSha: "abc",
      repoBranch: "main",
    })

    sessionRepo.create({
      id: "sess-2",
      runId: "run-200",
      agentId: "coder",
    })

    const item1 = contextRepo.create({
      id: "ctx-1",
      runId: "run-200",
      sessionId: "sess-2",
      source: "user",
      priority: 10,
      category: "prompt",
      contentType: "inline_text",
      content: "Initial user request",
      contentHash: "hash123",
      tokenEstimate: 50,
    })

    expect(item1.id).toBe("ctx-1")
    expect(item1.priority).toBe(10)

    const byRun = contextRepo.findByRunId("run-200")
    expect(byRun.length).toBe(1)

    const bySession = contextRepo.findBySessionId("sess-2")
    expect(bySession.length).toBe(1)

    const deleted = contextRepo.delete("ctx-1")
    expect(deleted).toBe(true)
    expect(contextRepo.findById("ctx-1")).toBeUndefined()
  })
})
