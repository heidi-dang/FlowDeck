import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { unlinkSync } from "node:fs"
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../../src/orchestration/persistence/transaction-manager"
import { SqliteRoutingDecisionRepository } from "../../src/orchestration/routing/sqlite-store"
import { routeTask } from "../../src/orchestration/routing/intelligence"

describe("authoritative SQLite routing decisions", () => {
  let db: Database
  let repo: SqliteRoutingDecisionRepository
  beforeEach(() => { db = new Database(":memory:"); runMigrations(db); repo = new SqliteRoutingDecisionRepository(db, createTransactionManager(db)) })
  afterEach(() => db.close())
  const decision = (runId: string, text = "Implement a small bug fix") => routeTask({ runId, sourceSha: "0123456789abcdef0123456789abcdef01234567", task: text })

  it("saves, reloads, versions, and isolates decisions by run", () => {
    const first = repo.saveDecision(decision("run-a"))
    const second = repo.saveDecision(decision("run-a", "Implement another bug fix"))
    repo.saveDecision(decision("run-b"))
    expect(repo.get(first.routingDecisionId)).toEqual(first)
    expect(repo.getLatestDecisionForRun("run-a")).toEqual(second)
    expect(repo.listDecisionsForRun("run-a")).toHaveLength(2)
    expect(repo.listDecisionsForRun("run-a").every(d => d.runId === "run-a")).toBe(true)
    expect(second.decisionVersion).toBe(2)
  })

  it("allows exact idempotent replay but rejects mutation of a finalized identity", () => {
    const saved = repo.saveDecision(decision("run-a"))
    expect(repo.saveDecision(saved)).toEqual(saved)
    expect(() => repo.saveDecision({ ...saved, rationale: ["mutated"] })).toThrow("ROUTING_DECISION_IMMUTABLE")
    const reloaded = repo.get(saved.routingDecisionId)!
    expect(() => { (reloaded as any).strategy = "direct" }).not.toThrow()
    expect(repo.get(saved.routingDecisionId)!.strategy).toBe(saved.strategy)
  })

  it("reconstructs the same canonical record after reopening", () => {
    const path = `/tmp/flowdeck-routing-${Date.now()}-${Math.random()}.db`
    db.close(); db = new Database(path); runMigrations(db)
    repo = new SqliteRoutingDecisionRepository(db, createTransactionManager(db))
    const saved = repo.saveDecision(decision("run-a"))
    db.close(); db = new Database(path)
    repo = new SqliteRoutingDecisionRepository(db, createTransactionManager(db))
    expect(repo.get(saved.routingDecisionId)).toEqual(saved)
    db.close(); unlinkSync(path)
  })
})
