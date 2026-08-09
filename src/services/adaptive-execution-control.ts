import { createHash } from "node:crypto"
import type { RawUsage, TokenBudgetController } from "./token-budget-controller"
import type { ReservationResult } from "./token-budget-controller"
import type { TokenUsageStore } from "./token-usage-store"
import type { OrchestrationMetrics } from "../orchestration/metrics"
import { BUDGET_PROFILES, type BudgetProfileName } from "../config/token-budget-config"

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
  constructor(private readonly controller: TokenBudgetController, private readonly store: TokenUsageStore, private readonly metrics?: OrchestrationMetrics) {}
  openWorkstream(workstreamId: string, sessionId: string, agentId: string, profile: BudgetProfileName, parentSessionId?: string): WorkstreamBudgetHandle {
    this.controller.registerSession(sessionId, agentId, parentSessionId)
    const profileCeiling = BUDGET_PROFILES[profile].childTotal
    return {
      profile,
      reserve: (input) => this.controller.reserveRequest({ runId: this.controller.runId, sessionId, agentId, parentSessionId, requestId: input.requestId, assignmentId: input.assignmentId, estimatedInputTokens: input.estimatedInputTokens, maxOutputTokens: Math.min(input.maxOutputTokens, profileCeiling), model: input.model, provider: input.provider }),
      reconcile: (input) => this.reconcileCompletion({ runId: this.controller.runId, reservationId: input.reservationId, workstreamId, sessionId, agentId, parentSessionId, assignmentId: input.assignmentId, requestId: input.requestId, messageId: input.messageId, usage: input.usage, model: input.model, provider: input.provider, reason: input.reason }),
      terminate: (reason) => this.terminate(this.controller.runId, sessionId, workstreamId, reason),
      observe: async (observation) => { const result = detectStall(observation); if (result.stalled) { this.metrics?.executionStalls.inc(); await this.terminate(this.controller.runId, sessionId, workstreamId, "no_progress") } return result },
    }
  }
  async reconcileCompletion(input: { runId: string; reservationId: string; workstreamId: string; sessionId: string; agentId: string; parentSessionId?: string; assignmentId?: string; requestId: string; messageId: string; usage: RawUsage; model?: string; provider?: string; reason: string }): Promise<{ committed: boolean; reclaimed: number; remainingRun: number }> {
    const result = await this.controller.commitUsage({ runId: input.runId, reservationId: input.reservationId, sessionId: input.sessionId, agentId: input.agentId, parentSessionId: input.parentSessionId, assignmentId: input.assignmentId, requestId: input.requestId, messageId: input.messageId, usage: input.usage, model: input.model, provider: input.provider, terminationReason: input.reason })
    if (!result.committed) return { committed: false, reclaimed: 0, remainingRun: result.remainingRun }
    if (result.releasedUnused > 0) {
      this.store.append(input.runId, { kind: "adaptive_reclaim", eventId: `reclaim:${input.reservationId}`, reservationId: input.reservationId, workstreamId: input.workstreamId, reserved: 0, actual: result.billable, reclaimed: result.releasedUnused, reason: input.reason, at: Date.now() })
      this.metrics?.budgetReclaimed.inc(result.releasedUnused)
    }
    return { committed: true, reclaimed: result.releasedUnused, remainingRun: result.remainingRun }
  }
  async redistribute(runId: string, targetWorkstreamId: string, sessionId: string, agentId: string, amount: number, reason: string, sourceReservationId?: string): Promise<{ allowed: boolean; reservationId: string; amount: number }> {
    if (!Number.isFinite(amount) || amount <= 0) return { allowed: false, reservationId: "", amount: 0 }
    const eventId = `redistribute:${targetWorkstreamId}:${sourceReservationId ?? "pool"}:${amount}`
    if (this.store.read(runId).some(e => e.kind === "adaptive_redistribution" && e.eventId === eventId)) return { allowed: false, reservationId: "", amount: 0 }
    const result = await this.controller.reserveRequest({ runId, sessionId, agentId, requestId: `adaptive-${createHash("sha256").update(eventId).digest("hex").slice(0, 20)}`, estimatedInputTokens: 0, maxOutputTokens: amount })
    if (!result.allowed) return { allowed: false, reservationId: result.reservationId, amount: 0 }
    this.store.append(runId, { kind: "adaptive_redistribution", eventId, sourceReservationId, targetWorkstreamId, amount: result.claimed, reason, at: Date.now() })
    this.metrics?.budgetRedistributed.inc(result.claimed)
    return { allowed: true, reservationId: result.reservationId, amount: result.claimed }
  }
  async terminate(runId: string, sessionId: string, workstreamId: string, reason: "duplicate" | "superseded" | "dependency_failed" | "no_progress" | "budget_exhausted" | "policy_violation" | "manual_cancel"): Promise<void> {
    const eventId = `terminate:${workstreamId}:${reason}`
    if (this.store.read(runId).some(e => e.kind === "workstream_termination" && e.eventId === eventId)) return
    await this.controller.cancelSession(sessionId, reason)
    this.store.append(runId, { kind: "workstream_termination", eventId, workstreamId, reason, at: Date.now() })
    this.metrics?.executionTerminations.inc()
  }
}

export interface WorkstreamBudgetHandle {
  readonly profile: BudgetProfileName
  reserve(input: { requestId: string; assignmentId?: string; estimatedInputTokens: number; maxOutputTokens: number; model?: string; provider?: string }): Promise<ReservationResult>
  reconcile(input: { reservationId: string; requestId: string; messageId: string; assignmentId?: string; usage: RawUsage; model?: string; provider?: string; reason: string }): Promise<{ committed: boolean; reclaimed: number; remainingRun: number }>
  terminate(reason: "duplicate" | "superseded" | "dependency_failed" | "no_progress" | "budget_exhausted" | "policy_violation" | "manual_cancel"): Promise<void>
  observe(observation: StallObservation): Promise<StallResult>
}
