/**
 * Contract-parity and safety adversarial coverage.
 *
 * Parity: asserts the executable contracts match the doc-vocabulary fixture
 * (contract-alignment.fixture.ts) — task classes, execution strategies,
 * model tiers, latency classes, delegation reasons, HIGH_RISK_FLOOR, and the
 * requiredReviewers type.
 *
 * Adversarial suites: exercises the cross-field invariants of the contracts
 * (self-delegation, model floor/fallback ordering, specialist result
 * evidence, strategy high-risk posture, empty/whitespace ids, exact-SHA,
 * ISO timestamp) so a violation anywhere in the routing layer is caught at
 * the contract boundary.
 */

import { describe, it, expect } from "bun:test"
import {
  TASK_CLASSES,
  EXECUTION_STRATEGIES,
  zDelegationReason,
  zRejectedDelegationReason,
  zLatencyClass,
  MODEL_TIERS,
  zStrategyPolicy,
  DEFAULT_STRATEGY_POLICIES,
  getStrategyPolicy,
  isHighRiskCompatible,
  HIGH_RISK_APPROVAL_REQUIREMENT,
  zDelegationDecision,
  zSpecialistResult,
  zModelSelectionDecision,
  zModelRoutingInput,
  zRoutingDecisionRecord,
  zTaskClass,
  zExecutionStrategy,
  zModelTier,
  zScoredTask,
  canonicalJson,
  canonicalClone,
  bindDecisionToSha,
  ROUTING_POLICY_VERSION,
  ROUTING_WEIGHTS_VERSION,
  zClassificationInput,
  HIGH_RISK_CAPABILITY_FLOOR,
  capabilitiesAreRecognized,
  type RoutingDecisionRecord,
} from "@/orchestration/routing/contracts"
import { HIGH_RISK_FLOOR, DEFAULT_WEIGHTS, computeTaskScores } from "@/orchestration/routing/scoring/scorers"
import {
  FIXTURE_TASK_CLASSES,
  FIXTURE_EXECUTION_STRATEGIES,
  FIXTURE_MODEL_TIERS,
  FIXTURE_LATENCY_CLASSES,
  FIXTURE_DELEGATION_REASONS,
  FIXTURE_REJECTED_DELEGATION_REASONS,
  FIXTURE_HIGH_RISK_FLOOR,
  FIXTURE_REQUIRED_REVIEWERS_TYPE,
  FIXTURE_RISK_SIGNALS,
  FIXTURE_HIGH_RISK_POSTURE,
} from "./fixtures/contract-alignment.fixture"

const VALID_SHA = "0123456789abcdef0123456789abcdef01234567"

function makeValidRecord(): RoutingDecisionRecord {
  return bindDecisionToSha({
    taskId: "task-parity-1",
    decisionId: "dec-parity-1",
    repositorySha: VALID_SHA,
    weightsVersion: ROUTING_WEIGHTS_VERSION,
    inputEvidence: [{ signal: "expectedFileCount", value: 2, source: "prompt" }],
    rulesApplied: ["rule:classify"],
    modelFallbackUsed: false,
    classification: {
      taskClass: "local_bug",
      confidence: 92,
      evidence: [{ id: "e1", source: "classifier", detail: "stack trace found" }],
      usedModelFallback: false,
      policyVersion: "1.0.0",
    },
    scores: {
      scores: { complexity: 40, ambiguity: 30, risk: 25, confidence: 80 },
      evidence: {
        complexity: [{ id: "e-cx", source: "scoring.complexity", detail: "file count" }],
        ambiguity: [{ id: "e-amb", source: "scoring.ambiguity", detail: "missing target" }],
        risk: [{ id: "e-risk", source: "scoring.risk", detail: "production impact" }],
        confidence: [{ id: "e-conf", source: "scoring.confidence", detail: "ambiguity" }],
      },
      weightsVersion: ROUTING_WEIGHTS_VERSION,
      policyVersion: ROUTING_POLICY_VERSION,
    },
    selectedStrategy: "root_cause_repair",
    rejectedStrategies: [{ strategy: "audit_only", reason: "task is mutating" }],
    specialistCandidates: ["debug-specialist"],
    delegationDecisions: [
      {
        taskId: "task-parity-1",
        delegatingAgent: "orchestrator",
        targetAgent: "debug-specialist",
        depth: 1,
        allowed: true,
        reason: "specialist_expertise",
        justification: ["stack trace present"],
      },
    ],
    modelCandidates: [{ tier: "strong_reasoning", reason: "debugging" }],
    selectedTier: "strong_reasoning",
    fallback: ["general_coding", "small_fast"],
    confidence: 90,
  })
}

