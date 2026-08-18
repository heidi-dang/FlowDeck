import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { RuntimeScoreboard, auditToUiScore } from "../src/services/runtime-score-stream"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("Runtime Score Event Linking & In-Place Updates", () => {
  let tmpDir: string
  let scoreboard: RuntimeScoreboard

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "score-linking-"))
    scoreboard = new RuntimeScoreboard(tmpDir)
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it("updates existing score in place by stable eventId without creating duplicate rows", () => {
    scoreboard.ingest({
      eventId: "ev-tool-1",
      actionClass: "Shell",
      label: "npm test",
      sessionId: "s1",
      score: 96,
      confidence: 0.8,
      evidenceCount: 1,
      currentHealth: 96,
      sessionIntegrity: 96,
      dimensions: { execution: 96 },
      reasons: [],
      at: Date.now(),
    })

    expect(scoreboard.list("s1").length).toBe(1)
    expect(scoreboard.get("ev-tool-1")?.score).toBe(96)

    // Execution evidence arrives -> update score in place
    const updated = scoreboard.update("ev-tool-1", { score: 99, confidence: 0.98, evidenceCount: 3 })
    expect(updated).not.toBeNull()
    expect(updated?.score).toBe(99)

    // Still exactly 1 row for this event
    const list = scoreboard.list("s1")
    expect(list.length).toBe(1)
    expect(list[0].score).toBe(99)
    expect(list[0].confidence).toBe(0.98)
  })

  it("attaches score correctly across all required action classes: Shell, FDX, Task, Chat, Think, Recovery, Parallel, Verification", () => {
    const actions = [
      { category: "shell", op: "bun test", class: "Shell" },
      { category: "fdx_search", op: "fdx-search", class: "FDX" },
      { category: "task_delegation", op: "security-auditor", class: "Task" },
      { category: "assistant_completion", op: "assistant-completion", class: "Chat" },
      { category: "think", op: "assistant-reasoning", class: "Think" },
      { category: "recovery", op: "empty-terminal-silent_continue", class: "Recovery" },
      { category: "parallel_coordination", op: "child.completed", class: "Parallel Coordination" },
      { category: "verification", op: "completion", class: "Verification" },
    ]

    for (const a of actions) {
      const audit: any = {
        id: "ev-" + a.category,
        sessionID: "s2",
        category: a.category,
        operation: a.op,
        score: 95,
        confidence: 0.9,
        dimensions: { execution: 95 },
        evidenceIds: [],
        latencyBreakdown: [],
        criticalViolations: [],
        incidentIds: [],
        at: Date.now(),
      }
      const ui = auditToUiScore(audit, { currentHealth: 95, sessionIntegrity: 95 })
      expect(ui.actionClass).toBe(a.class)
      expect(ui.score).toBe(95)
    }
  })
})
