import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { FileTokenUsageStore, InMemoryTokenUsageStore } from "../../src/services/token-usage-store"

let dirs: string[] = []

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fd-usage-store-"))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe("FileTokenUsageStore", () => {
  it("persists and reads back entries", () => {
    const dir = freshDir()
    const store = new FileTokenUsageStore(dir)
    store.append("run-1", { kind: "reservation", reservationId: "res-1", claimed: 100, status: "reserved" })
    store.append("run-1", {
      kind: "usage",
      runId: "run-1",
      sessionId: "s",
      agent: "a",
      requestId: "req-1",
      attempt: 1,
      input: 40,
      output: 10,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      billable: 50,
      status: "committed",
      recordedAt: new Date().toISOString(),
    })
    const entries = store.read("run-1")
    expect(entries).toHaveLength(2)
    expect(entries[0].kind).toBe("reservation")
    expect(entries[1].kind).toBe("usage")
  })

  it("sanitises unsafe run ids in file paths", () => {
    const dir = freshDir()
    const store = new FileTokenUsageStore(dir)
    const p = store.pathFor("run/../evil")
    expect(p).toContain("run_.._evil.jsonl")
  })

  it("rebuild releases committed reservations", () => {
    const dir = freshDir()
    const store = new FileTokenUsageStore(dir)
    store.append("run-1", { kind: "reservation", reservationId: "res-1", claimed: 500, status: "reserved" })
    store.append("run-1", {
      kind: "usage",
      runId: "run-1",
      sessionId: "s",
      agent: "a",
      requestId: "req-1",
      reservationId: "res-1",
      attempt: 1,
      input: 100,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      billable: 100,
      status: "committed",
      recordedAt: new Date().toISOString(),
    })
    const rebuilt = store.rebuild("run-1")
    expect(rebuilt.consumed).toBe(100)
    expect(rebuilt.reserved).toBe(0)
  })

  it("dedups usage records by message/request id", () => {
    const dir = freshDir()
    const store = new FileTokenUsageStore(dir)
    store.append("run-1", {
      kind: "usage",
      runId: "run-1",
      sessionId: "s",
      agent: "a",
      requestId: "req-1",
      attempt: 1,
      input: 100,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      billable: 100,
      status: "committed",
      recordedAt: new Date().toISOString(),
    })
    store.append("run-1", {
      kind: "usage",
      runId: "run-1",
      sessionId: "s",
      agent: "a",
      requestId: "req-1",
      attempt: 1,
      input: 900,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      billable: 900,
      status: "committed",
      recordedAt: new Date().toISOString(),
    })
    const rebuilt = store.rebuild("run-1")
    expect(rebuilt.consumed).toBe(900) // later record wins on dedup rebuild
    expect(rebuilt.records).toHaveLength(1)
  })

  it("tolerates corrupt lines", () => {
    const dir = freshDir()
    const store = new FileTokenUsageStore(dir)
    store.append("run-1", { kind: "terminal", reason: "x", at: 1 })
    const p = store.pathFor("run-1")
    // Append a corrupt line directly.
    const { appendFileSync } = require("fs")
    appendFileSync(p, "{not json}\n", "utf-8")
    const entries = store.read("run-1")
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("terminal")
  })

  it("records are append-only on disk", () => {
    const dir = freshDir()
    const store = new FileTokenUsageStore(dir)
    store.append("run-1", { kind: "terminal", reason: "x", at: 1 })
    const raw = readFileSync(store.pathFor("run-1"), "utf-8")
    expect(raw.trimEnd().split("\n")).toHaveLength(1)
  })
})

describe("InMemoryTokenUsageStore", () => {
  it("supports append/read/rebuild", () => {
    const store = new InMemoryTokenUsageStore()
    store.append("run-1", { kind: "terminal", reason: "x", at: 1 })
    store.append("run-1", { kind: "warning", runId: "run-1", at: 2 })
    expect(store.read("run-1")).toHaveLength(2)
    const rebuilt = store.rebuild("run-1")
    expect(rebuilt.terminal?.reason).toBe("x")
    expect(rebuilt.warningFired).toBe(true)
  })

  it("returns empty for unknown run", () => {
    const store = new InMemoryTokenUsageStore()
    expect(store.read("nope")).toHaveLength(0)
    expect(store.rebuild("nope").consumed).toBe(0)
  })
})