import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import { unlinkSync, existsSync } from "node:fs"
import { openConnection, closeConnection } from "../../src/orchestration/persistence/connection"
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../../src/orchestration/persistence/transaction-manager"
import { SqliteConsumerOffsetRepository } from "../../src/orchestration/persistence/repositories/consumer-offset"
import type { Database } from "bun:sqlite"

const TEST_DB = join(process.cwd(), ".flowdeck", "test-consumer-offset.db")

describe("Consumer Offset Persistence (Phase 4 Gap)", () => {
  let db: Database

  beforeEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
    db = openConnection({ path: TEST_DB })
    runMigrations(db)
  })

  afterEach(() => {
    closeConnection(TEST_DB)
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  it("sets, gets, and lists consumer offsets", () => {
    const tx = createTransactionManager(db)
    const offsetRepo = new SqliteConsumerOffsetRepository(db, tx)

    const created = offsetRepo.setOffset("subscriber-1", 42, "active")
    expect(created.subscriberId).toBe("subscriber-1")
    expect(created.lastProcessedSequence).toBe(42)
    expect(created.status).toBe("active")

    const fetched = offsetRepo.getOffset("subscriber-1")
    expect(fetched).toBeDefined()
    expect(fetched?.lastProcessedSequence).toBe(42)

    offsetRepo.setOffset("subscriber-1", 45, "paused")
    const updated = offsetRepo.getOffset("subscriber-1")
    expect(updated?.lastProcessedSequence).toBe(45)
    expect(updated?.status).toBe("paused")

    const list = offsetRepo.listOffsets()
    expect(list.length).toBe(1)
    expect(list[0].subscriberId).toBe("subscriber-1")
  })

  it("supports cursor resets, pausing, and blocking", () => {
    const tx = createTransactionManager(db)
    const offsetRepo = new SqliteConsumerOffsetRepository(db, tx)

    offsetRepo.setOffset("sub-2", 100, "active")

    const pauseUntil = new Date("2026-01-01T00:00:00Z")
    const paused = offsetRepo.pauseOffset("sub-2", pauseUntil)
    expect(paused?.status).toBe("paused")
    expect(paused?.pausedUntil).toBe(pauseUntil.toISOString())

    const blocked = offsetRepo.blockOffset("sub-2", "evt-999")
    expect(blocked?.status).toBe("blocked")
    expect(blocked?.blockedByEventId).toBe("evt-999")

    const reset = offsetRepo.resetOffset("sub-2", 0)
    expect(reset?.lastProcessedSequence).toBe(0)
    expect(reset?.status).toBe("active")
    expect(reset?.pausedUntil).toBeNull()
    expect(reset?.blockedByEventId).toBeNull()

    const nonExistentReset = offsetRepo.resetOffset("sub-unknown", 0)
    expect(nonExistentReset).toBeUndefined()
  })
})
