/**
 * Deterministic rule-based task classifier for the routing layer.
 *
 * Pure and deterministic: no randomness, no Date, no model calls, no I/O.
 * The same ClassificationInput always produces a byte-identical
 * ClassificationResult (verified by classifyWithConsistency).
 *
 * PRIORITY ORDER (first satisfied rule wins) — deviations from the numbered
 * coverage list are marked ADJUSTED:
 *   1.  production_incident      productionImpact >= 70 (highest priority)
 *   2.  release_failure          releaseImpact && ciContext
 *   3.  build_package_failure    ciContext && buildOrPackageFailure
 *   4.  database_migration       migrationInvolved      [ADJUSTED: above ci_failure]
 *   5.  security_review          securitySensitive
 *   6.  ci_failure               ciContext && !buildOrPackageFailure [ADJUSTED]
 *   7.  concurrency_failure      concurrencyInvolved
 *   8.  repository_audit         explicitAuditRequest && !securitySensitive && !mutating
 *   9.  documentation            rawPrompt doc-regex && !mutating [ADJUSTED: above read_only_question]
 *   10. read_only_question       readOnly && !mutating && !explicitAuditRequest && !ciContext
 *   11. recovery_resume          recoveryState
 *   12. ui_feature               uiInvolved && expectedFileCount >= 1
 *   13. trivial_edit             single file, no tests, one domain, no major signals
 *   14. local_bug                hasTests && fileCount <= 2 && !ciContext && productionImpact < 70
 *   15. performance_work         rawPrompt perf-regex && !concurrencyInvolved
 *   16. cross_module_feature     fileCount >= 3 || domainCount >= 2
 *   17. fallback                 userRequiredSpecialist mapping (else "unknown")
 *
 * ADJUSTED reasons: database_migration sits above ci_failure so a migration is
 * never missed when CI context is also present; documentation sits above
 * read_only_question so a documentation prompt that is also readOnly=true
 * classifies as documentation rather than as a generic read-only question.
 * Rules 1-8 still beat read_only_question, security_review still beats
 * repository_audit, and production_incident beats everything.
 */

import type {
  ClassificationInput,
  ClassificationResult,
  TaskClass,
  EvidenceReference,
} from "@/orchestration/routing/contracts"
import { TASK_CLASSES, ROUTING_POLICY_VERSION, SCORE_MIN, SCORE_MAX } from "@/orchestration/routing/contracts"

/** Below this confidence a classification is downgraded to "unknown". */
export const DEFAULT_CLASSIFICATION_THRESHOLD = 60

/** Minimum number of evidence entries required for a confident class. */
export const MIN_CLASSIFICATION_EVIDENCE = 2

/** Classes treated as high risk by downstream strategy selection. */
export const HIGH_RISK_CLASSES: readonly TaskClass[] = [
  "production_incident",
  "database_migration",
  "concurrency_failure",
  "security_review",
  "release_failure",
]

/** Classes that imply mutation of repository state. */
export const MUTATING_CLASSES: readonly TaskClass[] = [
  "trivial_edit",
  "local_bug",
  "cross_module_feature",
  "ui_feature",
  "database_migration",
  "concurrency_failure",
  "build_package_failure",
  "release_failure",
  "production_incident",
  "recovery_resume",
]

/** Read-only classes; mutating=true conflicts with them. */
const READ_ONLY_CLASSES: readonly TaskClass[] = ["read_only_question", "repository_audit", "documentation"]

/** Documentation-prompt detection regex (rule 9). No /g flag: stateless, deterministic. */
const DOCUMENTATION_RE = /doc(umentation)?|readme|guide|how\s+to|explain/i

/** Performance-prompt detection regex (rule 15). No /g flag: stateless, deterministic. */
const PERFORMANCE_RE = /perform|latency|benchmark|profil|slow|throughput/i

/** userRequiredSpecialist -> TaskClass mapping used by the fallback rule. */
const SPECIALIST_FALLBACK: Readonly<Record<string, TaskClass>> = {
  "security-auditor": "security_review",
  researcher: "read_only_question",
  devops: "ci_failure",
  tester: "local_bug",
  architect: "cross_module_feature",
}

