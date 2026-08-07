/**
 * Context Scoping & Compaction Service
 *
 * Utility library for bounding what enters a child session's context and
 * compacting oversized payloads BEFORE they are sent, so a runaway child
 * cannot balloon the run budget by pulling the full parent history or
 * dumping multi-MB tool output.
 *
 * NOTE: These helpers are NOT yet wired into the plugin's dispatch path —
 * the plugin does not construct child prompts (OpenCode does). The active
 * runaway defense is the token-budget reservation gate + hard stop in
 * token-budget-controller.ts. This module is the intended future lever and
 * is kept tested so it can be integrated when a child-context hook exists.
 *
 * Key behaviours:
 *  - `buildAssignmentContext`  — builds a bounded context packet for a
 *    delegated child: shared briefing + scoped assignment ONLY (no raw
 *    parent conversation replay).
 *  - `externalizeToolOutput`   — truncates oversized tool output to a
 *    configurable char budget with an explicit marker so downstream
 *    accounting (and the reader) knows content was elided.
 *  - `shouldCompact`           — deterministic compaction trigger based on
 *    estimated conversation size vs threshold.
 */

import { estimateTokensFromBytes } from "./token-budget"
import { formatContextPacket } from "./token-optimizer-service"

export interface AssignmentContextInput {
  target: string
  blastRadius?: string
  patterns?: string[]
  priorLessons?: string
  constraints?: string
  stage: string
  /** Additional scoped instructions for the delegated agent. */
  assignment: string
}

export interface AssignmentContextResult {
  /** The bounded prompt handed to the child. */
  prompt: string
  /** Token estimate of the bounded prompt. */
  estimatedTokens: number
  /** True when the parent conversation was intentionally NOT replayed. */
  parentConversationExcluded: true
}

/**
 * Build a bounded context for a delegated child session.
 *
 * Children receive a compact briefing and their scoped assignment — never a
 * raw replay of the parent conversation. This is the primary lever against
 * the "child inherits full parent history" runaway pattern.
 */
export function buildAssignmentContext(input: AssignmentContextInput): AssignmentContextResult {
  const packet = formatContextPacket({
    target: input.target,
    blastRadius: input.blastRadius,
    patterns: input.patterns,
    priorLessons: input.priorLessons,
    constraints: input.constraints,
    stage: input.stage,
  })

  const prompt = `${packet}\n\n## Assignment\n${input.assignment}`
  return {
    prompt,
    estimatedTokens: estimateTokensFromBytes(Buffer.byteLength(prompt, "utf-8")),
    parentConversationExcluded: true,
  }
}

export interface ExternalizeResult {
  text: string
  truncated: boolean
  originalChars: number
  retainedChars: number
}

/**
 * Bound tool output that would otherwise flood a child context.
 * Returns the original text unchanged when under the budget, otherwise a
 * truncated head with an explicit elision marker.
 */
export function externalizeToolOutput(text: string, maxChars: number): ExternalizeResult {
  const originalChars = text.length
  if (originalChars <= maxChars) {
    return { text, truncated: false, originalChars, retainedChars: originalChars }
  }
  const retainedChars = Math.max(0, maxChars - 3)
  const elided = `${text.slice(0, retainedChars)}...`
  return { text: elided, truncated: true, originalChars, retainedChars: elided.length }
}

/**
 * Deterministic compaction trigger. Returns true when the estimated
 * conversation size (tokens) exceeds the configured threshold.
 */
export function shouldCompact(estimatedConversationTokens: number, thresholdTokens: number): boolean {
  return estimatedConversationTokens > thresholdTokens
}

/** Estimate tokens for a raw conversation replay (used to justify exclusion). */
export function estimateReplayTokens(messages: unknown[]): number {
  let bytes = 0
  for (const m of messages) {
    try {
      bytes += Buffer.byteLength(JSON.stringify(m ?? {}), "utf-8")
    } catch {
      // skip un-serializable message
    }
  }
  return estimateTokensFromBytes(bytes)
}