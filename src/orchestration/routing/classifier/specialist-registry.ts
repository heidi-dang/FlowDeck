/**
 * Routing-owned specialist allow-list projection.
 *
 * Rule 17 (classifier fallback) maps `userRequiredSpecialist` to a task
 * class ONLY when the id is a canonical specialist. This module is the
 * routing domain's own projection of the canonical agent registry (document
 * section 1.3); it is deliberately independent of src/services so the
 * routing layer never depends on the services layer. The allow-list
 * distinguishes a recognized specialist (deterministic class mapping) from
 * an unrecognized id (classified as "unknown" with low confidence).
 */

import type { TaskClass } from "@/orchestration/routing/contracts"

/** Canonical specialist ids, projected from the canonical agent registry. */
export const CANONICAL_SPECIALIST_IDS: readonly string[] = [
  "planner",
  "architect",
  "researcher",
  "mapper",
  "backend-coder",
  "frontend-coder",
  "devops",
  "tester",
  "reviewer",
  "security-auditor",
  "debug-specialist",
]

/**
 * Deterministic specialist -> TaskClass mapping used by fallback rule 17.
 * Every canonical specialist id resolves to a class; ids outside the
 * allow-list resolve to undefined and classify as "unknown".
 */
export const SPECIALIST_TASK_CLASS: Readonly<Record<string, TaskClass>> = {
  planner: "cross_module_feature",
  architect: "cross_module_feature",
  researcher: "read_only_question",
  mapper: "repository_audit",
  "backend-coder": "cross_module_feature",
  "frontend-coder": "ui_feature",
  devops: "ci_failure",
  tester: "local_bug",
  reviewer: "repository_audit",
  "security-auditor": "security_review",
  "debug-specialist": "local_bug",
}

/**
 * Normalizes a raw specialist reference (trim, lowercase) before matching,
 * per document section 4.2 normalization rules.
 */
export function normalizeSpecialistId(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Returns the deterministic TaskClass for a normalized specialist id, or
 * undefined when the id is not a canonical specialist.
 */
export function resolveSpecialistClass(normalizedId: string): TaskClass | undefined {
  return SPECIALIST_TASK_CLASS[normalizedId]
}