describe("contract parity: doc vocabulary vs executable contracts", () => {
  it("TASK_CLASSES matches the documented 17-value taxonomy", () => {
    expect(TASK_CLASSES).toEqual([...FIXTURE_TASK_CLASSES])
    expect(TASK_CLASSES).toHaveLength(17)
    for (const cls of FIXTURE_TASK_CLASSES) {
      expect(zTaskClass.safeParse(cls).success).toBe(true)
    }
  })

  it("EXECUTION_STRATEGIES matches the documented 9-value vocabulary", () => {
    expect(EXECUTION_STRATEGIES).toEqual([...FIXTURE_EXECUTION_STRATEGIES])
    expect(EXECUTION_STRATEGIES).toHaveLength(9)
    for (const strategy of FIXTURE_EXECUTION_STRATEGIES) {
      expect(zExecutionStrategy.safeParse(strategy).success).toBe(true)
    }
  })

  it("MODEL_TIERS matches the documented ordered tiers", () => {
    expect(MODEL_TIERS).toEqual([...FIXTURE_MODEL_TIERS])
    for (const tier of FIXTURE_MODEL_TIERS) {
      expect(zModelTier.safeParse(tier).success).toBe(true)
    }
  })

  it("latency classes match the documented 3 buckets", () => {
    for (const latency of FIXTURE_LATENCY_CLASSES) {
      expect(zLatencyClass.safeParse(latency).success).toBe(true)
    }
    expect(zLatencyClass.safeParse("instantx").success).toBe(false)
  })

  it("delegation reason vocabularies match the documented split", () => {
    expect(zDelegationReason.options).toEqual([...FIXTURE_DELEGATION_REASONS])
    expect(zRejectedDelegationReason.options).toEqual([...FIXTURE_REJECTED_DELEGATION_REASONS])
  })

  it("HIGH_RISK_FLOOR is the documented universal 70", () => {
    expect(HIGH_RISK_FLOOR).toBe(FIXTURE_HIGH_RISK_FLOOR)
    expect(HIGH_RISK_FLOOR).toBe(70)
  })

  it("StrategyPolicy.requiredReviewers is a number (count), per the doc", () => {
    expect(FIXTURE_REQUIRED_REVIEWERS_TYPE).toBe("number")
    for (const strategy of EXECUTION_STRATEGIES) {
      expect(typeof DEFAULT_STRATEGY_POLICIES[strategy].requiredReviewers).toBe("number")
    }
  })

  it("every canonical risk signal is representable in ClassificationInput and zClassificationInput", () => {
    for (const signal of FIXTURE_RISK_SIGNALS) {
      // The interface field exists and the zod schema accepts it.
      const input: Record<string, unknown> = { [signal]: signal === "productionImpact" ? 80 : true }
      expect(zClassificationInput.safeParse(input).success, `${signal} must be accepted by zClassificationInput`).toBe(true)
    }
  })

  it("every canonical risk signal has an executable ScoreWeights.risk weight", () => {
    const weightKeys: Record<string, keyof typeof DEFAULT_WEIGHTS.risk> = {
      productionImpact: "productionWeight",
      releaseImpact: "releaseWeight",
      dataIntegrityInvolved: "dataIntegrityWeight",
      securitySensitive: "securityWeight",
      destructiveOperations: "destructiveWeight",
      migrationInvolved: "migrationWeight",
      concurrencyInvolved: "concurrencyWeight",
      authInvolved: "authWeight",
      packagePublication: "packagePublicationWeight",
      infrastructureChange: "infrastructureWeight",
      rollbackDifficulty: "rollbackDifficultyWeight",
      uncertainExternalSideEffects: "externalSideEffectsWeight",
    }
    for (const signal of FIXTURE_RISK_SIGNALS) {
      const weight = DEFAULT_WEIGHTS.risk[weightKeys[signal]]
      expect(typeof weight, `${signal} must have a numeric risk weight`).toBe("number")
      expect(weight).toBeGreaterThan(0)
    }
  })

  it("every canonical risk signal floors risk to the documented 70 via computeTaskScores", () => {
    for (const signal of FIXTURE_RISK_SIGNALS) {
      const input: Record<string, unknown> = signal === "productionImpact" ? { productionImpact: 70 } : { [signal]: true }
      const scored = computeTaskScores(input as never)
      expect(scored.scores.risk, `${signal} must floor risk to >= ${FIXTURE_HIGH_RISK_POSTURE.minRisk}`).toBeGreaterThanOrEqual(
        FIXTURE_HIGH_RISK_POSTURE.minRisk,
      )
      expect(zScoredTask.safeParse(scored).success).toBe(true)
    }
  })

  it("the canonical high-risk posture matches the executable contract", () => {
    expect(FIXTURE_HIGH_RISK_FLOOR).toBe(FIXTURE_HIGH_RISK_POSTURE.minRisk)
    expect(HIGH_RISK_FLOOR).toBe(FIXTURE_HIGH_RISK_POSTURE.minRisk)
    expect(HIGH_RISK_APPROVAL_REQUIREMENT).toBe(FIXTURE_HIGH_RISK_POSTURE.approvalRequirement)
    // The high-risk capability floor must require strong_reasoning for every member.
    for (const capability of HIGH_RISK_CAPABILITY_FLOOR) {
      expect(capabilitiesAreRecognized([capability])).toBe(true)
    }
    // Every high-risk-capable default satisfies the full posture.
    for (const strategy of [
      "planned_execution",
      "parallel_implementation",
      "root_cause_repair",
      "audit_only",
      "repair_and_independent_audit",
      "recovery_resume",
    ] as const) {
      const policy = DEFAULT_STRATEGY_POLICIES[strategy]
      expect(policy.modelTier).toBe(FIXTURE_HIGH_RISK_POSTURE.modelTierFloor)
      expect(isHighRiskCompatible(policy)).toBe(true)
    }
  })
})

