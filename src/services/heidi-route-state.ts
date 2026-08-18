/**
 * HeidiRouteState — per-session, per-user-turn route decision registry.
 *
 * Keyed by sessionID. Stores the latest route decision produced by
 * HeidiFastRouter for a genuine manual user turn. Internal continuation /
 * recovery prompts NEVER reclassify — they must not reset the route. Resuming
 * an unresolved task preserves the existing decision and task state.
 */

import type { RouterDecision } from "./heidi-fast-router"
import { getTaskState, type HeidiTaskStateData } from "./heidi-task-state"

export interface SessionRouteState {
  sessionID: string
  taskId: string
  decision: RouterDecision
  goal: string
  lastUserMessageHash: string
  startedAt: number
  lastActivityAt: number
  /** Number of internal continuation prompts observed since the last manual user turn. */
  continuationCount: number
  resumed: boolean
}

const _registry = new Map<string, SessionRouteState>()

/** Record a fresh route decision for a manual user turn. */
export function setRouteDecision(
  sessionID: string,
  taskId: string,
  decision: RouterDecision,
  goal: string,
  lastUserMessageHash: string,
): SessionRouteState {
  const now = Date.now()
  const entry: SessionRouteState = {
    sessionID,
    taskId,
    decision,
    goal,
    lastUserMessageHash,
    startedAt: now,
    lastActivityAt: now,
    continuationCount: 0,
    resumed: false,
  }
  _registry.set(sessionID, entry)
  return entry
}

/**
 * Get the current route decision for a session, if any.
 * Returns null when no manual user turn has been routed yet.
 */
export function getRouteDecision(sessionID: string): SessionRouteState | null {
  return _registry.get(sessionID) ?? null
}

/** Mark an internal continuation for the session (does NOT reset the route). */
export function noteInternalContinuation(sessionID: string): void {
  const entry = _registry.get(sessionID)
  if (!entry) return
  entry.continuationCount += 1
  entry.lastActivityAt = Date.now()
}

/**
 * Decide whether a manual user message is a continuation of the existing
 * unresolved task (preserve state) or a genuinely new task (reclassify).
 *
 * Preserves when: an active task state exists for the same session, its phase
 * is not complete, and the new message hash differs from the most recent one
 * (i.e. a real follow-up rather than a duplicate replay).
 */
export function shouldPreserveRoute(
  sessionID: string,
  messageHash: string,
): { preserve: boolean; taskId?: string; state?: HeidiTaskStateData } {
  const entry = _registry.get(sessionID)
  if (!entry) return { preserve: false }
  if (entry.lastUserMessageHash === messageHash) {
    // Duplicate of the exact message we already classified — never reclassify.
    return { preserve: true, taskId: entry.taskId }
  }
  const state = getTaskState(entry.taskId)
  if (!state) return { preserve: false }
  const snap = state.snapshot()
  if (snap.currentPhase === "complete") return { preserve: false }
  return { preserve: true, taskId: entry.taskId, state: snap }
}

/** Touch activity timestamp (keeps long sessions from being treated as stale). */
export function touchRouteActivity(sessionID: string): void {
  const entry = _registry.get(sessionID)
  if (entry) entry.lastActivityAt = Date.now()
}

/** Forget a session route (session completed/cleared). */
export function clearRouteDecision(sessionID: string): void {
  _registry.delete(sessionID)
}

/** All active session routes (observability). */
export function listRouteDecisions(): Array<{ sessionID: string; taskId: string; executionClass: string }> {
  return [..._registry.entries()].map(([sessionID, entry]) => ({
    sessionID,
    taskId: entry.taskId,
    executionClass: entry.decision.executionClass,
  }))
}

/** Test-only reset. */
export function _resetRouteState(): void {
  _registry.clear()
}
