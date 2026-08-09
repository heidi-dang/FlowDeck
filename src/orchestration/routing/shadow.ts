import { routeTask, type TaskIntelligenceInput } from "./intelligence"
import type { RoutingDecisionStore } from "./store"
import type { RoutingDecision } from "./contracts/task-intelligence"

export type RoutingMode = "off" | "shadow"
export interface ShadowComparison { mode: RoutingMode; decision: RoutingDecision | null; existingStrategy: string; divergent: boolean; error?: string }

export function runShadowAssessment(input: TaskIntelligenceInput, existingStrategy: string, mode: RoutingMode, store?: RoutingDecisionStore): ShadowComparison {
  if (mode === "off") return { mode, decision: null, existingStrategy, divergent: false }
  try {
    const decision = routeTask(input)
    store?.append(decision)
    return { mode, decision, existingStrategy, divergent: decision.strategy !== existingStrategy }
  } catch (error) {
    return { mode, decision: null, existingStrategy, divergent: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function explainRouting(decision: RoutingDecision): Record<string, unknown> {
  return { taskClass: decision.assessment.taskClass, complexity: decision.assessment.complexity.score, ambiguity: decision.assessment.ambiguity.score, risk: decision.assessment.risk.score, parallelism: decision.assessment.parallelism, strategy: decision.strategy, delegate: decision.delegate, specialists: decision.delegations.map(d => d.agentId), budget: decision.budgetRecommendation, rationale: decision.rationale }
}
