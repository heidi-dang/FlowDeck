import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, rmSync as rm } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  FileTokenUsageStore,
  type UsageStoreEntry,
} from "../src/services/token-usage-store"

function makeUsageEntry(overrides: Partial<Record<string, unknown>> = {}): UsageStoreEntry {
  const base: any = {
    kind: "usage",
    runId: "run-1",
    sessionId: "s1",
    agent: "heidi",
    requestId: "req-1",
    messageId: "msg-1",
    reservationId: "res-1",
    attempt: 1,
    input: 100,
    output: 50,
    reasoning: 10,
    cacheRead: 5,
    cacheWrite: 5,
    billable: 170,
    status: "committed",
    recordedAt: new Date().toISOString(),
  }
  return { ...base, ...overrides } as UsageStoreEntry
}

describe("FileTokenUsageStore — hot-path in-memory index (Fast Harness v1)", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fh-token-")) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it("hot query performs no full JSONL re-read after warm-up (file removed → index still answers)", () => {
    const store = new FileTokenUsageStore(dir)
    store.append("run-1", { kind: "reservation", runId: "run-1", sessionId: "s1", agentId: "heidi", requestId: "req-1", attempt: 1, estimatedInput: 100, maxOutput: 100, claimed: 200, status: "reserved" })
    store.append("run-1", makeUsageEntry({ billable: 170 }))

    // Warm the index, then DELETE the durable file: read() should still answer from memory.
    const p = store.pathFor("run-1")
    expect(readFileSync(p, "utf-8").split("\n").filter(l => l.trim()).length).toBe(2)
    rm(p, { force: true })

    const entries = store.read("run-1")
    expect(entries).toHaveLength(2)
    const rebuilt = store.rebuild("run-1")
    expect(rebuilt.consumed).toBe(170)
    expect(rebuilt.committedIds).toContain("res-1")
    expect(rebuilt.reservations).toHaveLength(0)
  })

  it("restart rebuild reads the JSONL once and reproduces identical state", () => {
    const store = new FileTokenUsageStore(dir)
    store.append("run-2", { kind: "reservation", runId: "run-2", sessionId: "s1", agentId: "heidi", requestId: "req-a", attempt: 1, estimatedInput: 100, maxOutput: 100, claimed: 300, status: "reserved" })
    store.append("run-2", makeUsageEntry({ runId: "run-2", requestId: "req-a", messageId: "m-a", reservationId: "res-A", billable: 210 }))
    const before = store.rebuild("run-2")

    // New store instance = new process/restart: rebuild from durable JSONL.
    const store2 = new FileTokenUsageStore(dir)
    const after = store2.rebuild("run-2")
    expect(after.consumed).toBe(before.consumed)
    expect(after.reserved).toBe(before.reserved)
    expect(after.records).toHaveLength(before.records.length)
  })

  it("duplicate usage events remain idempotent (last-wins, no double count)", () => {
    const store = new FileTokenUsageStore(dir)
    store.append("run-3", makeUsageEntry({ runId: "run-3", requestId: "req-x", messageId: "m-x", billable: 100 }))
    store.append("run-3", makeUsageEntry({ runId: "run-3", requestId: "req-x", messageId: "m-x", billable: 180 }))
    const rebuilt = store.rebuild("run-3")
    expect(rebuilt.consumed).toBe(180)
    expect(rebuilt.records).toHaveLength(1)
  })

  it("reclaim + redistribution totals preserved across hot index and rebuild", () => {
    const store = new FileTokenUsageStore(dir)
    store.append("run-4", { kind: "adaptive_reclaim", eventId: "e1", reservationId: "res-1", workstreamId: "w1", reserved: 500, actual: 300, reclaimed: 200, reason: "over-reserved", at: 1 })
    store.append("run-4", { kind: "adaptive_redistribution", eventId: "e2", reservationId: "res-1", targetWorkstreamId: "w2", amount: 150, reason: "shift", at: 2 })
    const rebuilt = store.rebuild("run-4")
    expect(rebuilt.reclaimed).toBe(200)
    expect(rebuilt.redistributed).toBe(150)
    // Hot index maintained incrementally:
    store.append("run-4", { kind: "adaptive_reclaim", eventId: "e3", reservationId: "res-2", workstreamId: "w1", reserved: 800, actual: 500, reclaimed: 300, reason: "over", at: 3 })
    const rebuilt2 = store.rebuild("run-4")
    expect(rebuilt2.reclaimed).toBe(500)
  })

  it("termination state and committed IDs indexed", () => {
    const store = new FileTokenUsageStore(dir)
    store.append("run-5", { kind: "terminal", reason: "budget_exhausted", at: 99 })
    store.append("run-5", makeUsageEntry({ runId: "run-5", requestId: "req-y", messageId: "m-y", reservationId: "res-Y", billable: 45 }))
    const rebuilt = store.rebuild("run-5")
    expect(rebuilt.terminal?.reason).toBe("budget_exhausted")
    expect(rebuilt.committedIds).toContain("res-Y")
  })

  it("jsonl remains the durability source: memory-only state is never the only copy", () => {
    const store = new FileTokenUsageStore(dir)
    store.append("run-6", makeUsageEntry({ runId: "run-6", requestId: "req-z", messageId: "m-z", billable: 77 }))
    const p = store.pathFor("run-6")
    const raw = readFileSync(p, "utf-8")
    expect(raw).toContain("\"kind\":\"usage\"")
    expect(raw).toContain("\"billable\":77")
  })

  it("read() returns a copy — callers cannot mutate the hot index", () => {
    const store = new FileTokenUsageStore(dir)
    store.append("run-7", makeUsageEntry({ runId: "run-7", requestId: "req-7", messageId: "m-7", billable: 1 }))
    const entries = store.read("run-7") as any[]
    entries.length = 0
    expect(store.read("run-7")).toHaveLength(1)
  })
})
