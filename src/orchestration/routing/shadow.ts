import { routeTask, type TaskIntelligenceInput } from "./intelligence"
import type { RoutingDecisionStore } from "./store"
import type { RoutingDecision } from "./contracts/task-intelligence"
import type { OrchestrationMetrics } from "../metrics"

export type RoutingMode = "off" | "shadow" | "enforce"
export interface ShadowComparison { mode: RoutingMode; decision: RoutingDecision | null; existingStrategy: string; divergent: boolean; error?: string }

export function runShadowAssessment(input: TaskIntelligenceInput, existingStrategy: string, mode: RoutingMode, store?: RoutingDecisionStore, metrics?: OrchestrationMetrics): ShadowComparison {
  if (mode === "off") return { mode, decision: null, existingStrategy, divergent: false }
  const started = Date.now()
  try {
    const decision = routeTask(input)
    const persisted = store?.saveDecision(decision) ?? decision
    metrics?.recordRoutingDecision(persisted.assessment.taskClass, persisted.strategy, persisted.delegate, persisted.strategy !== existingStrategy, Date.now() - started, persisted.assessment.parallelism)
    return { mode, decision: persisted, existingStrategy, divergent: persisted.strategy !== existingStrategy }
  } catch (error) {
    metrics?.routingShadowFailures.inc()
    return { mode, decision: null, existingStrategy, divergent: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function explainRouting(decision: RoutingDecision): Record<string, unknown> {
  return { taskClass: decision.assessment.taskClass, complexity: decision.assessment.complexity.score, ambiguity: decision.assessment.ambiguity.score, risk: decision.assessment.risk.score, parallelism: decision.assessment.parallelism, strategy: decision.strategy, delegate: decision.delegate, specialists: decision.delegations.map(d => d.agentId), budget: decision.budgetRecommendation, rationale: decision.rationale }
}
