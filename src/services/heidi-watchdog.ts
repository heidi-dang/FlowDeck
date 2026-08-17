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
      hasUnresolvedTask: true,
      recoveryExhausted: false,
      recoveryCount: 0,
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