describe("adversarial: delegation self-reference and depth (D7)", () => {
  it("rejects self-delegation", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "t",
      delegatingAgent: "orchestrator",
      targetAgent: "orchestrator",
      depth: 0,
      allowed: true,
      reason: "specialist_expertise",
      justification: [],
    })
    expect(result.success).toBe(false)
  })

  it("rejects an allowed decision that carries both reason and rejectionReason", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "t",
      delegatingAgent: "orchestrator",
      targetAgent: "backend-coder",
      depth: 1,
      allowed: true,
      reason: "specialist_expertise",
      rejectionReason: "rejected_cost",
      justification: [],
    })
    expect(result.success).toBe(false)
  })

  it("rejects depth values outside 0..1", () => {
    for (const depth of [-1, 2]) {
      const result = zDelegationDecision.safeParse({
        taskId: "t",
        delegatingAgent: "orchestrator",
        targetAgent: "backend-coder",
        depth,
        allowed: true,
        reason: "specialist_expertise",
        justification: [],
      })
      expect(result.success).toBe(false)
    }
  })
})

describe("adversarial: model floor and fallback ordering (D8/D9)", () => {
  it("rejects a selected tier below the capability floor", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "small_fast",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: [],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: ["security audit"],
    })
    expect(result.success).toBe(false)
  })

  it("rejects duplicated fallback tiers", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "strong_reasoning",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: ["general_coding", "general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: [],
    })
    expect(result.success).toBe(false)
  })

  it("rejects fallback tiers not strictly ordered strongest-first", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "strong_reasoning",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: ["small_fast", "general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: [],
    })
    expect(result.success).toBe(false)
  })

  it("rejects a fallback tier below the capability floor", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "strong_reasoning",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: ["small_fast"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: ["security audit"],
    })
    expect(result.success).toBe(false)
  })

  it("accepts a valid decision whose tier and fallbacks meet the floor", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "strong_reasoning",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding"],
      timeoutPolicy: { queueMs: 500, firstTokenMs: 10000, totalMs: 120000 },
      capabilityFloor: ["GitHub inspection"],
    })
    expect(result.success).toBe(true)
  })

  it("ModelRoutingInput rejects an unknown capability in the floor", () => {
    const result = zModelRoutingInput.safeParse({
      taskId: "t",
      taskClass: "ui_feature",
      scores: { complexity: 50, ambiguity: 30, risk: 20, confidence: 80 },
      capabilityFloor: ["not_a_capability"],
      strategy: "parallel_implementation",
      timeoutPolicy: { queueMs: 500, firstTokenMs: 10000, totalMs: 120000 },
    })
    expect(result.success).toBe(false)
  })
})

