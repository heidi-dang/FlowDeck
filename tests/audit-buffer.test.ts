import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  appendAuditEvent,
  flushAuditBuffer,
  bufferedAuditCount,
  resetAuditBufferForTests,
  auditLogPath,
} from "../src/services/audit-log"

describe("AuditLog — bounded buffered persistence (Fast Harness v1)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fh-audit-"))
    resetAuditBufferForTests()
  })
  afterEach(() => {
    try { flushAuditBuffer() } catch {}
    resetAuditBufferForTests()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it("normal guard.allow event is buffered (no file until flush)", () => {
    appendAuditEvent(dir, { kind: "guard.allow", decision: "allow", reason: "read ok" })
    expect(existsSync(auditLogPath(dir))).toBe(false)
    expect(bufferedAuditCount()).toBe(1)
    flushAuditBuffer()
    expect(existsSync(auditLogPath(dir))).toBe(true)
    const lines = readFileSync(auditLogPath(dir), "utf-8").trim().split("\n")
    const parsed = JSON.parse(lines[0])
    expect(parsed.kind).toBe("guard.allow")
  })

  it("critical block event persists immediately (safe decision never lost)", () => {
    appendAuditEvent(dir, { kind: "guard.block", decision: "block", reason: "policy violation", tool: "bash" })
    expect(existsSync(auditLogPath(dir))).toBe(true)
    const lines = readFileSync(auditLogPath(dir), "utf-8").trim().split("\n")
    const parsed = JSON.parse(lines[0])
    expect(parsed.kind).toBe("guard.block")
  })

  it("policy violation (supervisor.block) persists immediately", () => {
    appendAuditEvent(dir, { kind: "supervisor.block", decision: "block", reason: "rule violation" })
    expect(existsSync(auditLogPath(dir))).toBe(true)
  })

  it("delegation lifecycle events persist immediately (not on read hot path)", () => {
    appendAuditEvent(dir, { kind: "delegation.started", agent: "heidi", tool: "task", decision: "start" })
    appendAuditEvent(dir, { kind: "delegation.completed", agent: "heidi", tool: "task", decision: "done" })
    expect(existsSync(auditLogPath(dir))).toBe(true)
    const lines = readFileSync(auditLogPath(dir), "utf-8").trim().split("\n")
    expect(lines).toHaveLength(2)
  })

  it("queue is bounded (size flush prevents unbounded growth)", () => {
    for (let i = 0; i < 150; i++) {
      appendAuditEvent(dir, { kind: "guard.allow", decision: "allow", reason: "evt-" + i })
    }
    // Size threshold (100) forces at least one flush during the loop.
    expect(bufferedAuditCount()).toBeLessThanOrEqual(100)
    flushAuditBuffer()
    const lines = readFileSync(auditLogPath(dir), "utf-8").trim().split("\n")
    expect(lines).toHaveLength(150)
  })

  it("dispose flush writes all pending buffered events", () => {
    appendAuditEvent(dir, { kind: "guard.allow", decision: "allow", reason: "a" })
    appendAuditEvent(dir, { kind: "routing.decision", decision: "FAST_DIRECT", reason: "reasonCode" })
    appendAuditEvent(dir, { kind: "session.started", reason: "s" })
    expect(existsSync(auditLogPath(dir))).toBe(false)
    flushAuditBuffer()
    const lines = readFileSync(auditLogPath(dir), "utf-8").trim().split("\n")
    expect(lines).toHaveLength(3)
  })

  it("secret redaction preserved on buffered events", () => {
    appendAuditEvent(dir, { kind: "guard.allow", decision: "allow", reason: "ok", details: { token: "sk-live-abc123" } })
    flushAuditBuffer()
    const raw = readFileSync(auditLogPath(dir), "utf-8")
    expect(raw).not.toContain("sk-live-abc123")
  })

  it("logging failure is non-fatal (append never throws)", () => {
    // A path that cannot be created: use a FILE as the codebase dir parent.
    const bogus = join(dir, "regular-file")
    const { writeFileSync } = require("fs") as typeof import("fs")
    writeFileSync(bogus, "x")
    expect(() => appendAuditEvent(bogus, { kind: "guard.allow", decision: "allow", reason: "r" })).not.toThrow()
    expect(() => appendAuditEvent(bogus, { kind: "guard.block", decision: "block", reason: "r" })).not.toThrow()
  })
})
