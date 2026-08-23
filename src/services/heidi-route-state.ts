/**
 * HeidiRouteState — per-session, per-user-turn route decision projection / cache.
 *
 * Keyed by sessionID. Serves as an ephemeral in-memory cache over the authoritative
 * SQLite orchestration state.
 */

import type { RouterDecision } from "./heidi-fast-router"
import { getTaskState } from "./heidi-task-state"

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
  active: boolean
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
    active: true,
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
 * Decide whether a manual user message is an exact duplicate or replay.
 */
export function isDuplicateMessage(sessionID: string, messageHash: string): boolean {
  const entry = _registry.get(sessionID)
  if (!entry) return false
  return entry.lastUserMessageHash === messageHash
}

/**
 * Helper for facade consumers:
 * Only preserves route when active AND not completed/terminal.
 * FAST_DIRECT routes are turn-scoped and never preserved for non-duplicate messages.
 */
export function shouldPreserveRoute(sessionID: string, messageHash: string): {
  preserve: boolean
  reason?: string
} {
  const entry = _registry.get(sessionID)
  if (!entry || !entry.active) {
    return { preserve: false, reason: "NO_ACTIVE_ROUTE" }
  }

  // FAST_DIRECT is turn-scoped and never preserved for different messages
  if (entry.decision.executionClass === "FAST_DIRECT" && entry.lastUserMessageHash !== messageHash) {
    return { preserve: false, reason: "FAST_DIRECT_TURN_COMPLETE" }
  }

  // If task state exists and is already completed, do not preserve
  const taskState = getTaskState(entry.taskId)
  if (taskState && (taskState.snapshot().currentPhase === "complete" || taskState.snapshot().verificationState === "passed")) {
    return { preserve: false, reason: "TASK_ALREADY_COMPLETE" }
  }

  return { preserve: true, reason: "ACTIVE_TASK_CONTINUATION" }
}

/** Mark a session route as inactive / completed. */
export function markRouteInactive(sessionID: string): void {
  const entry = _registry.get(sessionID)
  if (entry) entry.active = false
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
