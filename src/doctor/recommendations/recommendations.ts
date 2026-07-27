import type { CheckResult, Recommendation } from "../types"

/**
 * Generate recommendations from check results.
 * Each check with status "error" or "warning" may produce a recommendation.
 * Recommendations are deduplicated and sorted by priority.
 */
export function generateRecommendations(checks: CheckResult[]): Recommendation[] {
  const recommendations: Recommendation[] = []
  const seen = new Set<string>()

  // Process errors first (they become required fixes)
  for (const check of checks) {
    if (check.status !== "error") continue
    if (seen.has(check.id)) continue
    seen.add(check.id)

    recommendations.push({
      id: `fix_${check.id}`,
      type: "required",
      priority: 10,
      title: `Fix: ${check.title}`,
      description: check.detected,
      benefit: `Resolves "${check.title}" — expected: ${check.expected}`,
      risk: "Low — fixing configuration issues rarely causes regressions",
      estimatedImpact: check.severity === "high" ? "high" : "medium",
      autoFixAvailable: check.autoFixAvailable,
      checkIds: [check.id],
    })
  }

  // Process warnings (recommended improvements)
  for (const check of checks) {
    if (check.status !== "warning") continue
    if (seen.has(check.id)) continue
    seen.add(check.id)

    recommendations.push({
      id: `improve_${check.id}`,
      type: "recommended",
      priority: 20,
      title: `Improve: ${check.title}`,
      description: check.detected,
      benefit: check.recommendation,
      risk: "Low — recommended but not required",
      estimatedImpact: "medium",
      autoFixAvailable: check.autoFixAvailable,
      checkIds: [check.id],
    })
  }

  // Process missing optional dependencies
  const missingOpt = checks.filter(c =>
    c.id.startsWith("runtime.") && c.status === "warning" && c.id !== "runtime.bun"
  )
  for (const check of missingOpt) {
    recommendations.push({
      id: `optional_${check.id}`,
      type: "optional",
      priority: 30,
      title: `Optional: Install ${check.title}`,
      description: check.detected,
      benefit: check.recommendation,
      risk: "None — purely optional enhancement",
      estimatedImpact: "low",
      autoFixAvailable: false,
      checkIds: [check.id],
    })
  }

  // Sort by priority
  recommendations.sort((a, b) => a.priority - b.priority)

  return recommendations
}
