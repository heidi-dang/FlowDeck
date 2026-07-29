/**
 * Criterion priority policy.
 *
 * Defines how each priority level maps to verification requirements:
 * - critical: must pass and cannot be overridden
 * - high: must pass unless a valid policy-approved override exists
 * - medium_mandatory: must pass unless a valid policy-approved override exists
 * - advisory: non-blocking but recorded
 *
 * Override logic belongs to Phase 2C. This policy defines the base
 * requirements without overrides.
 */

import type { CriterionPriority } from "../../contracts/domain/specification"

export type PriorityRequirement = "required" | "overridable" | "advisory"

/**
 * Returns the base verification requirement for a given priority.
 * At this phase (no overrides), critical/high/medium_mandatory all
 * require passing results. Advisory is non-blocking.
 */
export function getPriorityRequirement(priority: CriterionPriority): PriorityRequirement {
  switch (priority) {
    case "critical":
      return "required"
    case "high":
      return "overridable"
    case "medium_mandatory":
      return "overridable"
    case "advisory":
      return "advisory"
  }
}

/**
 * Returns true if a result status is acceptable for the given priority
 * WITHOUT overrides (Phase 2C adds override logic).
 */
export function isResultAcceptable(
  status: "passed" | "failed" | "skipped" | "pending" | "running",
  priority: CriterionPriority,
): boolean {
  if (status === "passed") return true

  const requirement = getPriorityRequirement(priority)

  // At this phase without overrides, only passed is acceptable
  // for required and overridable priorities
  if (requirement === "required" || requirement === "overridable") {
    return false
  }

  // Advisory: any status is acceptable (non-blocking)
  return true
}

/**
 * Returns the evaluation of verification rules against a priority policy.
 * Returns structured reasons for each failing rule.
 */
export interface RuleEvaluation {
  readonly ruleId: string
  readonly description: string
  readonly priority: CriterionPriority
  readonly required: boolean
  readonly status: "passed" | "failed" | "skipped" | "pending" | "running"
  readonly acceptable: boolean
  readonly reason?: string
}
