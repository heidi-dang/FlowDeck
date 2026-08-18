/**
 * WatchdogIncident — bounded watchdog nag-loop control.
 *
 * Requirement H: a watchdog prompt must NOT count as proof of recovery or
 * progress. Pathological shape (stalled -> watchdog -> timestamp updates ->
 * still stalled -> watchdog -> repeat forever) is replaced with a bounded
 * incident lifecycle:
 *
 *   stall confirmed
 *     -> one recovery directive
 *     -> still stalled
 *     -> one materially different recovery strategy
 *     -> still stalled
 *     -> mark STALLED_UNRECOVERED
 *     -> stop injecting prompts
 *
 * Watchdog-generated messages must never reset convergence state, never
 * count as user activity, never count as meaningful progress, never create
 * a new manual task, and never reclassify Fast Harness routing. Healthy
 * active sessions must never be touched.
 */

export interface WatchdogIncidentState {
  incidentId: string
  sessionID: string
  stallConfirmedAt: number
  lastDirectiveAt: number
  recoveryDirectiveCount: number
  materiallyDifferentStrategyCount: number
  status: "OPEN" | "STALLED_UNRECOVERED" | "RESOLVED"
  lastProgressEvidenceAt: number
}

export const WATCHDOG_MAX_DIRECTIVES = 2
export const WATCHDOG_MAX_STRATEGIES = 1; // after directives, exactly one new strategy

export class WatchdogIncidentManager {
  private incidents = new Map<string, WatchdogIncidentState>()

  /**
   * Called when a stall is confirmed. Returns true iff a recovery directive
   * should still be injected (bounded); false once STALLED_UNRECOVERED.
   */
  confirmStall(sessionID: string): { injectDirective: boolean; materiallyDifferent?: boolean; state: WatchdogIncidentState } {
    const now = Date.now()
    let incident = this.incidents.get(sessionID)
    if (!incident || incident.status === "RESOLVED") {
      incident = {
        incidentId: "wd_" + sessionID.slice(0, 8) + "_" + now,
        sessionID,
        stallConfirmedAt: now,
        lastDirectiveAt: now,
        recoveryDirectiveCount: 1,
        materiallyDifferentStrategyCount: 0,
        status: "OPEN",
        lastProgressEvidenceAt: 0,
      }
      this.incidents.set(sessionID, incident)
      return { injectDirective: true, state: incident }
    }

    // Still stalled after previous directive(s).
    if (incident.status === "STALLED_UNRECOVERED") {
      return { injectDirective: false, state: incident }
    }

    if (incident.recoveryDirectiveCount < WATCHDOG_MAX_DIRECTIVES) {
      incident.recoveryDirectiveCount++
      incident.lastDirectiveAt = now
      return { injectDirective: true, state: incident }
    }

    // Directives exhausted: emit exactly one materially different strategy
    // and then stop nagging.
    if (incident.materiallyDifferentStrategyCount < WATCHDOG_MAX_STRATEGIES) {
      incident.materiallyDifferentStrategyCount++
      incident.lastDirectiveAt = now
      return { injectDirective: true, materiallyDifferent: true, state: incident }
    }

    incident.status = "STALLED_UNRECOVERED"
    incident.lastDirectiveAt = now
    return { injectDirective: false, state: incident }
  }

  /**
   * Record real evidence of progress. This is the only way to resolve a
   * watchdog incident. Watchdog-generated messages themselves never count.
   */
  recordProgressEvidence(sessionID: string, evidence: string): void {
    const incident = this.incidents.get(sessionID)
    if (!incident) return
    incident.lastProgressEvidenceAt = Date.now()
    incident.status = "RESOLVED"
    void evidence
  }

  /**
   * Record non-progress activity (e.g. a watchdog prompt was emitted). This
   * must NOT resolve or reset the incident and must NOT count as progress.
   */
  recordNonProgressActivity(sessionID: string): void {
    const incident = this.incidents.get(sessionID)
    if (!incident) return
    // Only update timestamp; never reset counters, never resolve.
    void incident
  }

  isStalledUnrecovered(sessionID: string): boolean {
    const incident = this.incidents.get(sessionID)
    return incident?.status === "STALLED_UNRECOVERED"
  }

  getIncident(sessionID: string): WatchdogIncidentState | undefined {
    const i = this.incidents.get(sessionID)
    return i ? { ...i } : undefined
  }

  clearSession(sessionID: string): void {
    this.incidents.delete(sessionID)
  }

  clearAll(): void {
    this.incidents.clear()
  }
}

export const watchdogIncidentManager = new WatchdogIncidentManager()
