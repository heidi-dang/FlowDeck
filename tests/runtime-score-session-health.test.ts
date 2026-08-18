import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { RuntimeSelfAudit } from "../src/services/runtime-self-audit"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("Runtime Score Session Health & Critical Caps", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "score-health-"))
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it("Current Health recovers after an incident while Session Integrity retains the historical degradation", () => {
    const audit = new RuntimeSelfAudit()
    const sessionID = "ses-health-1"

    // Initial healthy action
    audit.scoreEvent({
      category: "tool_execution",
      operation: "read",
      sessionID,
      dimensionScores: { execution: 100, integrity: 100 },
      evidenceIds: ["ev-1"],
      latencyBreakdown: [],
    })
    expect(audit.currentHealth(sessionID).score).toBe(100)
    expect(audit.sessionIntegrity(sessionID).score).toBe(100)

    // Severe incident: false delegation block
    audit.scoreEvent({
      category: "task_delegation",
      operation: "task",
      sessionID,
      dimensionScores: { execution: 100 },
      evidenceIds: [],
      latencyBreakdown: [],
      violations: [{ code: "FALSE_DELEGATION_BLOCK", severity: "severe", detail: "root Heidi depth 1" }],
    })
    expect(audit.currentHealth(sessionID).score).toBeLessThan(100)
    expect(audit.sessionIntegrity(sessionID).score).toBe(85)

    // Several healthy recovery actions follow
    for (let i = 0; i < 5; i++) {
      audit.scoreEvent({
        category: "tool_execution",
        operation: "fdx-read",
        sessionID,
        dimensionScores: { execution: 100, integrity: 100 },
        evidenceIds: ["ev-rec-" + i],
        latencyBreakdown: [],
      })
    }

    // Current Health recovers upward towards ~90%
    expect(audit.currentHealth(sessionID).score).toBeGreaterThan(80)
    // Session Integrity remains degraded (85%) because the severe incident is retained
    expect(audit.sessionIntegrity(sessionID).score).toBe(85)
    expect(audit.sessionIntegrity(sessionID).severeCount).toBe(1)
  })

  it("critical caps prevent averaging from hiding catastrophic failures", () => {
    const audit = new RuntimeSelfAudit()
    const caps = [
      { code: "RUNTIME_CRASH", severity: "fatal" as const, maxExpected: 10 },
      { code: "POLICY_BYPASS", severity: "severe" as const, maxExpected: 20 },
      { code: "WRONG_TASK_CORRELATION", severity: "severe" as const, maxExpected: 40 },
      { code: "PROVIDER_REPLAY_CORRUPTION", severity: "severe" as const, maxExpected: 30 },
      { code: "SESSION_ANCESTRY_CORRUPTION", severity: "severe" as const, maxExpected: 25 },
      { code: "UNSUPPORTED_RESOLUTION", severity: "severe" as const, maxExpected: 25 },
      { code: "RECOVERY_FLOOD", severity: "severe" as const, maxExpected: 30 },
      { code: "WATCHDOG_NAG_LOOP", severity: "severe" as const, maxExpected: 30 },
      { code: "NON_CONVERGENCE", severity: "severe" as const, maxExpected: 35 },
    ]

    for (const c of caps) {
      const ev = audit.scoreEvent({
        category: "tool_execution",
        operation: "op",
        sessionID: "s-cap",
        dimensionScores: { execution: 100, integrity: 100, governance: 100, routing: 100, efficiency: 100 },
        evidenceIds: [],
        latencyBreakdown: [],
        violations: [{ code: c.code, severity: c.severity, detail: "critical failure" }],
      })
      expect(ev.score).toBeLessThanOrEqual(c.maxExpected)
    }
  })
})
