import { describe, expect, it, afterAll } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deriveOperationId,
  summarizeStderr,
  OperationLifecycle,
} from "../src/services/operation-lifecycle"
import { runtimeSelfAudit } from "../src/services/runtime-self-audit"
import { RuntimeScoreboard, auditToUiScore } from "../src/services/runtime-score-stream"

const tmpDirs: string[] = []

function freshDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), "oplife-" + label + "-"))
  tmpDirs.push(d)
  return d
}

function health(sessionId: string) {
  return { currentHealth: runtimeSelfAudit.currentHealth(sessionId).score, sessionIntegrity: runtimeSelfAudit.sessionIntegrity(sessionId).score }
}

describe("operation lifecycle identity", () => {
  it("4. stable operation ID created once (deterministic, reuses tool call ID)", () => {
    // Same (session, tool call ID, action) always yields the same stable ID.
    expect(deriveOperationId("root", "tool_call_7")).toBe(deriveOperationId("root", "tool_call_7"))
    expect(deriveOperationId("root", "tool_call_8")).not.toBe(deriveOperationId("root", "tool_call_7"))
    expect(deriveOperationId("root2", "tool_call_7")).not.toBe(deriveOperationId("root", "tool_call_7"))
  })

  it("started X -> failed X reuse the same opId; one terminal state only", () => {
    const lc = new OperationLifecycle()
    const opId = deriveOperationId("root", "call_1", "cargo --coverage")
    lc.begin({ sessionId: "root", toolCallId: "call_1", actionClass: "Shell", label: "cargo --coverage" })
    expect(lc.get(opId)?.status).toBe("started")
    const failed = lc.fail(opId, { exitCode: 1, score: 42, stderrSummary: "error" })
    expect(failed?.status).toBe("failed")
    expect(failed?.exitCode).toBe(1)
    expect(lc.terminalOf(opId)).toBe("failed")
    expect(lc.rowCount(opId)).toBe(1)
    expect(lc.complete(opId, { score: 98 })).toBeNull()
    expect(lc.terminalOf(opId)).toBe("failed")
  })

  it("7. completed event uses the same ID on success", () => {
    const lc = new OperationLifecycle()
    const opId = deriveOperationId("root", "call_2", "echo ok")
    lc.begin({ sessionId: "root", toolCallId: "call_2", actionClass: "Shell", label: "echo ok" })
    lc.complete(opId, { score: 98 })
    expect(lc.terminalOf(opId)).toBe("completed")
    expect(lc.rowCount(opId)).toBe(1)
  })

  it("24. alternate command receives a distinct operation lifecycle", () => {
    const a = deriveOperationId("root", "call_1", "cargo --coverage")
    const b = deriveOperationId("root", "call_1", "cargo test")
    expect(b).not.toBe(a)
    const lc = new OperationLifecycle()
    lc.begin({ sessionId: "root", toolCallId: "call_1", actionClass: "Shell", label: "cargo --coverage" })
    lc.begin({ sessionId: "root", toolCallId: "call_1", actionClass: "Shell", label: "cargo test" })
    expect(lc.rowCount(a)).toBe(1)
    expect(lc.rowCount(b)).toBe(1)
  })

  it("12/13. child/root correlation + siblings unaffected (session scoped)", () => {
    const lc = new OperationLifecycle()
    const rootOp = deriveOperationId("root", "c1", "x")
    const childOp = deriveOperationId("par_coder", "c9", "y")
    lc.begin({ sessionId: "root", toolCallId: "c1", actionClass: "Shell", label: "x" })
    lc.begin({ sessionId: "par_coder", toolCallId: "c9", actionClass: "Shell", label: "y" })
    expect(lc.get(childOp)?.sessionId).toBe("par_coder")
    expect(lc.get(rootOp)?.sessionId).toBe("root")
    lc.clearSession("par_coder")
    expect(lc.get(childOp)).toBeUndefined()
    expect(lc.get(rootOp)).toBeDefined()
  })

  it("16. Runtime Self-Audit failure score linked to same action (audit event id == opId)", () => {
    runtimeSelfAudit.clear()
    runtimeSelfAudit.clearIncidents()
    const opId = deriveOperationId("root", "c3", "node -e fail")
    const started = runtimeSelfAudit.scoreEvent({
      category: "shell", operation: "node -e fail", sessionID: "root", id: opId, status: "started" as const,
      dimensionScores: { execution: 98, integrity: 98 }, evidenceIds: [], latencyBreakdown: [],
    })
    const failed = runtimeSelfAudit.scoreEvent({
      category: "tool_execution", operation: "node -e fail", sessionID: "root", id: opId, status: "failed" as const, exitCode: 17,
      stderrSummary: "intentional failure", toolCallId: "c3",
      dimensionScores: { execution: 35, integrity: 98 }, evidenceIds: [], latencyBreakdown: [],
      violations: [{ code: "NONZERO_EXIT", severity: "severe" as const, detail: "exit 17" }],
    })
    expect(started.id).toBe(opId)
    expect(failed.id).toBe(opId)
    expect(failed.status).toBe("failed")
    expect(failed.exitCode).toBe(17)
    expect(runtimeSelfAudit.sessionIntegrity("root").severeCount).toBe(1)
  })

  it("5 + 9. one WebUI row per operation; started->failed updates in place", () => {
    const dir = freshDir("row")
    const sb = new RuntimeScoreboard(dir)
    const opId = deriveOperationId("root", "c4", "cargo --coverage")
    const started = runtimeSelfAudit.scoreEvent({
      category: "shell", operation: "cargo --coverage", sessionID: "root", id: opId, status: "started" as const,
      dimensionScores: { execution: 98, integrity: 98 }, evidenceIds: [], latencyBreakdown: [],
    })
    sb.ingest(auditToUiScore(started, health("root")))
    const failed = runtimeSelfAudit.scoreEvent({
      category: "tool_execution", operation: "cargo --coverage", sessionID: "root", id: opId, status: "failed" as const,
      exitCode: 1, stderrSummary: "error: unexpected argument '--coverage'",
      dimensionScores: { execution: 35, integrity: 98 }, evidenceIds: [], latencyBreakdown: [],
      violations: [{ code: "NONZERO_EXIT", severity: "severe" as const, detail: "exit 1" }],
    })
    sb.ingest(auditToUiScore(failed, health("root")))
    const matching = sb.list("root").filter((r) => r.eventId === opId)
    expect(matching.length).toBe(1)
    expect(matching[0].status).toBe("failed")
    expect(matching[0].exitCode).toBe(1)
    expect(sb.get(opId)?.status).toBe("failed")
  })

  it("10. failed row survives reload (same eventId, same terminal score)", () => {
    const dir = freshDir("reload")
    const opId = deriveOperationId("root", "c5", "cargo --coverage")
    const sb1 = new RuntimeScoreboard(dir)
    sb1.ingest(auditToUiScore(runtimeSelfAudit.scoreEvent({
      category: "shell", operation: "cargo --coverage", sessionID: "root", id: opId, status: "started" as const,
      dimensionScores: { execution: 98 }, evidenceIds: [], latencyBreakdown: [],
    }), health("root")))
    sb1.ingest(auditToUiScore(runtimeSelfAudit.scoreEvent({
      category: "tool_execution", operation: "cargo --coverage", sessionID: "root", id: opId, status: "failed" as const,
      exitCode: 17, stderrSummary: "intentional",
      dimensionScores: { execution: 35 }, evidenceIds: [], latencyBreakdown: [],
      violations: [{ code: "NONZERO_EXIT", severity: "severe" as const, detail: "exit 17" }],
    }), health("root")))
    expect(existsSync(join(dir, ".flowdeck", "scores.jsonl"))).toBe(true)
    const sb2 = new RuntimeScoreboard(dir)
    const loaded = sb2.get(opId)
    expect(loaded).toBeDefined()
    expect(loaded?.status).toBe("failed")
    expect(loaded?.exitCode).toBe(17)
    expect(sb2.list("root").filter((r) => r.eventId === opId).length).toBe(1)
  })

  it("17/18. Current Health recovers after correction; Session Integrity retains incident", () => {
    runtimeSelfAudit.clear()
    runtimeSelfAudit.clearIncidents()
    const opId = deriveOperationId("root", "c6", "cargo --coverage")
    runtimeSelfAudit.scoreEvent({
      category: "tool_execution", operation: "cargo --coverage", sessionID: "root", id: opId, status: "failed" as const,
      dimensionScores: { execution: 35, integrity: 90 }, evidenceIds: [], latencyBreakdown: [],
      violations: [{ code: "NONZERO_EXIT", severity: "severe" as const, detail: "exit 1" }],
    })
    const afterFail = health("root")
    expect(afterFail.sessionIntegrity).toBeLessThan(100)
    expect(afterFail.currentHealth).toBeLessThan(60)
    runtimeSelfAudit.scoreEvent({
      category: "tool_execution", operation: "cargo test", sessionID: "root",
      dimensionScores: { execution: 97, integrity: 98 }, evidenceIds: [], latencyBreakdown: [],
    })
    const afterCorrection = health("root")
    expect(afterCorrection.currentHealth).toBeGreaterThan(afterFail.currentHealth)
    expect(runtimeSelfAudit.sessionIntegrity("root").severeCount).toBe(1)
  })

  it("summarizeStderr bounds and never grows unbounded", () => {
    const long = "x".repeat(1000)
    expect((summarizeStderr(long) ?? "").length).toBeLessThanOrEqual(301)
    expect(summarizeStderr("   ")).toBeUndefined()
  })

  afterAll(() => {
    for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  })
})
