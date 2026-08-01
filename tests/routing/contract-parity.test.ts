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
  bindDecisionToSha,
  ROUTING_POLICY_VERSION,
  ROUTING_WEIGHTS_VERSION,
  type RoutingDecisionRecord,
} from "@/orchestration/routing/contracts"
import { HIGH_RISK_FLOOR } from "@/orchestration/routing/scoring/scorers"
import {
  FIXTURE_TASK_CLASSES,
  FIXTURE_EXECUTION_STRATEGIES,
  FIXTURE_MODEL_TIERS,
  FIXTURE_LATENCY_CLASSES,
  FIXTURE_DELEGATION_REASONS,
  FIXTURE_REJECTED_DELEGATION_REASONS,
  FIXTURE_HIGH_RISK_FLOOR,
  FIXTURE_REQUIRED_REVIEWERS_TYPE,
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
      evidence: { complexity: [], ambiguity: [], risk: [], confidence: [] },
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

  it("accepts a failed result with a reason summary but no evidence", () => {
    expect(zSpecialistResult.safeParse({ ...base, status: "failed", summary: "blocked on creds", evidence: [] }).success).toBe(true)
  })

  it("rejects a failed result with neither summary nor evidence", () => {
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