describe("adversarial: specialist result evidence (D15)", () => {
  const base = {
    status: "completed",
    summary: "fixed",
    findings: [],
    changes: [],
    evidence: [],
    assumptions: [],
    unresolvedRisks: [],
    confidence: 90,
    recommendedNextAction: "verify",
    ownershipUsed: [],
  }

  it("rejects a completed result with no summary and no evidence", () => {
    expect(zSpecialistResult.safeParse({ ...base, status: "completed", summary: "", evidence: [] }).success).toBe(false)
  })

  it("rejects a completed result with a summary but no evidence", () => {
    expect(zSpecialistResult.safeParse({ ...base, status: "completed", summary: "fixed", evidence: [] }).success).toBe(false)
  })

  it("accepts a completed result with summary and evidence", () => {
    expect(
      zSpecialistResult.safeParse({ ...base, status: "completed", evidence: [{ id: "e1", kind: "test", detail: "passes" }] }).success,
    ).toBe(true)
  })

  it("accepts a failed result with an explicit terminal reason but no evidence", () => {
    expect(
      zSpecialistResult.safeParse({
        ...base,
        status: "failed",
        summary: "blocked on creds",
        terminalReason: "credentials unavailable in vault",
        evidence: [],
      }).success,
    ).toBe(true)
  })

  it("rejects a failed result with a status-only terminal reason", () => {
    expect(
      zSpecialistResult.safeParse({
        ...base,
        status: "failed",
        summary: "blocked on creds",
        terminalReason: "failed",
        evidence: [],
      }).success,
    ).toBe(false)
  })

  it("rejects a failed result with neither summary nor evidence nor terminal reason", () => {
    expect(zSpecialistResult.safeParse({ ...base, status: "failed", summary: "", evidence: [] }).success).toBe(false)
  })
})

describe("adversarial: strategy high-risk posture (D14)", () => {
  it("high-risk-capable defaults are isHighRiskCompatible", () => {
    for (const strategy of [
      "planned_execution",
      "parallel_implementation",
      "root_cause_repair",
      "audit_only",
      "repair_and_independent_audit",
      "recovery_resume",
    ] as const) {
      expect(isHighRiskCompatible(DEFAULT_STRATEGY_POLICIES[strategy])).toBe(true)
    }
  })

  it("direct strategies are not high-risk compatible", () => {
    expect(isHighRiskCompatible(DEFAULT_STRATEGY_POLICIES.fast_direct)).toBe(false)
    expect(isHighRiskCompatible(DEFAULT_STRATEGY_POLICIES.direct_verified)).toBe(false)
    expect(isHighRiskCompatible(DEFAULT_STRATEGY_POLICIES.explore_then_execute)).toBe(false)
  })

  it("rejects a high-risk policy missing the review state", () => {
    const base = getStrategyPolicy("planned_execution")
    expect(isHighRiskCompatible({ ...base, allowedStates: ["task", "execute", "verify"] })).toBe(false)
  })

  it("rejects a high-risk policy with zero required reviewers", () => {
    const base = getStrategyPolicy("planned_execution")
    expect(isHighRiskCompatible({ ...base, requiredReviewers: 0 })).toBe(false)
  })

  it("rejects a high-risk policy with focused verification", () => {
    const base = getStrategyPolicy("planned_execution")
    expect(isHighRiskCompatible({ ...base, verificationLevel: "focused" })).toBe(false)
    expect(isHighRiskCompatible({ ...base, verificationLevel: "standard" })).toBe(false)
  })

  it("rejects a high-risk policy whose approval is not the canonical requirement", () => {
    const base = getStrategyPolicy("planned_execution")
    // An arbitrary non-empty approval string is not the canonical requirement.
    expect(isHighRiskCompatible({ ...base, approvalRequirements: ["someone-approves"] })).toBe(false)
    expect(isHighRiskCompatible({ ...base, approvalRequirements: [] })).toBe(false)
  })

  it("rejects a high-risk policy with a weak model tier", () => {
    const base = getStrategyPolicy("planned_execution")
    expect(isHighRiskCompatible({ ...base, modelTier: "small_fast" })).toBe(false)
    expect(isHighRiskCompatible({ ...base, modelTier: "general_coding" })).toBe(false)
  })

  it("rejects a high-risk policy with an unknown required capability", () => {
    const base = getStrategyPolicy("planned_execution")
    expect(isHighRiskCompatible({ ...base, requiredCapabilities: ["not_a_real_capability"] })).toBe(false)
  })

  it("accepts a fully compliant high-risk strategy", () => {
    const base = getStrategyPolicy("planned_execution")
    expect(isHighRiskCompatible(base)).toBe(true)
    expect(isHighRiskCompatible(getStrategyPolicy("root_cause_repair"))).toBe(true)
  })

  it("every high-risk-capable strategy carries the approval requirement", () => {
    for (const strategy of [
      "planned_execution",
      "parallel_implementation",
      "root_cause_repair",
      "audit_only",
      "repair_and_independent_audit",
      "recovery_resume",
    ] as const) {
      expect(DEFAULT_STRATEGY_POLICIES[strategy].approvalRequirements).toContain(HIGH_RISK_APPROVAL_REQUIREMENT)
    }
  })

  it("high-risk-capable strategies allow the review stage", () => {
    for (const strategy of [
      "planned_execution",
      "parallel_implementation",
      "root_cause_repair",
      "audit_only",
      "repair_and_independent_audit",
      "recovery_resume",
    ] as const) {
      expect(DEFAULT_STRATEGY_POLICIES[strategy].allowedStates).toContain("review")
    }
  })

  it("every default policy still validates via zStrategyPolicy", () => {
    for (const strategy of EXECUTION_STRATEGIES) {
      expect(zStrategyPolicy.safeParse(DEFAULT_STRATEGY_POLICIES[strategy]).success).toBe(true)
      expect(zStrategyPolicy.safeParse(getStrategyPolicy(strategy)).success).toBe(true)
    }
  })
})

