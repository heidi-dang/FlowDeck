import { describe, it, expect } from "bun:test"
import { validatePersistedEvent, rehydrateAggregate, deterministicReplay } from "../src/domain/orchestration/runtime/event-store/rehydration"
import { InMemoryTaskRunRepository, InMemorySessionRepository } from "../src/domain/orchestration/runtime/in-memory-repositories"

describe("Rehydration and Runtime In-Memory Repositories Deep Tests", () => {
  it("validatePersistedEvent validates event fields and integrity", () => {
    const validRes = validatePersistedEvent({
      aggregateId: "agg-1",
      aggregateVersion: 1,
      payloadHash: "hash123",
      checksum: "check123",
      eventType: "RunCreated",
      event: {}
    } as any)
    expect(validRes.valid).toBe(true)

    const invalidRes = validatePersistedEvent({
      aggregateId: "",
      aggregateVersion: 0,
      payloadHash: "",
      checksum: "",
      eventType: "RunCreated",
      event: {}
    } as any)
    expect(invalidRes.valid).toBe(false)
    if (!invalidRes.valid) {
      expect(invalidRes.errors.length).toBeGreaterThan(0)
    }
  })

  it("rehydrateAggregate reconstructs aggregate state from event stream", async () => {
    const events: any[] = [
      {
        aggregateId: "agg-1",
        aggregateVersion: 1,
        payloadHash: "h1",
        checksum: "c1",
        eventType: "RunCreated",
        event: { strategy: "planned" },
        createdAt: new Date()
      },
      {
        aggregateId: "agg-1",
        aggregateVersion: 2,
        payloadHash: "h2",
        checksum: "c2",
        eventType: "RunStartedPlanning",
        event: {}
      },
      {
        aggregateId: "agg-1",
        aggregateVersion: 3,
        payloadHash: "h3",
        checksum: "c3",
        eventType: "RunStartedExecution",
        event: { delegationTarget: "agent-2" }
      },
      {
        aggregateId: "agg-1",
        aggregateVersion: 4,
        payloadHash: "h4",
        checksum: "c4",
        eventType: "RunCompleted",
        event: {}
      }
    ]

    const result = await rehydrateAggregate("agg-1", events)
    expect(result.aggregateId).toBe("agg-1")
    expect(result.version).toBe(4)
    expect(result.eventsApplied).toBe(4)
  })

  it("rehydrateAggregate detects version gaps and invalid events", async () => {
    const events: any[] = [
      {
        aggregateId: "agg-1",
        aggregateVersion: 1,
        payloadHash: "h1",
        checksum: "c1",
        eventType: "RunCreated",
        event: {}
      },
      {
        aggregateId: "agg-1",
        aggregateVersion: 3, // gap!
        payloadHash: "h3",
        checksum: "c3",
        eventType: "RunStartedPlanning",
        event: {}
      }
    ]

    const result = await rehydrateAggregate("agg-1", events)
    expect(result.replayErrors).toBeDefined()
    expect(result.replayErrors?.length).toBeGreaterThan(0)
  })

  it("deterministicReplay yields state transition list", () => {
    const events: any[] = [
      { aggregateVersion: 1, eventType: "RunCreated" },
      { aggregateVersion: 2, eventType: "RunStartedPlanning" },
      { aggregateVersion: 3, eventType: "RunStartedExecution" },
      { aggregateVersion: 4, eventType: "RunCompleted" }
    ]
    const transitions = deterministicReplay(events)
    expect(transitions).toEqual(["created", "planning", "executing", "completed"])
  })

  it("InMemoryTaskRunRepository CRUD operations", async () => {
    const repo = new InMemoryTaskRunRepository()
    const run: any = {
      id: "run-1",
      aggregateId: "agg-1",
      status: "created",
      version: 1
    }

    await repo.save(run)
    const fetched = await repo.findById("agg-1")
    expect(fetched).toBeDefined()
    expect(fetched?.aggregateId).toBe("agg-1")

    const allRuns = repo.getAll()
    expect(allRuns.length).toBe(1)
  })

  it("InMemorySessionRepository CRUD operations", async () => {
    const repo = new InMemorySessionRepository()
    const session: any = {
      id: "sess-1",
      runId: "run-1",
      agentName: "agent-1",
      status: "active",
      createdAt: new Date()
    }

    await repo.save(session)
    const fetched = await repo.findById("sess-1")
    expect(fetched).toBeDefined()
    expect(fetched?.id).toBe("sess-1")

    const active = repo.getActiveSessionsForRun("run-1")
    expect(active.length).toBe(1)
  })
})
