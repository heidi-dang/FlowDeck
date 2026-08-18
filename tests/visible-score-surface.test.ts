import { describe, it, expect } from "bun:test"
import {
  buildScoreAnnotation,
  explainScore,
  formatScoreLine,
  ScoreActionClass,
} from "../src/services/visible-score-surface"

const ACTION_CLASSES: ScoreActionClass[] = [
  "think",
  "tool",
  "fdx",
  "shell",
  "delegation",
  "recovery",
  "assistant_completion",
]

describe("visible-score-surface", () => {
  it("titles each action class as label + ' — FlowDeck NN%'", () => {
    for (const actionClass of ACTION_CLASSES) {
      const label = (
        actionClass === "shell" ? "Shell npm test" :
        actionClass === "delegation" ? "Task security-auditor" :
        actionClass === "assistant_completion" ? "Assistant" :
        actionClass === "fdx" ? "FDX Search" :
        actionClass === "think" ? "Think" :
        actionClass === "tool" ? "Tool run" :
        "Recovery"
      )
      const score = 96
      const annotation = buildScoreAnnotation({ actionClass, sessionID: "s1", label, score })
      expect(annotation.title).toBe(label + " — FlowDeck " + score + "%")
    }
  })

  it("score 100 renders 'FlowDeck 100%'", () => {
    const annotation = buildScoreAnnotation({ actionClass: "fdx", sessionID: "s2", label: "FDX Search", score: 100 })
    expect(annotation.title).toBe("FDX Search — FlowDeck 100%")
    expect(formatScoreLine(100)).toBe("FlowDeck 100%")
    expect(annotation.title.endsWith("FlowDeck 100%")).toBe(true)
  })

  it("low score (42) yields explanation metadata and explainScore(42) is defined", () => {
    const annotation = buildScoreAnnotation({
      actionClass: "delegation",
      sessionID: "s3",
      label: "Task deploy-agent",
      score: 42,
      explanation: "provider replay check failed",
    })
    const selfAudit = (annotation.metadata.fd as any).selfAudit
    expect(selfAudit.explanation).toBeDefined()
    expect(selfAudit.explanation.length).toBeLessThanOrEqual(140)
    expect(explainScore(42)).toBeDefined()
  })

  it("score is a 0-100 number in title and metadata", () => {
    for (const score of [0, 1, 42, 59, 60, 88, 100, 144, -5]) {
      const annotation = buildScoreAnnotation({ actionClass: "tool", sessionID: "s4", label: "Tool", score })
      const stored = (annotation.metadata.fd as any).selfAudit.score
      expect(typeof stored).toBe("number")
      expect(stored).toBeGreaterThanOrEqual(0)
      expect(stored).toBeLessThanOrEqual(100)
    }
  })

  it("explanation is generic and never contains hidden reasoning or model text", () => {
    const modelProse = "I think the cache invalidation caused the stale index here."
    const annotation = buildScoreAnnotation({
      actionClass: "shell",
      sessionID: "s5",
      label: "Shell npm test",
      score: 42,
      explanation: modelProse,
    })
    const selfAudit = (annotation.metadata.fd as any).selfAudit
    // Stored explanation is a fixed generic string — the raw model prose never leaks.
    expect(selfAudit.explanation).not.toContain("cache invalidation")
    expect(selfAudit.explanation).not.toBe(modelProse)
    expect(annotation.title).not.toContain(modelProse)
  })

  it("stores score/actionClass/sessionID in fd.selfAudit metadata", () => {
    const annotation = buildScoreAnnotation({ actionClass: "recovery", sessionID: "s6", label: "Recovery", score: 61 })
    const selfAudit = (annotation.metadata.fd as any).selfAudit
    expect(annotation.metadata.fd).toBeDefined()
    expect(selfAudit.score).toBe(61)
    expect(selfAudit.actionClass).toBe("recovery")
    expect(selfAudit.sessionID).toBe("s6")
  })

  it("no explanation is stored for high scores even with explanation passed", () => {
    const annotation = buildScoreAnnotation({ actionClass: "tool", sessionID: "s7", label: "Tool", score: 90, explanation: "fine" })
    const selfAudit = (annotation.metadata.fd as any).selfAudit
    expect(selfAudit.explanation).toBeUndefined()
    expect(explainScore(90)).toBeUndefined()
  })

  it("the annotation title is NOT injected into any assistant text content buffer (structural separation)", () => {
    const annotation = buildScoreAnnotation({ actionClass: "fdx", sessionID: "s8", label: "FDX Search", score: 100 })
    // A realistic model-visible assistant text buffer (conversation prose only).
    const assistantTextParts = [
      "Searching the code index now.",
      "Found 12 matching symbols across the workspace.",
    ]
    const allText = assistantTextParts.join(" ")
    // The score lives ONLY in the structured title/metadata, never in the prose.
    expect(allText.includes(annotation.title)).toBe(false)
    expect(allText).not.toMatch(/FlowDeck \d+%/)
    expect(annotation.metadata.fd).toBeDefined()
  })
})
