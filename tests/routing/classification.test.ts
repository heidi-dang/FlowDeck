/**
 * Deterministic rule-based task classifier tests.
 *
 * Covers every canonical TaskClass with a fixture that deterministically
 * hits it, determinism/consistency guarantees, mutating/read-only conflict
 * detection, rule priority interactions, the confidence formula invariants,
 * model-fallback boundary checks, and zClassificationResult validation.
 */

import { describe, it, expect } from "bun:test"
import {
  classifyTask,
  classifyWithConsistency,
  needsModelFallback,
  DEFAULT_CLASSIFICATION_THRESHOLD,
  MIN_CLASSIFICATION_EVIDENCE,
  HIGH_RISK_CLASSES,
  MUTATING_CLASSES,
} from "@/orchestration/routing/classifier/classifier"
import {
  zClassificationResult,
  isValidTaskClass,
  ROUTING_POLICY_VERSION,
  type ClassificationInput,
  type ClassificationResult,
  type TaskClass,
} from "@/orchestration/routing/contracts"
import {
  CANONICAL_SPECIALIST_IDS,
  SPECIALIST_TASK_CLASS,
  normalizeSpecialistId,
  resolveSpecialistClass,
  specialistMappingComplete,
} from "@/orchestration/routing/classifier/specialist-registry"
import { getSubagentIds, getPrimaryAgentIds } from "@/services/canonical-registry"

/** One fixture per canonical class (except "unknown", covered separately). */
const CLASS_FIXTURES: ReadonlyArray<{ input: ClassificationInput; expected: TaskClass }> = [
  { input: { expectedFileCount: 1, hasTests: false, expectedDomainCount: 0 }, expected: "trivial_edit" },
  { input: { rawPrompt: "write documentation for the API", readOnly: true }, expected: "documentation" },
  { input: { readOnly: true, mutating: false }, expected: "read_only_question" },
  { input: { explicitAuditRequest: true, securitySensitive: false }, expected: "repository_audit" },
  { input: { hasTests: true, expectedFileCount: 1, ambiguityLevel: 10 }, expected: "local_bug" },
  { input: { expectedFileCount: 5, expectedDomainCount: 3, hasTests: true }, expected: "cross_module_feature" },
  { input: { ciContext: true }, expected: "ci_failure" },
  { input: { ciContext: true, buildOrPackageFailure: true }, expected: "build_package_failure" },
  { input: { ciContext: true, releaseImpact: true }, expected: "release_failure" },
  { input: { migrationInvolved: true }, expected: "database_migration" },
  { input: { concurrencyInvolved: true }, expected: "concurrency_failure" },
  { input: { securitySensitive: true }, expected: "security_review" },
  { input: { rawPrompt: "improve latency of the hot path" }, expected: "performance_work" },
  { input: { uiInvolved: true, expectedFileCount: 2 }, expected: "ui_feature" },
  { input: { productionImpact: 90 }, expected: "production_incident" },
  { input: { recoveryState: true }, expected: "recovery_resume" },
]

/** Asserts the shared contract of a confident, evidenced classification. */
function expectConfidentResult(result: ClassificationResult, expected: TaskClass): void {
  expect(result.taskClass).toBe(expected)
  expect(result.confidence).toBeGreaterThanOrEqual(DEFAULT_CLASSIFICATION_THRESHOLD)
  expect(result.evidence.length).toBeGreaterThanOrEqual(MIN_CLASSIFICATION_EVIDENCE)
  expect(result.usedModelFallback).toBe(false)
  expect(result.policyVersion).toBe(ROUTING_POLICY_VERSION)
  expect(isValidTaskClass(result.taskClass)).toBe(true)
  expect(zClassificationResult.safeParse(result).success).toBe(true)
}

