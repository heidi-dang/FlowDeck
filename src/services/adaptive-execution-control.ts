import { createHash } from "node:crypto"
import type { TokenBudgetController } from "./token-budget-controller"
import type { TokenUsageStore } from "./token-usage-store"

export interface StallObservation { repeatedFailure: number; repeatedTool: number; unchangedDiff: number; repeatedContext: number; evidenceDelta: number; tokensSinceProgress: number; }
export interface StallResult { stalled: boolean; reasons: string[] }
export function detectStall(observation: StallObservation): StallResult {
  const reasons: string[] = []
  if (observation.repeatedFailure >= 3) reasons.push("repeated_failure")
  if (observation.repeatedTool >= 4) reasons.push("repeated_tool")
  if (observation.unchangedDiff >= 3 && observation.tokensSinceProgress > 1000) reasons.push("unchanged_diff")
  if (observation.repeatedContext >= 4 && observation.evidenceDelta === 0) reasons.push("repeated_context")
  return { stalled: reasons.length >= 2 || reasons.includes("repeated_failure") && observation.tokensSinceProgress > 500, reasons }
}

/** Adaptive policy layered on TokenBudgetController. The controller remains responsible
 * for all ceilings, reservations, provider reconciliation, and cancellation accounting. */
export class AdaptiveExecutionControl {
  constructor(private readonly controller: TokenBudgetController, private readonly store: TokenUsageStore) {}
  reclaimExactlyOnce(runId: string, reservationId: string, workstreamId: string, reserved: number, actual: number, reason: string): number {
    const eventId = `reclaim:${reservationId}`; if (this.store.read(runId).some(e => e.kind === "adaptive_reclaim" && e.eventId === eventId)) return 0
    const reclaimed = Math.max(0, reserved - actual)
    this.store.append(runId, { kind: "adaptive_reclaim", eventId, reservationId, workstreamId, reserved, actual, reclaimed, reason, at: Date.now() })
    return reclaimed
  }
  async redistribute(runId: string, targetWorkstreamId: string, sessionId: string, agentId: string, amount: number, reason: string, sourceReservationId?: string): Promise<{ allowed: boolean; reservationId: string; amount: number }> {
    if (!Number.isFinite(amount) || amount <= 0) return { allowed: false, reservationId: "", amount: 0 }
    const eventId = `redistribute:${targetWorkstreamId}:${sourceReservationId ?? "pool"}:${amount}`
    if (this.store.read(runId).some(e => e.kind === "adaptive_redistribution" && e.eventId === eventId)) return { allowed: false, reservationId: "", amount: 0 }
    const result = await this.controller.reserveRequest({ runId, sessionId, agentId, requestId: `adaptive-${createHash("sha256").update(eventId).digest("hex").slice(0, 20)}`, estimatedInputTokens: 0, maxOutputTokens: amount })
    if (!result.allowed) return { allowed: false, reservationId: result.reservationId, amount: 0 }
    this.store.append(runId, { kind: "adaptive_redistribution", eventId, sourceReservationId, targetWorkstreamId, amount: result.claimed, reason, at: Date.now() })
    return { allowed: true, reservationId: result.reservationId, amount: result.claimed }
  }
  async terminate(runId: string, sessionId: string, workstreamId: string, reason: "duplicate" | "superseded" | "dependency_failed" | "no_progress" | "budget_exhausted" | "policy_violation" | "manual_cancel"): Promise<void> {
    const eventId = `terminate:${workstreamId}:${reason}`
    if (this.store.read(runId).some(e => e.kind === "workstream_termination" && e.eventId === eventId)) return
    await this.controller.cancelSession(sessionId, reason)
    this.store.append(runId, { kind: "workstream_termination", eventId, workstreamId, reason, at: Date.now() })
  }
}
