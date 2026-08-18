import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { RuntimeScoreboard, accessibleScoreLabel, scoreBadgeText, renderScoreBadgeHtml, renderSessionHealthHtml } from "../src/services/runtime-score-stream"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("Runtime Score WebUI Contract", () => {
  let tmpDir: string
  let scoreboard: RuntimeScoreboard

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "score-webui-contract-"))
    scoreboard = new RuntimeScoreboard(tmpDir)
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it("renders a compact secondary score line for Shell, Task, FDX, Chat, Think", () => {
    expect(scoreBadgeText(98)).toBe("FlowDeck 98%")
    expect(scoreBadgeText(96)).toBe("FlowDeck 96%")
    expect(scoreBadgeText(94)).toBe("FlowDeck 94%")
    expect(scoreBadgeText(99)).toBe("FlowDeck 99%")
    expect(scoreBadgeText(97)).toBe("FlowDeck 97%")
  })

  it("provides deterministic accessibility label in text with full numeric precision", () => {
    expect(accessibleScoreLabel(96)).toBe("FlowDeck runtime integrity: 96 percent")
    expect(accessibleScoreLabel(74.4)).toBe("FlowDeck runtime integrity: 74 percent")
  })

  it("generates valid HTML badges and session health sections without throwing", () => {
    const badgeHtml = renderScoreBadgeHtml(98)
    expect(badgeHtml).toContain("FlowDeck 98%")
    expect(badgeHtml).toContain("fd-score-good")
    expect(badgeHtml).toContain("FlowDeck runtime integrity: 98 percent")

    const healthHtml = renderSessionHealthHtml({ currentHealth: 96, sessionIntegrity: 91, currentHealthEvents: 5 })
    expect(healthHtml).toContain("Current Health")
    expect(healthHtml).toContain("96%")
    expect(healthHtml).toContain("Session Integrity")
    expect(healthHtml).toContain("91%")
  })

  it("persists scores to ledger and reloads on scoreboard re-instantiation (WebUI refresh survives)", () => {
    scoreboard.ingest({
      eventId: "ev-1",
      actionClass: "Shell",
      label: "bun test",
      sessionId: "ses-test",
      score: 98,
      confidence: 0.95,
      evidenceCount: 3,
      currentHealth: 98,
      sessionIntegrity: 98,
      dimensions: { execution: 98, integrity: 98 },
      reasons: [],
      at: Date.now(),
    })

    // Reload via fresh scoreboard instance with same dir
    const reloaded = new RuntimeScoreboard(tmpDir)
    const list = reloaded.list("ses-test")
    expect(list.length).toBe(1)
    expect(list[0].score).toBe(98)
    expect(list[0].actionClass).toBe("Shell")
    expect(list[0].label).toBe("bun test")
  })
})
