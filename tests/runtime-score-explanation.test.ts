import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { RuntimeScoreboard, auditToUiScore, renderExplanationHtml } from "../src/services/runtime-score-stream"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("Runtime Score Explanation & Transparency", () => {
  let tmpDir: string
  let scoreboard: RuntimeScoreboard

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "score-explanation-"))
    scoreboard = new RuntimeScoreboard(tmpDir)
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it("provides structured dimension breakdown, reason codes, evidence count, and confidence", () => {
    const audit: any = {
      id: "ev-exp-1",
      sessionID: "ses-exp",
      category: "task_delegation",
      operation: "task security-auditor",
      score: 42,
      confidence: 0.5,
      dimensions: { integrity: 40, recovery: 91, routing: 98, efficiency: 62 },
      evidenceIds: ["ev-a", "ev-b", "ev-c"],
      latencyBreakdown: [],
      criticalViolations: [{ code: "SESSION_ANCESTRY_CORRUPTION", severity: "severe", detail: "root delegation depth corrupted" }],
      incidentIds: ["inc-1"],
      at: Date.now(),
    }

    const uiScore = auditToUiScore(audit, { currentHealth: 74, sessionIntegrity: 85 })
    scoreboard.ingest(uiScore)

    const exp = scoreboard.explanation("ev-exp-1")
    expect(exp).not.toBeNull()
    expect(exp!.dimensions.integrity).toBe(40)
    expect(exp!.dimensions.recovery).toBe(91)
    expect(exp!.dimensions.routing).toBe(98)
    expect(exp!.dimensions.efficiency).toBe(62)
    expect(exp!.reasons.length).toBeGreaterThanOrEqual(1)
    expect(exp!.reasons[0].code).toBe("SESSION_ANCESTRY_CORRUPTION")
    expect(exp!.evidenceCount).toBe(4)
    expect(exp!.confidence).toBe("low")
    expect(exp!.accessibleLabel).toContain("percent")

    // Never contains hidden reasoning or raw prompt data
    const json = JSON.stringify(exp)
    expect(json).not.toContain("chainOfThought")
    expect(json).not.toContain("internal thoughts")
    expect(json).not.toContain("sk-")

    // HTML rendering
    const html = renderExplanationHtml(exp!)
    expect(html).toContain("SESSION_ANCESTRY_CORRUPTION")
    expect(html).toContain("Evidence: 4 events")
    expect(html).toContain("Confidence: low")
  })

  it("low confidence is reported when evidence is sparse", () => {
    const audit: any = {
      id: "ev-sparse",
      sessionID: "s-sparse",
      category: "tool_execution",
      operation: "custom-tool",
      score: 80,
      confidence: 0.3,
      dimensions: { execution: 80 },
      evidenceIds: [],
      latencyBreakdown: [],
      criticalViolations: [],
      incidentIds: [],
      at: Date.now(),
    }
    const uiScore = auditToUiScore(audit, { currentHealth: 80, sessionIntegrity: 100 })
    scoreboard.ingest(uiScore)
    const exp = scoreboard.explanation("ev-sparse")
    expect(exp?.confidence).toBe("low")
  })
})
