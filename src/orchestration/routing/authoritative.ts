import type { RoutingDecision } from "./contracts/task-intelligence"
import { assertEnforceReady, type RoutingActivationEvidence } from "./activation"
import { executionPlanFromRouting } from "../execution/planner"
import type { SqliteExecutionRepository } from "../execution/sqlite-repository"
import type { IsolatedWorkstreamExecutor } from "../execution/worktree-executor"

export interface EnforceResult { mode: "enforce"; planId: string; decisionId: string; fallback: false }
export interface EnforceFallback { mode: "shadow" | "off"; fallback: true; reason: string; decisionId?: string }
export interface EnforcedExecutionDispatcher {
  executePlan(planId: string, sourceSha: string, executor: IsolatedWorkstreamExecutor): Promise<{ succeeded: string[]; failed: string[]; blocked: string[] }>
}
export class AuthoritativeRoutingService {
  constructor(private readonly execution: SqliteExecutionRepository, private dispatcher?: EnforcedExecutionDispatcher) {}
  setDispatcher(dispatcher: EnforcedExecutionDispatcher): void { this.dispatcher = dispatcher }
  activate(decision: RoutingDecision, currentSourceSha: string, evidence: RoutingActivationEvidence): EnforceResult | EnforceFallback {
    try {
      assertEnforceReady(evidence)
      if (decision.routingMode === "recommendation") {
        throw new Error("ROUTING_DECISION_RECOMMENDATION_ONLY")
      }
      if (decision.delegate && decision.delegations.length === 0) {
        throw new Error("ROUTING_DELEGATION_OWNERSHIP_UNRESOLVED")
      }
      if (decision.strategy === "parallel_implementation" && decision.workstreams.length === 0) {
        throw new Error("ROUTING_PARALLEL_WORKSTREAMS_UNRESOLVED")
      }
      if (decision.sourceSha !== currentSourceSha) throw new Error("ROUTING_DECISION_STALE")
      const plan = executionPlanFromRouting(decision)
      const existing = typeof (this.execution as unknown as { getPlan?: unknown }).getPlan === "function" ? this.execution.getPlan(plan.planId) : null
      if (existing) {
        if (existing.routingDecisionId !== plan.routingDecisionId || existing.sourceSha !== plan.sourceSha || existing.policyVersion !== plan.policyVersion) throw new Error("EXECUTION_PLAN_IDENTITY_CONFLICT")
      } else this.execution.savePlan(plan)
      return { mode: "enforce", planId: plan.planId, decisionId: decision.routingDecisionId, fallback: false }
    } catch (error) { return { mode: "shadow", fallback: true, reason: error instanceof Error ? error.message : String(error), decisionId: decision.routingDecisionId } }
  }
  async activateAndExecute(decision: RoutingDecision, currentSourceSha: string, evidence: RoutingActivationEvidence, executor: IsolatedWorkstreamExecutor): Promise<(EnforceResult & { execution: { succeeded: string[]; failed: string[]; blocked: string[] } }) | EnforceFallback> {
    // Do not persist an authoritative execution plan when the production
    // dispatcher is unavailable. Enforce mode is fail-closed before any
    // durable execution authority is created; callers can then apply the
    // configured shadow/off fallback without leaving a stranded plan.
    if (!this.dispatcher) return { mode: "shadow", fallback: true, reason: "ROUTING_EXECUTION_DISPATCH_UNAVAILABLE", decisionId: decision.routingDecisionId }
    const activation = this.activate(decision, currentSourceSha, evidence)
    if (activation.fallback) return activation
    try {
      const execution = await this.dispatcher.executePlan(activation.planId, currentSourceSha, executor)
      return { ...activation, execution }
    } catch (error) {
      return { mode: "shadow", fallback: true, reason: error instanceof Error ? error.message : String(error), decisionId: decision.routingDecisionId }
    }
  }
}