/** A single deterministic classification rule. */
interface ClassificationRule {
  id: string
  taskClass: TaskClass
  predicate: (input: ClassificationInput) => boolean
  describe: (input: ClassificationInput) => string
}

/**
 * True when any major signal that rules out a trivial edit is present.
 * Mirrors the signal thresholds of the rules that outrank trivial_edit.
 */
function hasMajorSignals(input: ClassificationInput): boolean {
  return (
    (input.productionImpact !== undefined && input.productionImpact >= 70) ||
    input.releaseImpact === true ||
    input.securitySensitive === true ||
    input.migrationInvolved === true ||
    input.concurrencyInvolved === true ||
    input.uiInvolved === true ||
    input.ciContext === true
  )
}

/** Priority-ordered rule table; the first satisfied rule wins. */
const RULES: readonly ClassificationRule[] = [
  {
    id: "production_incident",
    taskClass: "production_incident",
    predicate: (input) => input.productionImpact !== undefined && input.productionImpact >= 70,
    describe: (input) => `productionImpact=${input.productionImpact} meets the incident threshold (>= 70)`,
  },
  {
    id: "release_failure",
    taskClass: "release_failure",
    predicate: (input) => input.releaseImpact === true && input.ciContext === true,
    describe: () => "releaseImpact=true within a CI context",
  },
  {
    id: "build_package_failure",
    taskClass: "build_package_failure",
    predicate: (input) => input.ciContext === true && input.buildOrPackageFailure === true,
    describe: () => "build/package failure reported within a CI context",
  },
  {
    id: "database_migration",
    taskClass: "database_migration",
    predicate: (input) => input.migrationInvolved === true,
    describe: () => "database migration involved",
  },
  {
    id: "security_review",
    taskClass: "security_review",
    predicate: (input) => input.securitySensitive === true,
    describe: () => "security-sensitive work requested",
  },
  {
    id: "ci_failure",
    taskClass: "ci_failure",
    predicate: (input) => input.ciContext === true && input.buildOrPackageFailure !== true,
    describe: () => "CI context without a build/package failure",
  },
  {
    id: "concurrency_failure",
    taskClass: "concurrency_failure",
    predicate: (input) => input.concurrencyInvolved === true,
    describe: () => "concurrency involved",
  },
  {
    id: "repository_audit",
    taskClass: "repository_audit",
    predicate: (input) =>
      input.explicitAuditRequest === true && input.securitySensitive !== true && input.mutating !== true,
    describe: () => "explicit audit requested without security or mutating signals",
  },
  {
    id: "documentation",
    taskClass: "documentation",
    predicate: (input) =>
      typeof input.rawPrompt === "string" && DOCUMENTATION_RE.test(input.rawPrompt) && input.mutating !== true,
    describe: () => "prompt requests documentation (matches /doc(umentation)?|readme|guide|how\\s+to|explain/i)",
  },
  {
    id: "read_only_question",
    taskClass: "read_only_question",
    predicate: (input) =>
      input.readOnly === true &&
      input.mutating !== true &&
      input.explicitAuditRequest !== true &&
      input.ciContext !== true,
    describe: () => "read-only question (readOnly=true, not mutating, no audit/CI context)",
  },
  {
    id: "recovery_resume",
    taskClass: "recovery_resume",
    predicate: (input) => input.recoveryState === true,
    describe: () => "recovery state present",
  },
  {
    id: "ui_feature",
    taskClass: "ui_feature",
    predicate: (input) => input.uiInvolved === true && (input.expectedFileCount ?? 0) >= 1,
    describe: (input) => `UI work across ${input.expectedFileCount ?? 0} expected file(s)`,
  },
  {
    id: "trivial_edit",
    taskClass: "trivial_edit",
    predicate: (input) =>
      input.expectedFileCount === 1 &&
      input.hasTests !== true &&
      (input.expectedDomainCount ?? 0) <= 1 &&
      !hasMajorSignals(input),
    describe: () => "single-file edit without tests across at most one domain and no major signals",
  },
  {
    id: "local_bug",
    taskClass: "local_bug",
    predicate: (input) =>
      input.hasTests === true &&
      (input.expectedFileCount ?? 0) <= 2 &&
      input.ciContext !== true &&
      (input.productionImpact ?? 0) < 70,
    describe: () => "tests present with at most two expected files outside CI",
  },
  {
    id: "performance_work",
    taskClass: "performance_work",
    predicate: (input) =>
      typeof input.rawPrompt === "string" &&
      PERFORMANCE_RE.test(input.rawPrompt) &&
      input.concurrencyInvolved !== true,
    describe: () =>
      "prompt requests performance work (matches /perform|latency|benchmark|profil|slow|throughput/i)",
  },
  {
    id: "cross_module_feature",
    taskClass: "cross_module_feature",
    predicate: (input) => (input.expectedFileCount ?? 0) >= 3 || (input.expectedDomainCount ?? 0) >= 2,
    describe: (input) =>
      `cross-module scope: ${input.expectedFileCount ?? 0} expected file(s), ${input.expectedDomainCount ?? 0} domain(s)`,
  },
]

