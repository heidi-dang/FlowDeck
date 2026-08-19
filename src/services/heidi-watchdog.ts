export interface WatchdogState {
  sessionID: string
  lastProgressAt: number
  isPendingProvider: boolean
  isPendingTool: boolean
  isPendingChild: boolean
  isPendingContinuation: boolean
  isPendingUser: boolean
  hasUnresolvedTask: boolean
  recoveryExhausted: boolean
  recoveryCount: number
  /** Is the session currently in an active/running lifecycle state? Defaults to false until explicit prompt/activity. */
  isActiveSession?: boolean
  /** Is the task currently completed, cancelled, or terminated? */
  isTerminalTask?: boolean
}

const sessionWatchdogs = new Map<string, WatchdogState>()

export function updateWatchdogState(sessionID: string, updates: Partial<WatchdogState>) {
  let state = sessionWatchdogs.get(sessionID)
  if (!state) {
    state = {
      sessionID,
      lastProgressAt: Date.now(),
      isPendingProvider: false,
      isPendingTool: false,
      isPendingChild: false,
      isPendingContinuation: false,
      isPendingUser: false,
      hasUnresolvedTask: false, // Default to false! Must be explicitly activated by runnable task
      recoveryExhausted: false,
      recoveryCount: 0,
      isActiveSession: false,
      isTerminalTask: false,
    }
    sessionWatchdogs.set(sessionID, state)
  }
  Object.assign(state, updates)
  // If progress fields are updated, bump timestamp
  if (updates.isPendingProvider || updates.isPendingTool || updates.isPendingChild) {
    state.lastProgressAt = Date.now()
  }
}

export function getWatchdogState(sessionID: string): WatchdogState | undefined {
  return sessionWatchdogs.get(sessionID)
}

export function clearWatchdogState(sessionID: string) {
  sessionWatchdogs.delete(sessionID)
}

export function getAllWatchdogStates(): WatchdogState[] {
  return Array.from(sessionWatchdogs.values())
}

export function clearAllWatchdogStates() {
  sessionWatchdogs.clear()
}

/**
 * Single authoritative watchdog eligibility predicate.
 * Returns true ONLY when all required active-runnable conditions are satisfied.
 */
export function isWatchdogEligible(state: WatchdogState | undefined): boolean {
  if (!state) return false
  if (!state.sessionID) return false

  // Reject if recovery is exhausted (STALLED_UNRECOVERED)
  if (state.recoveryExhausted) return false

  // Reject if task is completed, cancelled, or terminal
  if (state.isTerminalTask) return false

  // Must have an explicit unresolved executable task
  if (!state.hasUnresolvedTask) return false

  // Must be marked as an active running session
  if (state.isActiveSession === false) return false

  // Reject if work is currently in flight (provider, tool, child, recovery continuation, or waiting for user)
  if (
    state.isPendingProvider ||
    state.isPendingTool ||
    state.isPendingChild ||
    state.isPendingContinuation ||
    state.isPendingUser
  ) {
    return false
  }

  return true
}
