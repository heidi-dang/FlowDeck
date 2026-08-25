import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { initializeDatabase, closeConnection } from "../src/orchestration/persistence"
import { createProductionOrchestrationRuntime } from "../src/orchestration/composition"
import type { Database } from "bun:sqlite"

describe("Plugin Orchestration Wiring (Phase 8 Gap)", () => {
  let db: Database
  let testDir = ""
  let testDb = ""

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "flowdeck-test-wiring-"))
    testDb = join(testDir, "flowdeck.db")
    const init = initializeDatabase({ path: testDb })
    db = init.db
  })

  afterEach(() => {
    closeConnection(testDb)
    // Bun may retain a Windows WAL handle after close. Each fixture is unique,
    // so retaining that completed fixture does not affect later assertions.
    if (process.platform !== "win32" && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it("initializes production orchestration runtime with all services, repositories, and router", () => {
    const runtime = createProductionOrchestrationRuntime(db)

    expect(runtime).toBeDefined()
    expect(runtime.db).toBe(db)
    expect(runtime.services.runService).toBeDefined()
    expect(runtime.services.contractService).toBeDefined()
    expect(runtime.services.assignmentService).toBeDefined()
    expect(runtime.services.verificationService).toBeDefined()
    expect(runtime.services.completionService).toBeDefined()
    expect(runtime.services.replayService).toBeDefined()
    expect(runtime.services.eventService).toBeDefined()
    expect(runtime.services.healthService).toBeDefined()

    expect(runtime.sessionRepo).toBeDefined()
    expect(runtime.contextItemRepo).toBeDefined()
    expect(runtime.consumerOffsetRepo).toBeDefined()

    expect(runtime.outboxWorker).toBeDefined()
    expect(runtime.deliverySink).toBeDefined()
    expect(runtime.router).toBeDefined()
  })

  it("processes health checks on initialized runtime successfully", async () => {
    const runtime = createProductionOrchestrationRuntime(db)
    const health = await runtime.services.healthService.checkHealth()

    expect(health.status).toBe("healthy")
    expect(health.checks.find(c => c.name === "db")?.status).toBe("healthy")
    expect(health.checks.find(c => c.name === "outbox_worker")?.status).toBe("healthy")
    expect(health.checks.find(c => c.name === "replay_service")?.status).toBe("healthy")
  })
})