describe("adversarial: empty and whitespace ids (D16)", () => {
  it("rejects empty and whitespace-only identifiers in the record", () => {
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), taskId: "" }).success).toBe(false)
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), taskId: "   " }).success).toBe(false)
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), decisionId: "" }).success).toBe(false)
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), supersedes: "  " }).success).toBe(false)
  })
})

describe("adversarial: exact-SHA and ISO timestamp provenance", () => {
  it("rejects a short or malformed repositorySha", () => {
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), repositorySha: "abc123" }).success).toBe(false)
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), repositorySha: "G".repeat(40) }).success).toBe(false)
  })

  it("accepts an exact 40-hex repositorySha", () => {
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), repositorySha: VALID_SHA }).success).toBe(true)
  })

  it("requires an ISO-8601 timestamp", () => {
    const record = makeValidRecord()
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(zRoutingDecisionRecord.safeParse({ ...record, timestamp: "not-a-date" }).success).toBe(false)
  })

  it("records are immutable after bindDecisionToSha (clone-freeze)", () => {
    const record = makeValidRecord()
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.scores)).toBe(true)
    expect(Object.isFrozen(record.delegationDecisions)).toBe(true)
    expect(Object.isFrozen(record.inputEvidence)).toBe(true)
    // canonical serialization still works on a frozen record
    expect(canonicalJson(record)).toContain('"decisionId":"dec-parity-1"')
  })

  it("scored-task records carry version provenance", () => {
    const record = makeValidRecord()
    expect(zScoredTask.safeParse(record.scores).success).toBe(true)
    expect(record.scores.weightsVersion).toBe(ROUTING_WEIGHTS_VERSION)
    expect(record.scores.policyVersion).toBe(ROUTING_POLICY_VERSION)
  })
})