// Load-time invariant: every rule class must be part of the canonical
// taxonomy so classification can never emit a non-canonical class string.
for (const rule of RULES) {
  if (!(TASK_CLASSES as readonly unknown[]).includes(rule.taskClass)) {
    throw new Error(`classifier: rule "${rule.id}" references unknown task class "${rule.taskClass}"`)
  }
}

/** Evidence contributed by the winning rule (always at least MIN entries). */
function winnerEvidence(rule: ClassificationRule, input: ClassificationInput): EvidenceReference[] {
  return [
    {
      id: `cls.${rule.taskClass}.1`,
      source: `rule.${rule.id}`,
      detail: rule.describe(input),
    },
    {
      id: `cls.${rule.taskClass}.2`,
      source: `rule.${rule.id}`,
      detail: `Rule "${rule.id}" is the highest-priority satisfied rule; classified as ${rule.taskClass}`,
    },
  ]
}

/** Evidence contributed by a satisfied-but-not-winning rule. */
function holdingRuleEvidence(rule: ClassificationRule, input: ClassificationInput): EvidenceReference {
  return {
    id: `cls.${rule.taskClass}.1`,
    source: `rule.${rule.id}`,
    detail: rule.describe(input),
  }
}

/**
 * Deterministic confidence formula:
 *   30 base
 *   + 10 per satisfied rule whose taskClass === the winning class.
 *     The winning rule itself is counted (a satisfied rule always supports
 *     its own class); each class has exactly one rule in the table, so this
 *     contributes the required +10 baseline.
 *   + 10 when evidence.length >= MIN_CLASSIFICATION_EVIDENCE
 *   + 10 when ambiguityLevel is undefined or <= 20
 *   - 20 when ambiguityLevel is defined and >= 60
 * Clamped to SCORE_MIN..SCORE_MAX and rounded. When evidence is below the
 * minimum, confidence is capped at 49 (a low-evidence result can never be
 * confident).
 */
function computeConfidence(
  input: ClassificationInput,
  evidence: EvidenceReference[],
  supportingRules: number,
): number {
  let confidence = 30 + 10 * supportingRules
  if (evidence.length >= MIN_CLASSIFICATION_EVIDENCE) {
    confidence += 10
  }
  if (input.ambiguityLevel === undefined || input.ambiguityLevel <= 20) {
    confidence += 10
  }
  if (input.ambiguityLevel !== undefined && input.ambiguityLevel >= 60) {
    confidence -= 20
  }
  if (evidence.length < MIN_CLASSIFICATION_EVIDENCE) {
    confidence = Math.min(confidence, 49)
  }
  confidence = Math.round(confidence)
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, confidence))
}

/** Fallback-rule (17) evidence; unmapped fallback stays low-evidence. */
function fallbackEvidence(input: ClassificationInput, taskClass: TaskClass): EvidenceReference[] {
  const specialist = input.userRequiredSpecialist
  if (typeof specialist === "string" && specialist.length > 0) {
    return [
      {
        id: `cls.${taskClass}.1`,
        source: "rule.fallback",
        detail: `No priority rule matched; userRequiredSpecialist "${specialist}" maps to ${taskClass}`,
      },
      {
        id: `cls.${taskClass}.2`,
        source: "rule.fallback",
        detail: "Fallback rule 17 selected (no priority rule satisfied)",
      },
    ]
  }
  return [
    {
      id: "cls.unknown.1",
      source: "rule.fallback",
      detail: "No priority rule matched and no userRequiredSpecialist mapping; classified as unknown",
    },
  ]
}