describe("deterministic rule-based task classifier", () => {
  it("exports the documented constants", () => {
    expect(DEFAULT_CLASSIFICATION_THRESHOLD).toBe(60)
    expect(MIN_CLASSIFICATION_EVIDENCE).toBe(2)
    expect(HIGH_RISK_CLASSES).toEqual([
      "production_incident",
      "database_migration",
      "concurrency_failure",
      "security_review",
      "release_failure",
    ])
    expect(MUTATING_CLASSES).toEqual([
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
      "documentation",
    ])
  })

  for (const { input, expected } of CLASS_FIXTURES) {
    it(`classifies ${expected} deterministically with confident, evidenced results`, () => {
      expectConfidentResult(classifyTask(input), expected)
    })
  }

  it("classifies an empty input as unknown with low confidence", () => {
    const result = classifyTask({})
    expect(result.taskClass).toBe("unknown")
    expect(result.confidence).toBeLessThanOrEqual(30)
    expect(result.usedModelFallback).toBe(false)
    expect(isValidTaskClass(result.taskClass)).toBe(true)
    expect(zClassificationResult.safeParse(result).success).toBe(true)
  })

  it("is deterministic: identical input yields identical output across runs", () => {
    const fixture: ClassificationInput = { rawPrompt: "write documentation for the API", readOnly: true }
    const first = classifyTask(fixture)
    for (let i = 0; i < 5; i++) {
      expect(classifyTask(fixture)).toEqual(first)
    }
  })

  it("classifyWithConsistency returns identical results for identical inputs", () => {
    const fixture: ClassificationInput = { productionImpact: 90 }
    const results = classifyWithConsistency(fixture, fixture, fixture)
    expect(results.length).toBe(3)
    expect(results[0]).toEqual(results[1])
    expect(results[1]).toEqual(results[2])
  })

  it("returns unknown when readOnly and mutating conflict (never a confident class)", () => {
    const result = classifyTask({ readOnly: true, mutating: true })
    expect(result.taskClass).toBe("unknown")
    expect(result.confidence).toBeLessThanOrEqual(30)
    expect(zClassificationResult.safeParse(result).success).toBe(true)
  })

  it("detects the readOnly/mutating conflict before rules fire (D12)", () => {
    // Even with signals that would otherwise win (production_incident),
    // the readOnly && mutating conflict wins because it is detected first.
    const result = classifyTask({ readOnly: true, mutating: true, productionImpact: 90 })
    expect(result.taskClass).toBe("unknown")
    expect(result.confidence).toBe(25)
    expect(result.evidence.some((e) => e.id === "classifier.conflict.read_only_mutating")).toBe(true)
    expect(result.evidence.some((e) => e.source === "rule.conflict_detection")).toBe(true)
  })

  it("returns unknown with conflict evidence when a mutating class is selected despite readOnly=true", () => {
    const result = classifyTask({ readOnly: true, mutating: true, expectedFileCount: 1, hasTests: false })
    expect(result.taskClass).toBe("unknown")
    expect(result.confidence).toBe(25)
    expect(result.evidence.some((e) => e.id === "classifier.conflict.read_only_mutating")).toBe(true)
    expect(result.evidence.some((e) => e.source === "rule.conflict_detection")).toBe(true)
    expect(zClassificationResult.safeParse(result).success).toBe(true)
  })

  it("never classifies an explicit read-only task as trivial_edit", () => {
    const result = classifyTask({ readOnly: true, expectedFileCount: 1, hasTests: false })
    expect(["read_only_question", "unknown"]).toContain(result.taskClass)
    expect(result.taskClass).not.toBe("trivial_edit")
  })

  it("never misses a database migration even for a single-file edit", () => {
    const result = classifyTask({ migrationInvolved: true, expectedFileCount: 1, hasTests: false })
    expect(result.taskClass).toBe("database_migration")
    expectConfidentResult(result, "database_migration")
  })

  it("never misses a production incident even when a migration is also involved", () => {
    const result = classifyTask({ productionImpact: 90, migrationInvolved: true })
    expect(result.taskClass).toBe("production_incident")
    expectConfidentResult(result, "production_incident")
  })

  it("does not ignore high ambiguity: weak signals with ambiguityLevel 80 classify as unknown", () => {
    const result = classifyTask({ ambiguityLevel: 80, expectedFileCount: 1, hasTests: false })
    expect(result.taskClass).toBe("unknown")
    expect(result.confidence).toBeLessThanOrEqual(30)
    expect(zClassificationResult.safeParse(result).success).toBe(true)
  })

  it("needsModelFallback reports true for unknown results and false for confident ones", () => {
    const unknown = classifyTask({})
    expect(needsModelFallback(unknown)).toBe(true)
    const confident = classifyTask({ productionImpact: 90 })
    expect(needsModelFallback(confident)).toBe(false)
    expect(needsModelFallback(confident, DEFAULT_CLASSIFICATION_THRESHOLD + 1)).toBe(true)
  })

  it("security_review beats repository_audit when both signals are present", () => {
    const result = classifyTask({ securitySensitive: true, explicitAuditRequest: true })
    expect(result.taskClass).toBe("security_review")
    expectConfidentResult(result, "security_review")
  })

  it("production_incident beats ui_feature when both signals are present", () => {
    const result = classifyTask({ productionImpact: 90, uiInvolved: true, expectedFileCount: 2 })
    expect(result.taskClass).toBe("production_incident")
    expectConfidentResult(result, "production_incident")
  })

  it("database_migration beats ci_failure when both signals are present", () => {
    const result = classifyTask({ ciContext: true, migrationInvolved: true })
    expect(result.taskClass).toBe("database_migration")
    expectConfidentResult(result, "database_migration")
  })

  it("never returns confidence above 49 when evidence is below the minimum", () => {
    const candidates: ClassificationInput[] = [
      {},
      { readOnly: true, mutating: true, expectedFileCount: 1, hasTests: false },
      { ambiguityLevel: 80 },
    ]
    for (const input of candidates) {
      const result = classifyTask(input)
      if (result.evidence.length < MIN_CLASSIFICATION_EVIDENCE) {
        expect(result.confidence).toBeLessThanOrEqual(49)
      }
    }
    for (const { input } of CLASS_FIXTURES) {
      const result = classifyTask(input)
      if (result.evidence.length < MIN_CLASSIFICATION_EVIDENCE) {
        expect(result.confidence).toBeLessThanOrEqual(49)
      }
    }
  })

  it("maps a recognized userRequiredSpecialist to a class when no priority rule fires", () => {
    const cases: ReadonlyArray<{ specialist: string; expected: TaskClass }> = [
      { specialist: "security-auditor", expected: "security_review" },
      { specialist: "researcher", expected: "read_only_question" },
      { specialist: "devops", expected: "ci_failure" },
      { specialist: "tester", expected: "local_bug" },
      { specialist: "architect", expected: "cross_module_feature" },
    ]
    for (const { specialist, expected } of cases) {
      expectConfidentResult(classifyTask({ userRequiredSpecialist: specialist }), expected)
    }
  })

  it("normalizes a specialist id (trim, lowercase) before matching", () => {
    expectConfidentResult(classifyTask({ userRequiredSpecialist: "  Researcher " }), "read_only_question")
    expectConfidentResult(classifyTask({ userRequiredSpecialist: "SECURITY-AUDITOR" }), "security_review")
  })

  it("classifies an unrecognized specialist id as unknown with low confidence", () => {
    for (const specialist of ["unknown-specialist", "not-an-agent", "heidi"]) {
      const result = classifyTask({ userRequiredSpecialist: specialist })
      expect(result.taskClass).toBe("unknown")
      expect(result.confidence).toBeLessThanOrEqual(30)
      expect(result.evidence.some((e) => e.id === "cls.unknown.1")).toBe(true)
      expect(zClassificationResult.safeParse(result).success).toBe(true)
    }
  })

  it("derives specialist identities from the canonical registry (no manual duplicate)", () => {
    // The allow-list is the canonical registry's subagent set, not a copy.
    expect(CANONICAL_SPECIALIST_IDS).toEqual(getSubagentIds())
    expect([...CANONICAL_SPECIALIST_IDS].sort()).toEqual([...new Set(CANONICAL_SPECIALIST_IDS)].sort())
  })

  it("every canonical specialist maps to a deterministic task class (registry parity)", () => {
    expect(specialistMappingComplete()).toBe(true)
    for (const id of CANONICAL_SPECIALIST_IDS) {
      expect(SPECIALIST_TASK_CLASS[id], `specialist "${id}" must have a task-class mapping`).toBeDefined()
      const result = classifyTask({ userRequiredSpecialist: id })
      expect(result.taskClass).toBe(SPECIALIST_TASK_CLASS[id])
      expect(zClassificationResult.safeParse(result).success).toBe(true)
    }
  })

  it("orchestrator aliases (heidi/orchestrator) are primaries, not specialists", () => {
    // Neither primary id may be a specialist or map to a class.
    for (const primary of getPrimaryAgentIds()) {
      expect(CANONICAL_SPECIALIST_IDS).not.toContain(primary)
      expect(resolveSpecialistClass(normalizeSpecialistId(primary))).toBeUndefined()
    }
  })

  it("normalization is deterministic and idempotent", () => {
    for (const raw of ["  Researcher ", "RESEARCHER", " researcher ", "ReSeArChEr"]) {
      expect(normalizeSpecialistId(raw)).toBe("researcher")
    }
    expect(normalizeSpecialistId(normalizeSpecialistId("  SECURITY-AUDITOR  "))).toBe("security-auditor")
  })

  it("classifies a documentation prompt as documentation even when mutating (D11)", () => {
    const result = classifyTask({ rawPrompt: "Update the README with new endpoints", mutating: true })
    expect(result.taskClass).toBe("documentation")
    expectConfidentResult(result, "documentation")
  })

  it("classifies an explanatory question as read_only_question, not documentation (D11)", () => {
    const result = classifyTask({ rawPrompt: "Explain how routing works", readOnly: true })
    expect(result.taskClass).toBe("read_only_question")
    expectConfidentResult(result, "read_only_question")
  })

  it("classifies documentation terms as documentation (positive table)", () => {
    const positivePrompts: string[] = [
      "write documentation for the API",
      "update the README",
      "add docs for the CLI",
      "create a user guide",
      "write a developer guide",
      "review the doc comments",
    ]
    for (const prompt of positivePrompts) {
      expect(classifyTask({ rawPrompt: prompt }).taskClass, `"${prompt}"`).toBe("documentation")
    }
  })

  it("does not classify documentation look-alike terms as documentation (negative table)", () => {
    const negativePrompts: string[] = [
      "fix the doctor service crash",
      "build a Docker image for the service",
      "dock the window to the side",
      "query the document database",
      "guided execution of the pipeline",
      "convert the document to PDF",
    ]
    for (const prompt of negativePrompts) {
      const result = classifyTask({ rawPrompt: prompt })
      expect(result.taskClass, `"${prompt}" must not classify as documentation`).not.toBe("documentation")
    }
  })

  it("keeps documentation read-only inspection distinguishable from a documentation mutation", () => {
    // A mutating documentation edit classifies as documentation.
    const mutation = classifyTask({ rawPrompt: "update the README with new endpoints", mutating: true })
    expect(mutation.taskClass).toBe("documentation")

    // A read-only documentation inspection classifies as documentation too,
    // but the readOnly flag is preserved for downstream mutation inference.
    const inspection = classifyTask({ rawPrompt: "review the README for accuracy", readOnly: true })
    expect(inspection.taskClass).toBe("documentation")

    // The canonical MUTATING_CLASSES set includes documentation, so a
    // documentation class alone no longer implies a non-mutating task.
    expect(MUTATING_CLASSES).toContain("documentation")
  })

  it("every produced result validates against zClassificationResult", () => {
    const inputs: ClassificationInput[] = [
      {},
      { readOnly: true, mutating: true, expectedFileCount: 1, hasTests: false },
      { ambiguityLevel: 80, expectedFileCount: 1 },
      { userRequiredSpecialist: "researcher" },
      ...CLASS_FIXTURES.map((fixture) => fixture.input),
    ]
    for (const input of inputs) {
      const result = classifyTask(input)
      expect(zClassificationResult.safeParse(result).success).toBe(true)
    }
  })
})
