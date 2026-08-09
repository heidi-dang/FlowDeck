export interface RoutingActivationEvidence { milestone1: boolean; executionPlanner: boolean; adaptiveBudget: boolean; performanceIntelligence: boolean; determinism: boolean; safety: boolean; modelAuthority: boolean; budgetAuthority: boolean; completionAuthority: boolean }
export function assertEnforceReady(evidence: RoutingActivationEvidence): void {
  const missing = Object.entries(evidence).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length) throw new Error(`ROUTING_ENFORCE_NOT_READY:${missing.join(",")}`)
}