/** Evidence for a read-only/mutating conflict, with a stable id and source. */
function conflictEvidence(winningClass: TaskClass, input: ClassificationInput): EvidenceReference {
  const detail =
    input.readOnly === true
      ? `readOnly=true conflicts with mutating class "${winningClass}"`
      : `mutating=true conflicts with read-only class "${winningClass}"`
  return {
    id: "classifier.conflict.read_only_mutating",
    source: "rule.conflict_detection",
    detail,
  }
}

/**
 * Applies the confidence-threshold downgrade: below the threshold the class
 * becomes "unknown" with confidence capped at 30.
 */
function finalize(taskClass: TaskClass, evidence: EvidenceReference[], confidence: number): ClassificationResult {
  const result: ClassificationResult = {
    taskClass,
    confidence,
    evidence,
    usedModelFallback: false,
    policyVersion: ROUTING_POLICY_VERSION,
  }
  if (confidence < DEFAULT_CLASSIFICATION_THRESHOLD) {
    return { ...result, taskClass: "unknown", confidence: Math.min(confidence, 30) }
  }
  return result
}

/**
 * Classifies `input` using the deterministic priority-ordered rule table.
 * Pure: no randomness, no Date, no model calls, no I/O.
 */
export function classifyTask(input: ClassificationInput): ClassificationResult {
  const satisfied = RULES.filter((rule) => rule.predicate(input))
  const winner = satisfied[0]

  // Rule 17: fallback when no priority rule matched.
  if (winner === undefined) {
    const specialist = input.userRequiredSpecialist
    const mappedClass =
      typeof specialist === "string" && specialist.length > 0
        ? (SPECIALIST_FALLBACK[specialist] ?? "cross_module_feature")
        : "unknown"
    const evidence = fallbackEvidence(input, mappedClass)
    // The fallback rule itself supports its own class (supportingRules = 1).
    const confidence = computeConfidence(input, evidence, 1)
    return finalize(mappedClass, evidence, confidence)
  }

  // Conflict detection: read-only/mutating contradictions never classify
  // confidently; they resolve to "unknown" with a fixed low confidence.
  const classIsMutating = MUTATING_CLASSES.includes(winner.taskClass)
  const classIsReadOnly = READ_ONLY_CLASSES.includes(winner.taskClass)
  if ((classIsMutating && input.readOnly === true) || (classIsReadOnly && input.mutating === true)) {
    return {
      taskClass: "unknown",
      confidence: 25,
      evidence: [conflictEvidence(winner.taskClass, input)],
      usedModelFallback: false,
      policyVersion: ROUTING_POLICY_VERSION,
    }
  }

  const evidence = [
    ...winnerEvidence(winner, input),
    ...satisfied.slice(1).map((rule) => holdingRuleEvidence(rule, input)),
  ]
  const supportingRules = satisfied.filter((rule) => rule.taskClass === winner.taskClass).length
  const confidence = computeConfidence(input, evidence, supportingRules)
  return finalize(winner.taskClass, evidence, confidence)
}

/**
 * True when `result` needs a model fallback: its class is "unknown" or its
 * confidence is below `threshold`. Pure boundary check — never performs a
 * model call.
 */
export function needsModelFallback(
  result: ClassificationResult,
  threshold: number = DEFAULT_CLASSIFICATION_THRESHOLD,
): boolean {
  return result.taskClass === "unknown" || result.confidence < threshold
}

/**
 * Maps `classifyTask` over multiple inputs. Deterministic and order-preserving;
 * used by repeated-run determinism checks.
 */
export function classifyWithConsistency(...inputs: ClassificationInput[]): ClassificationResult[] {
  return inputs.map((input) => classifyTask(input))
}
