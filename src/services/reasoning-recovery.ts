/**
 * Bounded recovery state machine for reasoning-only completions.
 *
 * Recovery is strictly bounded:
 *   stage 1: normal provider-safe sanitized continuation (exactly once per
 *            malformed completion signature — duplicate `message.updated` /
 *            `session.idle` delivery of the SAME completion is circuit-broken)
 *   stage 2: one tightly scoped recovery continuation, allowed ONLY after the
 *            stage-1 continuation actually failed with a provider replay /
 *            serialization error (HTTP 400 INVALID_ARGUMENT class)
 *   after stage 2: no further automatic recovery — a structured failure record
 *            is written so the session is never left silently idle
 *
 * No recursive retry is possible: signatures are stage-aware and the per-session
 * continuation budget is capped.
 */

export const REPLAY_CONTINUATION_PROMPT =
  "Continue the current task from the last verified execution state and provide a visible progress or completion response."

export const MAX_AUTO_CONTINUATIONS_PER_INCIDENT = 3
export const MAX_AUTO_CONTINUATIONS_PER_SESSION = 50

export type RecoveryStage = 1 | 2

export interface SessionRecoveryState {
  /** Message ID of the reasoning-only completion that started recovery. */
  malformedMessageId: string
  stage: RecoveryStage
  provider?: string
  model?: string
  scheduledAt: number
}

export type ProviderErrorClass = "replay" | "cancelled" | "other" | "none"

/**
 * Classify an async-API error surfaced from a continuation request.
 * "replay" covers the HTTP 400 INVALID_ARGUMENT class that poisoned replays
 * produce. "cancelled" covers user/abort errors which must never retry.
 */
export function classifyProviderError(err: unknown): ProviderErrorClass {
  const errObj = err as { name?: unknown; message?: unknown } | null | undefined
  const text =
    err instanceof Error
      ? err.name + ": " + err.message
      : err && typeof errObj?.message === "string"
        ? String(errObj.name ?? "Error") + ": " + errObj.message
        : String(err ?? "")
  if (!text || text === "undefined" || text === "null") return "none"
  if (/abort|cancel/i.test(text)) return "cancelled"
  if (/INVALID_ARGUMENT|Request contains an invalid argument|\b400\b|AI_APICallError|APIError/i.test(text)) return "replay"
  return "other"
}

/**
 * Deterministic, stage-aware circuit-breaker signature for one reasoning-only
 * completion. Duplicate event deliveries of the same completion share the same
 * stage-1 signature; a legitimate bounded second-stage recovery after the first
 * provider request failed uses the distinct stage-2 signature.
 */
export function buildContinuationSignature(args: {
  sessionID: string
  messageID: string
  provider: string
  model: string
  stage: RecoveryStage
}): string {
  return args.messageID + ":" + args.provider + ":" + args.model + ":NO_VISIBLE_ASSISTANT_OUTPUT:stage" + args.stage
}

export interface ContinuationDecision {
  action: "schedule" | "circuit_break" | "cap_reached" | "none"
  stage?: RecoveryStage
}

/**
 * Decide what to do for the detection event of a reasoning-only completion.
 * Pure decision — the caller schedules the timer/prompt.
 */
export function decideStage1Continuation(args: {
  sessionID: string
  signature: string
  breaker: Set<string>
  incidentCount: number
  sessionCount: number
}): ContinuationDecision {
  if (args.incidentCount >= MAX_AUTO_CONTINUATIONS_PER_INCIDENT || args.sessionCount >= MAX_AUTO_CONTINUATIONS_PER_SESSION) {
    return { action: "cap_reached" }
  }
  if (args.breaker.has(args.signature)) {
    return { action: "circuit_break" }
  }
  args.breaker.add(args.signature)
  return { action: "schedule", stage: 1 }
}

/**
 * Decide what to do when a continuation request fails with a provider error.
 * Only a failed stage-1 continuation may promote to stage 2 (once). Anything
 * else terminates recovery — never retry.
 */
export function decideStage2Continuation(args: {
  sessionID: string
  state: SessionRecoveryState | undefined
  errorClass: ProviderErrorClass
  signature: string
  breaker: Set<string>
  incidentCount: number
  sessionCount: number
}): ContinuationDecision {
  if (args.errorClass === "cancelled") return { action: "none" }
  if (args.errorClass !== "replay") return { action: "none" }
  if (!args.state || args.state.stage !== 1) return { action: "none" }
  if (args.incidentCount >= MAX_AUTO_CONTINUATIONS_PER_INCIDENT || args.sessionCount >= MAX_AUTO_CONTINUATIONS_PER_SESSION) {
    return { action: "cap_reached" }
  }
  if (args.breaker.has(args.signature)) {
    return { action: "circuit_break" }
  }
  args.breaker.add(args.signature)
  return { action: "schedule", stage: 2 }
}
