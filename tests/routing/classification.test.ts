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

  it("maps userRequiredSpecialist to a class when no priority rule fires", () => {
    const cases: ReadonlyArray<{ specialist: string; expected: TaskClass }> = [
      { specialist: "security-auditor", expected: "security_review" },
      { specialist: "researcher", expected: "read_only_question" },
      { specialist: "devops", expected: "ci_failure" },
      { specialist: "tester", expected: "local_bug" },
      { specialist: "architect", expected: "cross_module_feature" },
      { specialist: "unknown-specialist", expected: "cross_module_feature" },
    ]
    for (const { specialist, expected } of cases) {
      expectConfidentResult(classifyTask({ userRequiredSpecialist: specialist }), expected)
    }
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
