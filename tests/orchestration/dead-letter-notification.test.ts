import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "node:path"
import { unlinkSync, existsSync } from "node:fs"
import { openConnection, closeConnection } from "../../src/orchestration/persistence/connection"
import { runMigrations } from "../../src/orchestration/persistence/migrations/migration-runner"
import { createTransactionManager } from "../../src/orchestration/persistence/transaction-manager"
import { SqliteDeliverySink } from "../../src/orchestration/persistence/adapters/sqlite-delivery-sink"
import { OutboxWorker } from "../../src/orchestration/services/outbox-worker"
import { InMemoryEventBus } from "../../src/orchestration/services/event-bus-impl"
import type { Database } from "bun:sqlite"
import type { OrchestrationEvent } from "../../src/orchestration/types/events"

const TEST_DB = join(process.cwd(), ".flowdeck", "test-dead-letter.db")

describe("Dead-Letter Event Subscriber Notification (Phase 5 Gap)", () => {
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

  it("records dead letter and emits outbox.dead_letter event on terminal retry failure", async () => {
    const tx = createTransactionManager(db)
    const deliverySink = new SqliteDeliverySink(db, tx)
    const eventBus = new InMemoryEventBus()
    const worker = new OutboxWorker(deliverySink, eventBus, { workerId: "test-worker", batchSize: 10, leaseSeconds: 60 })

    const nowTs = Math.floor(Date.now() / 1000)

    db.query(
      `INSERT INTO events (
        event_id, event_type, event_version, aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts
      ) VALUES (
        'evt-dl-1', 'test.failing_event', 1, 'test', 'agg-1', 1, datetime('now'), '{}', '{}', ?
      )`
    ).run(nowTs)

    db.query(
      `INSERT INTO event_outbox (
        id, event_id, event_type, aggregate_id, data, status, retry_count, idempotency_key, source_component, created_ts
      ) VALUES (
        'outbox-dl-1', 'evt-dl-1', 'test.failing_event', 'agg-1', '{"foo":"bar"}', 'pending', 2, 'idem-dl-1', 'test', ?
      )`
    ).run(nowTs)

    // Subscribe to outbox.dead_letter
    const deadLettersEmitted: OrchestrationEvent[] = []
    eventBus.subscribe("outbox.dead_letter", async (evt) => {
      deadLettersEmitted.push(evt)
    })

    // Also subscribe failing handler for test.failing_event so eventBus.publish fails
    eventBus.subscribe("test.failing_event", async () => {
      throw new Error("Permanent delivery failure")
    })

    // Process batch (attemptCount becomes 2 + 1 = 3 >= maxRetries 3)
    const result = await worker.processBatch()

    expect(result.failed).toBe(1)
    expect(deadLettersEmitted.length).toBe(1)
    expect(deadLettersEmitted[0].type).toBe("outbox.dead_letter")
    expect(deadLettersEmitted[0].data.outboxId).toBe("outbox-dl-1")
    expect(deadLettersEmitted[0].data.lastError).toContain("Permanent delivery failure")

    const failedCount = await deliverySink.countByStatus("failed")
    expect(failedCount).toBe(1)
  })
})
