import { describe, it, expect } from "bun:test"
import { fingerprintAction, LoopIncidentTracker, buildRecoveryRedirect } from "../src/services/loop-incident"

/** LOOP GUARD — incident-based steering (Requirement D/E) */
describe("LOOP GUARD INCIDENT STEERING", () => {
  it("rich fingerprints: different ranges, symbols, scopes are distinct; identical request identical", () => {
    const a1 = fingerprintAction("fdx-read", { path: "/repo/A", offset: 1, limit: 100 })
    const a2 = fingerprintAction("fdx-read", { path: "/repo/A", offset: 500, limit: 100 })
    const a3 = fingerprintAction("fdx-read", { path: "/repo/A", symbol: "foo" })
    expect(a1).not.toBe(a2)
    expect(a1).not.toBe(a3)
    expect(a2).not.toBe(a3)
    expect(fingerprintAction("fdx-read", { path: "/repo/A", offset: 1, limit: 100 })).toBe(a1)
    expect(fingerprintAction("fdx-search", { query: "x", path: "." })).not.toBe(fingerprintAction("fdx-search", { query: "y", path: "." }))
    expect(fingerprintAction("fdx-search", { query: "x", path: "src" })).not.toBe(fingerprintAction("fdx-search", { query: "x", path: "tests" }))
  })

  it("blocked retry does NOT increment the executed-repeat count", () => {
    const tracker = new LoopIncidentTracker()
    const fp = fingerprintAction("fdx-read", { path: "/a", offset: 1 })
    const inc = tracker.recordNoProgressExecution("s1", fp)
    expect(inc.executedRepeatCount).toBe(1)
    expect(inc.blockedCount).toBe(0)
    const blocked = tracker.recordSuppressedDuplicate("s1", fp)
    expect(blocked.blockedCount).toBe(1)
    expect(blocked.executedRepeatCount).toBe(1)
    const blocked2 = tracker.recordSuppressedDuplicate("s1", fp)
    expect(blocked2.blockedCount).toBe(2)
    expect(blocked2.executedRepeatCount).toBe(1)
  })

  it("same suppressed fingerprint is suppressed; materially different action allowed; new info resolves", () => {
    const tracker = new LoopIncidentTracker()
    const fp = fingerprintAction("fdx-read", { path: "/a", offset: 1 })
    tracker.recordNoProgressExecution("s2", fp)
    expect(tracker.isFingerprintBlocked("s2", fp)).toBe(true)
    const fpOther = fingerprintAction("fdx-search", { query: "other", path: "." })
    expect(tracker.isFingerprintBlocked("s2", fpOther)).toBe(false)
    tracker.resolveIncident("s2", fp)
    expect(tracker.isFingerprintBlocked("s2", fp)).toBe(false)
  })

  it("recoverable block returns executable alternatives with humanInputRequired:false", () => {
    const fp = fingerprintAction("fdx-read", { path: "/a.ts" })
    const redirect = buildRecoveryRedirect({
      sessionID: "s3",
      toolName: "fdx-read",
      fingerprint: fp,
      reason: "same_result",
      blockedFacts: ["output_unchanged"],
      available: [],
    })
    expect(redirect.directive).toBe("FLOWDECK_RECOVERY_REDIRECT")
    expect(redirect.doNotRetry).toBe(fp)
    expect(redirect.humanInputRequired).toBe(false)
    expect(redirect.continueImmediatelyWith.length).toBeGreaterThan(0)
    const joined = redirect.continueImmediatelyWith.join(" ").toLowerCase()
    expect(joined).not.toContain("choose another approach")
    expect(joined).not.toContain("ask the human")
  })
})