/**
 * Routing-owned specialist allow-list projection.
 *
 * Rule 17 (classifier fallback) maps `userRequiredSpecialist` to a task
 * class ONLY when the id is a canonical specialist. The set of valid
 * specialist identities is DERIVED from the canonical agent registry
 * (`src/services/canonical-registry.ts` `getSubagentIds()`), which is the
 * single authoritative agent list — this module never maintains a second
 * manually synchronized specialist ID list. Registry additions/removals
 * automatically change the derived allow-list, and the parity test fails
 * until a task-class mapping is provided for every canonical specialist.
 *
 * The orchestrator aliases (heidi/orchestrator) are primary agents, not
 * specialists, and are therefore excluded by construction. Task-class
 * mapping stays routing-owned; only valid identities are derived.
 */

import { getSubagentIds } from "@/services/canonical-registry"
import type { TaskClass } from "@/orchestration/routing/contracts"

/**
 * Canonical specialist ids, projected from the canonical agent registry.
 * Readonly snapshot at load; parity tests assert it stays in sync with the
 * registry so additions/removals cannot silently go unmapped.
 */
export const CANONICAL_SPECIALIST_IDS: readonly string[] = Object.freeze(getSubagentIds())

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
 * per document section 4.2 normalization rules. Deterministic and
 * idempotent.
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

/**
 * Returns true when every canonical specialist id has a task-class mapping.
 * A registry addition without a mapping (or a mapping for a removed id)
 * makes this false, failing the parity test until reconciled.
 */
export function specialistMappingComplete(): boolean {
  return CANONICAL_SPECIALIST_IDS.every((id) => SPECIALIST_TASK_CLASS[id] !== undefined)
}