describe("adversarial: clone-safe decision binding (provenance)", () => {
  /** Builds an options object whose arrays/objects we can probe after binding. */
  function makeProbeableOptions() {
    const inputEvidence = [{ signal: "expectedFileCount", value: 2, source: "prompt" }]
    const delegationDecisions = [
      {
        taskId: "task-probe-1",
        delegatingAgent: "orchestrator",
        targetAgent: "debug-specialist",
        depth: 1,
        allowed: true,
        reason: "specialist_expertise" as const,
        justification: ["stack trace present"],
      },
    ]
    const classification = {
      taskClass: "local_bug" as const,
      confidence: 92,
      evidence: [{ id: "e1", source: "classifier", detail: "stack trace found" }],
      usedModelFallback: false,
      policyVersion: "1.0.0",
    }
    const scores = {
      scores: { complexity: 40, ambiguity: 30, risk: 25, confidence: 80 },
      evidence: {
        complexity: [{ id: "e-cx", source: "scoring.complexity", detail: "file count" }],
        ambiguity: [{ id: "e-amb", source: "scoring.ambiguity", detail: "missing target" }],
        risk: [{ id: "e-risk", source: "scoring.risk", detail: "production impact" }],
        confidence: [{ id: "e-conf", source: "scoring.confidence", detail: "ambiguity" }],
      },
      weightsVersion: ROUTING_WEIGHTS_VERSION,
      policyVersion: ROUTING_POLICY_VERSION,
    }
    const options = {
      taskId: "task-probe-1",
      decisionId: "dec-probe-1",
      repositorySha: VALID_SHA,
      weightsVersion: ROUTING_WEIGHTS_VERSION,
      inputEvidence,
      rulesApplied: ["rule:classify"],
      modelFallbackUsed: false,
      classification,
      scores,
      selectedStrategy: "root_cause_repair" as const,
      rejectedStrategies: [{ strategy: "audit_only" as const, reason: "task is mutating" }],
      specialistCandidates: ["debug-specialist"],
      delegationDecisions,
      modelCandidates: [{ tier: "strong_reasoning" as const, reason: "debugging" }],
      selectedTier: "strong_reasoning" as const,
      fallback: ["general_coding" as const, "small_fast" as const],
      confidence: 90,
    }
    return { options, inputEvidence, delegationDecisions, classification, scores }
  }

  it("leaves caller-owned arrays and objects mutable after binding", () => {
    const { options, inputEvidence, delegationDecisions } = makeProbeableOptions()
    const record = bindDecisionToSha(options)

    expect(Object.isFrozen(inputEvidence)).toBe(false)
    expect(Object.isFrozen(delegationDecisions)).toBe(false)
    expect(Object.isFrozen(delegationDecisions[0].justification)).toBe(false)
    expect(Object.isFrozen(options.rejectedStrategies)).toBe(false)
    expect(Object.isFrozen(options.specialistCandidates)).toBe(false)

    // Caller can still mutate its arrays after binding.
    inputEvidence.push({ signal: "extra", value: 1, source: "probe" })
    delegationDecisions[0].justification.push("after-bind mutation")
    expect(inputEvidence).toHaveLength(2)
    expect(delegationDecisions[0].justification).toHaveLength(2)

    // The bound record is unaffected by later caller mutation.
    expect(record.inputEvidence).toHaveLength(1)
    expect(record.delegationDecisions[0].justification).toHaveLength(1)
  })

  it("returns a record sharing no nested object identity with the input", () => {
    const { options, inputEvidence, delegationDecisions } = makeProbeableOptions()
    const record = bindDecisionToSha(options)

    expect(record.inputEvidence).not.toBe(inputEvidence)
    expect(record.inputEvidence[0]).not.toBe(inputEvidence[0])
    expect(record.delegationDecisions).not.toBe(delegationDecisions)
    expect(record.delegationDecisions[0]).not.toBe(delegationDecisions[0])
    expect(record.scores).not.toBe(options.scores)
    expect(record.scores.scores).not.toBe(options.scores.scores)
  })

  it("returns a deeply frozen record", () => {
    const { options } = makeProbeableOptions()
    const record = bindDecisionToSha(options)

    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.inputEvidence)).toBe(true)
    expect(Object.isFrozen(record.inputEvidence[0])).toBe(true)
    expect(Object.isFrozen(record.delegationDecisions)).toBe(true)
    expect(Object.isFrozen(record.delegationDecisions[0])).toBe(true)
    expect(Object.isFrozen(record.scores)).toBe(true)
    expect(Object.isFrozen(record.scores.evidence)).toBe(true)
    expect(Object.isFrozen(record.classification)).toBe(true)
    expect(Object.isFrozen(record.rejectedStrategies)).toBe(true)
  })

  it("throws on an invalid repository SHA", () => {
    const { options } = makeProbeableOptions()
    expect(() => bindDecisionToSha({ ...options, repositorySha: "abc123" })).toThrow(/repositorySha/)
    expect(() => bindDecisionToSha({ ...options, repositorySha: "G".repeat(40) })).toThrow(/repositorySha/)
  })

  it("throws on an invalid timestamp", () => {
    const { options } = makeProbeableOptions()
    expect(() => bindDecisionToSha({ ...options, timestamp: "not-a-date" })).toThrow(/timestamp/)
    expect(() => bindDecisionToSha({ ...options, timestamp: "2026-13-99T99:99:99.000Z" })).toThrow(/timestamp/)
  })

  it("throws on malformed version identifiers", () => {
    const { options } = makeProbeableOptions()
    expect(() => bindDecisionToSha({ ...options, weightsVersion: "" })).toThrow(/weightsVersion/)
    expect(() => bindDecisionToSha({ ...options, weightsVersion: "   " })).toThrow(/weightsVersion/)
    expect(() => bindDecisionToSha({ ...options, weightsVersion: "v1.0" })).toThrow(/weightsVersion/)
  })

  it("throws on invalid nested score data", () => {
    const { options } = makeProbeableOptions()
    const badScores = {
      ...options.scores,
      scores: { complexity: 150, ambiguity: 30, risk: 25, confidence: 80 },
    }
    expect(() => bindDecisionToSha({ ...options, scores: badScores })).toThrow(/scores/)
  })

  it("throws on invalid nested classification data", () => {
    const { options } = makeProbeableOptions()
    const badClassification = { ...options.classification, taskClass: "not_a_class" as never }
    expect(() => bindDecisionToSha({ ...options, classification: badClassification })).toThrow(/classification/)
  })

  it("throws on invalid nested delegation data", () => {
    const { options } = makeProbeableOptions()
    const badDelegation = [{ ...options.delegationDecisions[0], depth: 5 }]
    expect(() => bindDecisionToSha({ ...options, delegationDecisions: badDelegation })).toThrow(/delegationDecisions/)
  })

  it("throws when the input carries an unsupported value type", () => {
    const { options } = makeProbeableOptions()
    const badInputEvidence = [{ signal: "map", value: new Map([["a", 1]]), source: "probe" }]
    expect(() => bindDecisionToSha({ ...options, inputEvidence: badInputEvidence })).toThrow(/non-serializable value/)
  })

  it("a supersede record remains immutable and references the prior decisionId", () => {
    const { options } = makeProbeableOptions()
    const prior = bindDecisionToSha(options)
    const correction = bindDecisionToSha({ ...options, decisionId: "dec-probe-2", supersedes: "dec-probe-1" })

    expect(correction.supersedes).toBe("dec-probe-1")
    expect(Object.isFrozen(correction)).toBe(true)
    // The prior record is untouched by the correction.
    expect(prior.supersedes).toBeUndefined()
    expect(prior.decisionId).toBe("dec-probe-1")
  })
})

