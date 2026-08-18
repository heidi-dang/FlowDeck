/**
 * Bounded Empty-Terminal Recovery Circuit
 *
 * Implements a bounded recovery circuit breaker for consecutive empty assistant terminal turns.
 * Finite invariant:
 *   - Empty terminal #1 → silent continuation
 *   - Empty terminal #2 → silent continuation + compact state
 *   - Empty terminal #3 → strategy reset
 *   - Continued empty/no-progress (exceeded max) → convergence circuit breaker (STALLED_UNRECOVERED / EXHAUSTED)
 *
 * Emits ONE concise diagnostic upon exhaustion and cleans up timers.
 */

export interface EmptyTerminalCircuitOptions {
  maxConsecutiveEmpty?: number
  sessionLimit?: number
}

export interface EmptyTerminalRecoveryDecision {
  action: "silent_continue" | "compact_and_continue" | "strategy_reset" | "circuit_break"
  consecutiveCount: number
  totalSessionCount: number
  incidentId: string
  strategyGeneration: number
  diagnosticMessage?: string
}

export interface EmptyTerminalIncident {
  incidentId: string
  sessionID: string
  consecutiveEmptyCount: number
  totalRecoveryCount: number
  strategyGeneration: number
  firstDetectedAt: number
  lastDetectedAt: number
  status: "OPEN" | "RESOLVED" | "EXHAUSTED"
  verifiedFacts: string[]
}

const DEFAULT_MAX_CONSECUTIVE = 3
const DEFAULT_SESSION_LIMIT = 5

export class EmptyTerminalCircuitManager {
  private incidents = new Map<string, EmptyTerminalIncident>()
  private options: Required<EmptyTerminalCircuitOptions>

  constructor(options?: EmptyTerminalCircuitOptions) {
    this.options = {
      maxConsecutiveEmpty: options?.maxConsecutiveEmpty ?? DEFAULT_MAX_CONSECUTIVE,
      sessionLimit: options?.sessionLimit ?? DEFAULT_SESSION_LIMIT,
    }
  }

  /**
   * Evaluate an empty terminal completion for a session.
   */
  recordEmptyTerminal(sessionID: string, _messageID?: string): EmptyTerminalRecoveryDecision {
    let incident = this.incidents.get(sessionID)
    const now = Date.now()

    if (!incident || incident.status === "RESOLVED") {
      incident = {
        incidentId: `etc_${sessionID}_${now}`,
        sessionID,
        consecutiveEmptyCount: 1,
        totalRecoveryCount: incident ? incident.totalRecoveryCount + 1 : 1,
        strategyGeneration: 1,
        firstDetectedAt: now,
        lastDetectedAt: now,
        status: "OPEN",
        verifiedFacts: incident?.verifiedFacts ?? [],
      }
      this.incidents.set(sessionID, incident)
    } else {
      incident.consecutiveEmptyCount++
      incident.totalRecoveryCount++
      incident.lastDetectedAt = now
    }

    const { consecutiveEmptyCount, totalRecoveryCount } = incident

    if (totalRecoveryCount > this.options.sessionLimit || consecutiveEmptyCount > this.options.maxConsecutiveEmpty) {
      incident.status = "EXHAUSTED"
      return {
        action: "circuit_break",
        consecutiveCount: consecutiveEmptyCount,
        totalSessionCount: totalRecoveryCount,
        incidentId: incident.incidentId,
        strategyGeneration: incident.strategyGeneration,
        diagnosticMessage: `[EmptyTerminalCircuit] Exhausted after ${consecutiveEmptyCount} consecutive empty completions (session total: ${totalRecoveryCount}). Unresolved task preserved; automatic recovery stopped.`,
      }
    }

    if (consecutiveEmptyCount === 1) {
      return {
        action: "silent_continue",
        consecutiveCount: 1,
        totalSessionCount: totalRecoveryCount,
        incidentId: incident.incidentId,
        strategyGeneration: incident.strategyGeneration,
      }
    }

    if (consecutiveEmptyCount === 2) {
      return {
        action: "compact_and_continue",
        consecutiveCount: 2,
        totalSessionCount: totalRecoveryCount,
        incidentId: incident.incidentId,
        strategyGeneration: incident.strategyGeneration,
      }
    }

    // consecutiveEmptyCount === 3
    incident.strategyGeneration++
    return {
      action: "strategy_reset",
      consecutiveCount: 3,
      totalSessionCount: totalRecoveryCount,
      incidentId: incident.incidentId,
      strategyGeneration: incident.strategyGeneration,
      diagnosticMessage: `[EmptyTerminalCircuit] Strategy reset generated at iteration ${incident.strategyGeneration} for session ${sessionID}.`,
    }
  }

  /**
   * Semantic progress recorded: resolves any open empty-terminal incident.
   * Note: Pure random tool execution without semantic progress should not automatically resolve.
   */
  recordSemanticProgress(sessionID: string, newFacts?: string[]): void {
    const incident = this.incidents.get(sessionID)
    if (incident) {
      incident.consecutiveEmptyCount = 0
      incident.status = "RESOLVED"
      if (newFacts && newFacts.length > 0) {
        incident.verifiedFacts.push(...newFacts)
      }
    }
  }

  getIncident(sessionID: string): EmptyTerminalIncident | undefined {
    return this.incidents.get(sessionID)
  }

  clearSession(sessionID: string): void {
    this.incidents.delete(sessionID)
  }

  clearAll(): void {
    this.incidents.clear()
  }
}

export const emptyTerminalCircuit = new EmptyTerminalCircuitManager()
