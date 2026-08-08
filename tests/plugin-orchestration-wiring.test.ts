import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import { unlinkSync, existsSync, rmSync, mkdirSync } from "node:fs"
import { initializeDatabase, closeConnection } from "../src/orchestration/persistence"
import { createProductionOrchestrationRuntime } from "../src/orchestration/composition"
import type { Database } from "bun:sqlite"

const TEST_DIR = join(process.cwd(), ".flowdeck-test-wiring")
const TEST_DB = join(TEST_DIR, "flowdeck.db")

describe("Plugin Orchestration Wiring (Phase 8 Gap)", () => {
  let db: Database

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    const init = initializeDatabase({ path: TEST_DB })
    db = init.db
  })

  afterEach(() => {
    closeConnection(TEST_DB)
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
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