describe("adversarial: canonical clone isolation", () => {
  it("canonicalClone returns an independent deep copy", () => {
    const original = { a: [1, 2], b: { c: "x" } }
    const clone = canonicalClone(original)
    expect(clone).toEqual(original)
    expect(clone).not.toBe(original)
    expect(clone.a).not.toBe(original.a)
    expect(clone.b).not.toBe(original.b)

    clone.a.push(3)
    expect(original.a).toHaveLength(2)
  })

  it("canonicalClone sorts keys and drops undefined", () => {
    const clone = canonicalClone({ z: 1, a: undefined, m: { d: 1, b: 2 } })
    expect(Object.keys(clone)).toEqual(["m", "z"])
    expect(Object.keys((clone as { m: object }).m)).toEqual(["b", "d"])
  })

  it("canonicalClone rejects unsupported types", () => {
    expect(() => canonicalClone(new Map())).toThrow(/non-serializable value/)
    expect(() => canonicalClone(new Set())).toThrow(/non-serializable value/)
    expect(() => canonicalClone(/regex/)).toThrow(/non-serializable value/)
    expect(() => canonicalClone(Promise.resolve(1))).toThrow(/non-serializable value/)
    expect(() => canonicalClone(Symbol("x"))).toThrow(/non-serializable value/)
    expect(() => canonicalClone(1n)).toThrow(/non-serializable value/)
    expect(() => canonicalClone(() => 1)).toThrow(/non-serializable value/)
    expect(() => canonicalClone(NaN)).toThrow(/non-serializable value/)
    expect(() => canonicalClone(Infinity)).toThrow(/non-serializable value/)
  })

  it("canonicalClone rejects cyclic graphs", () => {
    const x: Record<string, unknown> = {}
    x.self = x
    expect(() => canonicalClone(x)).toThrow(/non-serializable value/)
  })

  it("canonicalClone converts Dates to ISO strings", () => {
    const d = new Date("2026-01-01T00:00:00.000Z")
    expect(canonicalClone({ d } as { d: unknown })).toEqual({ d: "2026-01-01T00:00:00.000Z" })
  })
})
