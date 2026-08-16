import { describe, it, expect } from "vitest"
import {
  REPLAY_CONTINUATION_PROMPT,
  MAX_AUTO_CONTINUATIONS_PER_SESSION,
  classifyProviderError,
  buildContinuationSignature,
  decideStage1Continuation,
  decideStage2Continuation,
  type SessionRecoveryState,
} from "../src/services/reasoning-recovery"

describe("classifyProviderError", () => {
  it("classifies HTTP 400 INVALID_ARGUMENT as replay-class", () => {
    expect(classifyProviderError(new Error("AI_APICallError: [antigravity/gemini-3.6-flash-high] [400]: {\"status\": \"INVALID_ARGUMENT\"}"))).toBe("replay")
  })
  it("classifies the gateway message as replay-class", () => {
    expect(classifyProviderError({ message: "Request contains an invalid argument." })).toBe("replay")
  })
  it("classifies cancellations as cancelled (never retried)", () => {
    expect(classifyProviderError(new Error("Request aborted by user"))).toBe("cancelled")
    expect(classifyProviderError(new Error("SESSION_CANCELLED"))).toBe("cancelled")
  })
  it("classifies unrelated errors as other", () => {
    expect(classifyProviderError(new Error("Rate limit exceeded"))).toBe("other")
  })
  it("treats missing errors as none", () => {
    expect(classifyProviderError(undefined)).toBe("none")
  })
})

describe("buildContinuationSignature", () => {
  it("produces stage-aware signatures (stage1 != stage2 for the same completion)", () => {
    const base = { sessionID: "ses_1", messageID: "msg_1", provider: "heidi", model: "heidi-antigravity" }
    const s1 = buildContinuationSignature({ ...base, stage: 1 })
    const s2 = buildContinuationSignature({ ...base, stage: 2 })
    expect(s1).not.toBe(s2)
    expect(s1).toContain(":stage1")
    expect(s2).toContain(":stage2")
  })
  it("is deterministic for duplicate detection events", () => {
    const a = buildContinuationSignature({ sessionID: "ses_1", messageID: "msg_1", provider: "p", model: "m", stage: 1 })
    const b = buildContinuationSignature({ sessionID: "ses_1", messageID: "msg_1", provider: "p", model: "m", stage: 1 })
    expect(a).toBe(b)
  })
})

describe("decideStage1Continuation (exactly-once per completion)", () => {
  it("schedules the first detection and circuit-breaks the identical duplicate", () => {
    const breaker = new Set<string>()
    const sig = "msg_1:p:m:NO_VISIBLE_ASSISTANT_OUTPUT:stage1"
    expect(decideStage1Continuation({ sessionID: "ses_1", signature: sig, breaker, continuationCount: 0 }).action).toBe("schedule")
    expect(decideStage1Continuation({ sessionID: "ses_1", signature: sig, breaker, continuationCount: 0 }).action).toBe("circuit_break")
  })
  it("refuses to schedule beyond the per-session cap", () => {
    const breaker = new Set<string>()
    expect(decideStage1Continuation({ sessionID: "ses_1", signature: "s-a", breaker, continuationCount: 2 }).action).toBe("schedule")
    expect(decideStage1Continuation({ sessionID: "ses_1", signature: "s-b", breaker, continuationCount: MAX_AUTO_CONTINUATIONS_PER_SESSION }).action).toBe("cap_reached")
  })
})

describe("decideStage2Continuation (bounded stage-2 recovery)", () => {
  it("promotes a failed stage-1 replay error to exactly one stage-2 recovery", () => {
    const breaker = new Set<string>()
    const state: SessionRecoveryState = { malformedMessageId: "msg_1", stage: 1, provider: "p", model: "m", scheduledAt: 0 }
    const d1 = decideStage2Continuation({ sessionID: "ses_1", state, errorClass: "replay", signature: "sig2", breaker, continuationCount: 1 })
    expect(d1.action).toBe("schedule")
    expect(d1.stage).toBe(2)
    // Duplicate error delivery for the same stage-2 signature is circuit-broken
    const d2 = decideStage2Continuation({ sessionID: "ses_1", state, errorClass: "replay", signature: "sig2", breaker, continuationCount: 1 })
    expect(d2.action).toBe("circuit_break")
  })
  it("never schedules stage 2 from a stage-2 failure (no recursive retry)", () => {
    const breaker = new Set<string>()
    const state: SessionRecoveryState = { malformedMessageId: "msg_1", stage: 2, provider: "p", model: "m", scheduledAt: 0 }
    expect(decideStage2Continuation({ sessionID: "ses_1", state, errorClass: "replay", signature: "sig2b", breaker, continuationCount: 2 }).action).toBe("none")
  })
  it("never schedules stage 2 for non-replay or cancelled errors", () => {
    const breaker = new Set<string>()
    const state: SessionRecoveryState = { malformedMessageId: "msg_1", stage: 1, provider: "p", model: "m", scheduledAt: 0 }
    expect(decideStage2Continuation({ sessionID: "ses_1", state, errorClass: "other", signature: "s", breaker, continuationCount: 1 }).action).toBe("none")
    expect(decideStage2Continuation({ sessionID: "ses_1", state, errorClass: "cancelled", signature: "s", breaker, continuationCount: 1 }).action).toBe("none")
  })
  it("refuses stage 2 when the per-session cap is exhausted", () => {
    const breaker = new Set<string>()
    const state: SessionRecoveryState = { malformedMessageId: "msg_1", stage: 1, provider: "p", model: "m", scheduledAt: 0 }
    expect(decideStage2Continuation({ sessionID: "ses_1", state, errorClass: "replay", signature: "s", breaker, continuationCount: MAX_AUTO_CONTINUATIONS_PER_SESSION }).action).toBe("cap_reached")
  })
})

describe("REPLAY_CONTINUATION_PROMPT", () => {
  it("is the exact bounded continuation prompt", () => {
    expect(REPLAY_CONTINUATION_PROMPT).toContain("Continue the current task")
  })
})