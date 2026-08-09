import type { RoutingDecision } from "../routing/contracts/task-intelligence"
import { analyzeDependencies, executionPlanSchema, type ExecutionPlan } from "./contracts"

export function executionPlanFromRouting(decision: RoutingDecision): ExecutionPlan {
  const delegations = new Map(decision.delegations.map(d => [d.ownership[0], d]))
  const source = decision.workstreams.length ? decision.workstreams : [{ id: "direct", ownership: ["**"], dependsOn: [], rationale: "Primary execution remains authoritative" }]
  const workstreams = source.map((w, index) => {
    const delegation = w.ownership.map(path => delegations.get(path)).find(Boolean)
    return { workstreamId: `${decision.routingDecisionId}:${w.id}`, runId: decision.runId, planId: `plan_${decision.routingDecisionId}`, resolvedAgent: delegation?.agentId ?? "heidi", requiredCapability: delegation?.capability ?? "orchestrator", objective: w.rationale, requirements: [w.rationale], acceptanceCriteria: [], ownedPaths: w.ownership, ownedSymbols: [], dependsOn: w.dependsOn.map(dep => `${decision.routingDecisionId}:${dep}`), strategy: decision.strategy, budgetProfile: decision.budgetRecommendation, contextScope: decision.assessment.taskClass === "audit" ? "audit" as const : "owned" as const, status: "planned" as const, blockedBy: [], createdAt: decision.createdAt }
  })
  const plan = executionPlanSchema.parse({ planId: `plan_${decision.routingDecisionId}`, runId: decision.runId, routingDecisionId: decision.routingDecisionId, sourceSha: decision.sourceSha, policyVersion: decision.policyVersion, createdAt: decision.createdAt, workstreams })
  analyzeDependencies(plan)
  return plan
}
