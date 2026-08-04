/**
 * Absolute contract closure — adversarial coverage for PR 1.
 *
 * Proves the executable routing contracts satisfy the closure guarantees:
 *
 *  1. every exported policy table is deeply immutable (runtime, not just
 *     TypeScript readonly) and any policy change requires an explicit
 *     version bump (version-policy parity fixtures);
 *  2. agent aliases are canonicalized before delegation authorization
 *     (heidi/orchestrator are the same principal; only primary →
 *     canonical-subagent delegation may pass);
 *  3. routing decision records enforce complete cross-field invariants;
 *  4. canonical JSON rejects undefined array entries and sparse arrays so
 *     two semantically different accepted values never serialize identically;
 *  5. evidence is meaningful, trimmed, and unique;
 *  6. model timeout/fallback contracts are deterministic (degradation-only);
 *  7. specialist results are hardened (paths, reasons, ids, evidence);
 *  8. strategy policies are validated in full, including at module load;
 *  9. specialist mapping parity is two-way (canonical subagents === keys).
 */

import { describe, it, expect } from "bun:test"
import {
  // immutability
  deepFreeze,
  cloneFrozen,
  // canonical
  canonicalJson,
  canonicalClone,
  parseCanonicalJson,
  // task
  zNonEmptyId,
  zEvidenceReference,
  zRoutingInputEvidence,
  zClassificationResult,
  zScoredTask,
  zTaskClass,
  TASK_CLASSES,
  // models
  MODEL_TIERS,
  MODEL_TIER_RANK,
  CAPABILITY_TIER_FLOOR,
  zTimeoutPolicy,
  zModelRoutingInput,
  zModelSelectionDecision,
  // strategy
  zStrategyPolicy,
  DEFAULT_STRATEGY_POLICIES,
  getStrategyPolicy,
  isHighRiskCompatible,
  MAX_RECOVERY_LIMIT,
  MAX_SPECIALISTS_LIMIT,
  HIGH_RISK_CAPABILITY_FLOOR,
  validateCanonicalStrategyPolicy,
  // agents
  zDelegationDecision,
  zSpecialistResult,
  zChangeRef,
  validateSpecialistResultEnvelope,
  normalizeRepositoryRelativePath,
  CANONICAL_ALIAS_LOOKUP,
  isRepositoryRelativePath,
  specialistResultHasRequiredEvidence,
  resolveCanonicalPrincipal,
  isPrimaryAgent,
  isCanonicalSubagent,
  CANONICAL_SUBAGENT_IDS,
  CANONICAL_DELEGATING_AGENT_IDS,
  // records
  ROUTING_POLICY_VERSION,
  ROUTING_WEIGHTS_VERSION,
  validateRoutingDecisionRecord,
  bindDecisionToSha,
  type RoutingDecisionRecord,
  type SpecialistResultEnvelope,
  type SpecialistResult,
} from "@/orchestration/routing/contracts"
import {
  DEFAULT_WEIGHTS,
  WEIGHTS_VERSION,
} from "@/orchestration/routing/scoring/scorers"
import {
  SPECIALIST_TASK_CLASS,
  CANONICAL_SPECIALIST_IDS,
  specialistMappingComplete,
  specialistMappingParity,
  normalizeSpecialistId,
  resolveSpecialistClass,
} from "@/orchestration/routing/classifier/specialist-registry"
import { getSubagentIds, getPrimaryAgentIds } from "@/services/canonical-registry"

const VALID_SHA = "0123456789abcdef0123456789abcdef01234567"

// ───────────────────────────────────────────────────────────────────────────
// Version-policy parity fixtures.  If any canonical policy table changes,
// this fixture must change WITH it and the version constants must bump in
// the same commit.  A policy change that does not update the fixture (and
// therefore the version) fails here — proving a policy mutation requires an
// explicit version bump.
// ───────────────────────────────────────────────────────────────────────────
const FIXTURE_DEFAULT_WEIGHTS_JSON =
  '{"ambiguity":{"conflictingRequirements":20,"incompleteReproduction":20,"missingErrorEvidence":15,"missingTarget":15,"unclearSuccess":15,"undefinedOwnership":15,"unknownRepository":15},"complexity":{"concurrencyWeight":20,"crossPlatformWeight":15,"externalIntegrationWeight":20,"migrationWeight":25,"perCheck":8,"perDependencyDepth":10,"perDomain":20,"perFile":15,"perWorkstream":25},"risk":{"authWeight":25,"concurrencyWeight":20,"dataIntegrityWeight":30,"destructiveWeight":30,"externalSideEffectsWeight":20,"infrastructureWeight":25,"migrationWeight":25,"packagePublicationWeight":25,"productionWeight":30,"releaseWeight":20,"rollbackDifficultyWeight":15,"securityWeight":35}}'

const FIXTURE_MODEL_TIER_RANK_JSON = '{"general_coding":1,"small_fast":0,"strong_reasoning":2}'

const FIXTURE_CAPABILITY_TIER_FLOOR_JSON =
  '{"CI log inspection":"small_fast","FDX index inspection":"small_fast","GitHub inspection":"small_fast","UI implementation":"general_coding","code mutation":"general_coding","database migration":"strong_reasoning","destructive Git":"strong_reasoning","independent_review":"strong_reasoning","infrastructure change":"strong_reasoning","ownership_leases":"general_coding","package publication":"strong_reasoning","planning":"general_coding","read_only":"small_fast","release operation":"strong_reasoning","repository inspection":"general_coding","security audit":"strong_reasoning"}'

const FIXTURE_SPECIALIST_TASK_CLASS_JSON =
  '{"architect":"cross_module_feature","backend-coder":"cross_module_feature","debug-specialist":"local_bug","devops":"ci_failure","frontend-coder":"ui_feature","mapper":"repository_audit","planner":"cross_module_feature","researcher":"read_only_question","reviewer":"repository_audit","security-auditor":"security_review","tester":"local_bug"}'

// ───────────────────────────────────────────────────────────────────────────
// Base valid record helper (plain object, override-friendly).
// ───────────────────────────────────────────────────────────────────────────
function makeRecord(overrides: Partial<RoutingDecisionRecord> = {}): RoutingDecisionRecord {
  return {
    taskId: "task-closure-1",
    decisionId: "dec-closure-1",
    repositorySha: VALID_SHA,
    timestamp: "2026-01-01T00:00:00.000Z",
    routingPolicyVersion: ROUTING_POLICY_VERSION,
    weightsVersion: ROUTING_WEIGHTS_VERSION,
    inputEvidence: [{ signal: "expectedFileCount", value: 3, source: "prompt" }],
    rulesApplied: ["rule:classify"],
    modelFallbackUsed: false,
    classification: {
      taskClass: "local_bug",
      confidence: 92,
      evidence: [{ id: "e1", source: "classifier", detail: "stack trace found" }],
      usedModelFallback: false,
      policyVersion: ROUTING_POLICY_VERSION,
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
        taskId: "task-closure-1",
        delegatingAgent: "orchestrator",
        targetAgent: "debug-specialist",
        depth: 1,
        allowed: true,
        reason: "specialist_expertise",
        justification: ["stack trace present"],
      },
    ],
    modelCandidates: [{ tier: "strong_reasoning", reason: "debugging requires strong reasoning" }],
    selectedTier: "strong_reasoning",
    fallback: ["general_coding", "small_fast"],
    confidence: 90,
    ...overrides,
  } as RoutingDecisionRecord
}

function validSpecialistResult(overrides: Partial<SpecialistResult> = {}): SpecialistResult {
  return {
    status: "completed",
    summary: "Fixed the failing test",
    findings: [{ id: "f1", summary: "root cause identified", severity: "warning", location: "src/x.ts" }],
    changes: [{ file: "src/x.ts", kind: "modify", symbol: "foo" }],
    evidence: [{ id: "e1", kind: "test", detail: "unit test passes" }],
    assumptions: ["assumes network is available"],
    unresolvedRisks: [],
    confidence: 90,
    recommendedNextAction: "run full suite",
    ownershipUsed: ["src/x.ts"],
    ...overrides,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Policy immutability
// ───────────────────────────────────────────────────────────────────────────
describe("closure: exported policy tables are deeply immutable", () => {
  it("DEFAULT_WEIGHTS is deeply frozen (top level and every nested table)", () => {
    expect(Object.isFrozen(DEFAULT_WEIGHTS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_WEIGHTS.complexity)).toBe(true)
    expect(Object.isFrozen(DEFAULT_WEIGHTS.ambiguity)).toBe(true)
    expect(Object.isFrozen(DEFAULT_WEIGHTS.risk)).toBe(true)
  })

  it("MODEL_TIER_RANK is deeply frozen", () => {
    expect(Object.isFrozen(MODEL_TIER_RANK)).toBe(true)
  })

  it("CAPABILITY_TIER_FLOOR is deeply frozen", () => {
    expect(Object.isFrozen(CAPABILITY_TIER_FLOOR)).toBe(true)
  })

  it("SPECIALIST_TASK_CLASS is deeply frozen", () => {
    expect(Object.isFrozen(SPECIALIST_TASK_CLASS)).toBe(true)
  })

  it("MODEL_TIERS is frozen", () => {
    expect(Object.isFrozen(MODEL_TIERS)).toBe(true)
  })

  it("DEFAULT_STRATEGY_POLICIES and each policy are deeply frozen", () => {
    expect(Object.isFrozen(DEFAULT_STRATEGY_POLICIES)).toBe(true)
    for (const policy of Object.values(DEFAULT_STRATEGY_POLICIES)) {
      expect(Object.isFrozen(policy)).toBe(true)
      expect(Object.isFrozen(policy.allowedStates)).toBe(true)
      expect(Object.isFrozen(policy.requiredCapabilities)).toBe(true)
      expect(Object.isFrozen(policy.approvalRequirements)).toBe(true)
    }
  })

  it("mutation attempts throw in strict mode (top-level and nested)", () => {
    expect(() => {
      ;(DEFAULT_WEIGHTS as { complexity: { perFile: number } }).complexity.perFile = 999
    }).toThrow(TypeError)
    expect(() => {
      ;(MODEL_TIER_RANK as { strong_reasoning: number }).strong_reasoning = 99
    }).toThrow(TypeError)
    expect(() => {
      ;(CAPABILITY_TIER_FLOOR as Record<string, string>)["security audit"] = "small_fast"
    }).toThrow(TypeError)
    expect(() => {
      ;(SPECIALIST_TASK_CLASS as Record<string, string>)["planner"] = "unknown"
    }).toThrow(TypeError)
  })

  it("a cloned working copy can be mutated safely without affecting the canonical table", () => {
    const mutable = cloneFrozen(DEFAULT_WEIGHTS) as {
      complexity: { perFile: number }
      ambiguity: Record<string, number>
      risk: Record<string, number>
    }
    expect(Object.isFrozen(mutable)).toBe(false)
    mutable.complexity.perFile = 999
    expect(mutable.complexity.perFile).toBe(999)
    // canonical defaults remain unchanged
    expect(DEFAULT_WEIGHTS.complexity.perFile).toBe(15)
    // version identifiers remain unchanged after the failed/independent mutation
    expect(WEIGHTS_VERSION).toBe("1.0.0")
    expect(ROUTING_WEIGHTS_VERSION).toBe("1.0.0")
  })

  it("deepFreeze freezes nested arrays and objects", () => {
    const frozen = deepFreeze({ a: [1, 2], b: { c: "x" } })
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.a)).toBe(true)
    expect(Object.isFrozen(frozen.b)).toBe(true)
  })

  it("policy fixture parity: DEFAULT_WEIGHTS must match the versioned snapshot", () => {
    expect(canonicalJson(DEFAULT_WEIGHTS)).toBe(FIXTURE_DEFAULT_WEIGHTS_JSON)
    expect(WEIGHTS_VERSION).toBe("1.0.0")
    expect(ROUTING_WEIGHTS_VERSION).toBe("1.0.0")
  })

  it("policy fixture parity: MODEL_TIER_RANK must match the versioned snapshot", () => {
    expect(canonicalJson(MODEL_TIER_RANK)).toBe(FIXTURE_MODEL_TIER_RANK_JSON)
  })

  it("policy fixture parity: CAPABILITY_TIER_FLOOR must match the versioned snapshot", () => {
    expect(canonicalJson(CAPABILITY_TIER_FLOOR)).toBe(FIXTURE_CAPABILITY_TIER_FLOOR_JSON)
  })

  it("policy fixture parity: SPECIALIST_TASK_CLASS must match the versioned snapshot", () => {
    expect(canonicalJson(SPECIALIST_TASK_CLASS)).toBe(FIXTURE_SPECIALIST_TASK_CLASS_JSON)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. Delegation identity (canonical alias resolution)
// ───────────────────────────────────────────────────────────────────────────
describe("closure: delegation identity is canonicalized", () => {
  it("heidi and orchestrator resolve to the same principal", () => {
    expect(resolveCanonicalPrincipal("heidi")).toBe("heidi")
    expect(resolveCanonicalPrincipal("orchestrator")).toBe("heidi")
    expect(resolveCanonicalPrincipal("Heidi")).toBe("heidi")
  })

  it("alias normalization is deterministic and idempotent", () => {
    expect(resolveCanonicalPrincipal("heidi")).toBe(resolveCanonicalPrincipal("orchestrator"))
    expect(resolveCanonicalPrincipal("  heidi  ")).toBe("heidi")
    expect(resolveCanonicalPrincipal("  orchestrator  ")).toBe("heidi")
  })

  it("unknown and whitespace-only agents resolve to undefined", () => {
    expect(resolveCanonicalPrincipal("not-an-agent")).toBeUndefined()
    expect(resolveCanonicalPrincipal("   ")).toBeUndefined()
    expect(resolveCanonicalPrincipal("")).toBeUndefined()
  })

  it("isPrimaryAgent recognises both heidi and orchestrator", () => {
    expect(isPrimaryAgent("heidi")).toBe(true)
    expect(isPrimaryAgent("orchestrator")).toBe(true)
  })

  it("rejects heidi → orchestrator (same principal)", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "t",
      delegatingAgent: "heidi",
      targetAgent: "orchestrator",
      depth: 1,
      allowed: true,
      reason: "specialist_expertise",
      justification: ["context"],
    })
    expect(result.success).toBe(false)
  })

  it("rejects orchestrator → heidi (same principal)", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "t",
      delegatingAgent: "orchestrator",
      targetAgent: "heidi",
      depth: 1,
      allowed: true,
      reason: "specialist_expertise",
      justification: ["context"],
    })
    expect(result.success).toBe(false)
  })

  it("rejects heidi → heidi and orchestrator → orchestrator", () => {
    for (const [delegating, target] of [
      ["heidi", "heidi"],
      ["orchestrator", "orchestrator"],
    ] as const) {
      const result = zDelegationDecision.safeParse({
        taskId: "t",
        delegatingAgent: delegating,
        targetAgent: target,
        depth: 1,
        allowed: true,
        reason: "specialist_expertise",
        justification: ["context"],
      })
      expect(result.success, `${delegating} → ${target} must be rejected`).toBe(false)
    }
  })

  it("rejects every primary-to-primary combination", () => {
    for (const delegating of getPrimaryAgentIds()) {
      for (const target of getPrimaryAgentIds()) {
        const result = zDelegationDecision.safeParse({
          taskId: "t",
          delegatingAgent: delegating,
          targetAgent: target,
          depth: 1,
          allowed: true,
          reason: "specialist_expertise",
          justification: ["context"],
        })
        expect(result.success, `${delegating} → ${target} must be rejected`).toBe(false)
      }
    }
  })

  it("accepts primary → canonical subagent when otherwise valid", () => {
    const cases: Array<[string, string]> = [
      ["heidi", "backend-coder"],
      ["orchestrator", "reviewer"],
      ["heidi", "debug-specialist"],
    ]
    for (const [delegating, target] of cases) {
      const result = zDelegationDecision.safeParse({
        taskId: "t",
        delegatingAgent: delegating,
        targetAgent: target,
        depth: 1,
        allowed: true,
        reason: "specialist_expertise",
        justification: ["specialist context"],
      })
      expect(result.success, `${delegating} → ${target} must pass`).toBe(true)
    }
  })

  it("rejects every specialist as a delegating agent", () => {
    for (const specialist of getSubagentIds()) {
      for (const target of [...getSubagentIds(), "heidi"]) {
        const result = zDelegationDecision.safeParse({
          taskId: "t",
          delegatingAgent: specialist,
          targetAgent: target,
          depth: 1,
          allowed: true,
          reason: "specialist_expertise",
          justification: ["context"],
        })
        expect(result.success, `${specialist} must not delegate`).toBe(false)
      }
    }
  })

  it("rejects unknown and whitespace-only targets", () => {
    for (const target of ["not-an-agent", "   ", ""]) {
      const result = zDelegationDecision.safeParse({
        taskId: "t",
        delegatingAgent: "orchestrator",
        targetAgent: target,
        depth: 1,
        allowed: true,
        reason: "specialist_expertise",
        justification: ["context"],
      })
      expect(result.success, `target "${target}" must be rejected`).toBe(false)
    }
  })

  it("rejects unknown delegators", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "t",
      delegatingAgent: "mystery-agent",
      targetAgent: "backend-coder",
      depth: 1,
      allowed: true,
      reason: "specialist_expertise",
      justification: ["context"],
    })
    expect(result.success).toBe(false)
  })

  it("preserves the raw requested ids in the parsed decision while authorizing canonically", () => {
    const parsed = zDelegationDecision.safeParse({
      taskId: "t",
      delegatingAgent: "orchestrator",
      targetAgent: "reviewer",
      depth: 1,
      allowed: true,
      reason: "independent_audit",
      justification: ["independent audit required"],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // raw ids preserved
      expect(parsed.data.delegatingAgent).toBe("orchestrator")
      expect(parsed.data.targetAgent).toBe("reviewer")
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. Routing-decision consistency (cross-field invariants)
// ───────────────────────────────────────────────────────────────────────────
describe("closure: routing decision record cross-field invariants", () => {
  it("accepts a valid complete record", () => {
    const result = validateRoutingDecisionRecord(makeRecord())
    expect(result.ok).toBe(true)
  })

  it("rejects a selected strategy that also appears as rejected", () => {
    const record = makeRecord({
      rejectedStrategies: [{ strategy: "root_cause_repair", reason: "contradictory" }],
    })
    const result = validateRoutingDecisionRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("rejectedStrategies")
  })

  it("rejects duplicate rejected strategies", () => {
    const record = makeRecord({
      rejectedStrategies: [
        { strategy: "audit_only", reason: "task is mutating" },
        { strategy: "audit_only", reason: "duplicate" },
      ],
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects whitespace-only rejected-strategy reasons", () => {
    const record = makeRecord({
      rejectedStrategies: [{ strategy: "audit_only", reason: "   " }],
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects a selected tier that appears in fallback", () => {
    const record = makeRecord({ fallback: ["strong_reasoning", "general_coding"] })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects duplicate fallback tiers", () => {
    const record = makeRecord({ fallback: ["general_coding", "general_coding"] })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects fallback ordering that is not strongest-first (degradation-only)", () => {
    const record = makeRecord({ fallback: ["small_fast", "general_coding"] })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects a delegation decision whose taskId differs from the record taskId", () => {
    const record = makeRecord({
      delegationDecisions: [
        {
          taskId: "some-other-task",
          delegatingAgent: "orchestrator",
          targetAgent: "debug-specialist",
          depth: 1,
          allowed: true,
          reason: "specialist_expertise",
          justification: ["stack trace present"],
        },
      ],
    })
    const result = validateRoutingDecisionRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("taskId")
  })

  it("rejects duplicate delegation decisions by task, delegator, target, depth", () => {
    const dup = {
      taskId: "task-closure-1",
      delegatingAgent: "orchestrator",
      targetAgent: "debug-specialist",
      depth: 1,
      allowed: true,
      reason: "specialist_expertise" as const,
      justification: ["stack trace present"],
    }
    const record = makeRecord({ delegationDecisions: [dup, { ...dup }] })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects a mismatched classification policy version", () => {
    const record = makeRecord({
      classification: {
        taskClass: "local_bug",
        confidence: 92,
        evidence: [{ id: "e1", source: "classifier", detail: "stack trace found" }],
        usedModelFallback: false,
        policyVersion: "9.9.9",
      },
    })
    const result = validateRoutingDecisionRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("policyVersion")
  })

  it("rejects a mismatched scores policy version", () => {
    const record = makeRecord({
      scores: {
        ...makeRecord().scores,
        policyVersion: "9.9.9",
      },
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects a mismatched scores weights version", () => {
    const record = makeRecord({
      scores: {
        ...makeRecord().scores,
        weightsVersion: "9.9.9",
      },
    })
    const result = validateRoutingDecisionRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("weightsVersion")
  })

  it("rejects duplicate rulesApplied", () => {
    const record = makeRecord({ rulesApplied: ["rule:classify", "rule:classify"] })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects duplicate model candidates (same tier/provider combo)", () => {
    const record = makeRecord({
      modelCandidates: [
        { tier: "strong_reasoning", reason: "debugging" },
        { tier: "strong_reasoning", reason: "also debugging" },
      ],
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects a selected tier absent from model candidates when candidates are supplied", () => {
    const record = makeRecord({
      modelCandidates: [{ tier: "general_coding", reason: "cheap enough" }],
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects a decision that supersedes itself", () => {
    const record = makeRecord({ supersedes: "dec-closure-1" })
    const result = validateRoutingDecisionRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("supersedes")
  })

  it("rejects a non-canonical specialist candidate", () => {
    const record = makeRecord({ specialistCandidates: ["heidi"] })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects duplicate specialist candidates", () => {
    const record = makeRecord({ specialistCandidates: ["debug-specialist", "debug-specialist"] })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects empty input evidence", () => {
    const record = makeRecord({ inputEvidence: [] })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects empty classification evidence", () => {
    const record = makeRecord({
      classification: {
        taskClass: "local_bug",
        confidence: 92,
        evidence: [],
        usedModelFallback: false,
        policyVersion: ROUTING_POLICY_VERSION,
      },
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects cross-dimension duplicate score evidence ids", () => {
    const record = makeRecord({
      scores: {
        ...makeRecord().scores,
        evidence: {
          complexity: [{ id: "shared-id", source: "scoring.complexity", detail: "file count" }],
          ambiguity: [{ id: "shared-id", source: "scoring.ambiguity", detail: "missing target" }],
          risk: [{ id: "e-risk", source: "scoring.risk", detail: "production impact" }],
          confidence: [{ id: "e-conf", source: "scoring.confidence", detail: "ambiguity" }],
        },
      },
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("bindDecisionToSha fails closed on invalid relationships", () => {
    expect(() =>
      bindDecisionToSha({
        ...makeRecord(),
        fallback: ["small_fast", "general_coding"],
      } as never),
    ).toThrow()
    expect(() =>
      bindDecisionToSha({
        ...makeRecord(),
        supersedes: "dec-closure-1",
      } as never),
    ).toThrow()
  })

  it("the binder returns an independent, deeply frozen record", () => {
    const record = bindDecisionToSha(makeRecord())
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.inputEvidence)).toBe(true)
    expect(Object.isFrozen(record.scores)).toBe(true)
    expect(Object.isFrozen(record.delegationDecisions)).toBe(true)
    expect(record).not.toBe(makeRecord())
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 4. Canonical JSON — collisions, undefined arrays, sparse arrays
// ───────────────────────────────────────────────────────────────────────────
describe("closure: canonical JSON rejects collisions", () => {
  it("object-key order is deterministic", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it("omits undefined object properties (documented canonical rule)", () => {
    expect(canonicalJson({ value: undefined })).toBe("{}")
    expect(canonicalJson({ value: undefined })).toBe(canonicalJson({}))
  })

  it("keeps null object properties distinctly", () => {
    expect(canonicalJson({ value: null })).toBe('{"value":null}')
    expect(canonicalJson({ value: null })).not.toBe(canonicalJson({}))
  })

  it("rejects an undefined array entry (would otherwise collide with [null])", () => {
    expect(() => canonicalJson([undefined])).toThrow(/undefined array entries/)
    expect(() => canonicalJson([undefined, 1])).toThrow()
  })

  it("accepts a null array entry distinctly from undefined", () => {
    expect(canonicalJson([null])).toBe("[null]")
    // undefined entries are rejected outright, so [undefined] can never
    // serialize identically to [null] — the collision is impossible.
    expect(() => canonicalJson([undefined])).toThrow()
    expect(canonicalJson([null])).not.toBe("[undefined]")
  })

  it("rejects sparse arrays (new Array(1))", () => {
    // eslint-disable-next-line unicorn/no-new-array -- intentional sparse array fixture
    expect(() => canonicalJson(new Array(1))).toThrow(/sparse arrays/)
    // eslint-disable-next-line unicorn/no-new-array -- intentional sparse array fixture
    expect(() => canonicalJson({ a: new Array(1) })).toThrow()
  })

  it("rejects sparse arrays with trailing holes ([, \"value\"])", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([, "value"])).toThrow(/sparse arrays/)
  })

  it("rejects nested sparse arrays", () => {
    expect(() => canonicalJson([[undefined]])).toThrow(/undefined array entries/)
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson([[, "x"]])).toThrow(/sparse arrays/)
  })

  it("rejects cycles", () => {
    const x: Record<string, unknown> = {}
    x.self = x
    expect(() => canonicalJson(x)).toThrow(/non-serializable value/)
  })

  it("rejects Map, Set, typed arrays, and class instances", () => {
    class Foo {
      x = 1
    }
    expect(() => canonicalJson(new Map())).toThrow()
    expect(() => canonicalJson(new Set())).toThrow()
    expect(() => canonicalJson(new Uint8Array([1]))).toThrow()
    expect(() => canonicalJson(new Foo())).toThrow()
  })

  it("accepts finite numbers and rejects non-finite numbers", () => {
    expect(canonicalJson({ n: 0, m: -1.5 })).toBe('{"m":-1.5,"n":0}')
    expect(() => canonicalJson(NaN)).toThrow()
    expect(() => canonicalJson(Infinity)).toThrow()
  })

  it("no accepted-value collision across adversarial fixtures", () => {
    const values = [
      null,
      [null],
      [1],
      [[null]],
      [[]],
      [],
      {},
      { a: null },
      { a: 0 },
      [1, 2, 3],
      { a: [1, 2], b: 3 },
    ]
    const serialized = new Set(values.map((v) => canonicalJson(v)))
    expect(serialized.size).toBe(values.length)
    // The documented omission rule makes { a: undefined } semantically
    // identical to {} — that equivalence is intentional and asserted above.
    expect(canonicalJson({ a: undefined })).toBe(canonicalJson({}))
  })

  it("canonicalClone rejects undefined array entries and sparse arrays", () => {
    expect(() => canonicalClone([undefined])).toThrow()
    // eslint-disable-next-line unicorn/no-new-array -- intentional sparse array fixture
    expect(() => canonicalClone(new Array(2))).toThrow()
  })

  it("canonicalJson of a bound record round-trips through parseCanonicalJson", () => {
    const record = bindDecisionToSha(makeRecord())
    const roundTripped = parseCanonicalJson(canonicalJson(record))
    expect(roundTripped).toEqual(record)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 5. Evidence — meaningful, trimmed, unique
// ───────────────────────────────────────────────────────────────────────────
describe("closure: evidence is meaningful and unique", () => {
  it("rejects whitespace-only evidence ids", () => {
    expect(zEvidenceReference.safeParse({ id: "  ", source: "s", detail: "d" }).success).toBe(false)
    expect(zEvidenceReference.safeParse({ id: "", source: "s", detail: "d" }).success).toBe(false)
  })

  it("rejects whitespace-only evidence sources", () => {
    expect(zEvidenceReference.safeParse({ id: "e1", source: "   ", detail: "d" }).success).toBe(false)
  })

  it("rejects whitespace-only evidence details", () => {
    expect(zEvidenceReference.safeParse({ id: "e1", source: "s", detail: "  " }).success).toBe(false)
  })

  it("rejects placeholder evidence like a bare \"unknown\" detail", () => {
    expect(zEvidenceReference.safeParse({ id: "e1", source: "s", detail: "unknown" }).success).toBe(false)
    expect(zEvidenceReference.safeParse({ id: "e1", source: "s", detail: "n/a" }).success).toBe(false)
    // An explanatory detail that contains the word "unknown" is meaningful.
    expect(
      zEvidenceReference.safeParse({ id: "e1", source: "s", detail: "classifier returned unknown for low confidence" })
        .success,
    ).toBe(true)
  })

  it("trims ids via zNonEmptyId", () => {
    const parsed = zNonEmptyId.safeParse("  task-1  ")
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toBe("task-1")
  })

  it("rejects whitespace-only routing input signals and sources", () => {
    expect(zRoutingInputEvidence.safeParse({ signal: "   ", value: 1, source: "s" }).success).toBe(false)
    expect(zRoutingInputEvidence.safeParse({ signal: "s", value: 1, source: " " }).success).toBe(false)
  })

  it("rejects unsupported evidence values via canonical serialization", () => {
    expect(
      zRoutingInputEvidence.safeParse({ signal: "s", value: new Map([["a", 1]]), source: "src" }).success,
    ).toBe(false)
    expect(zRoutingInputEvidence.safeParse({ signal: "s", value: /regex/, source: "src" }).success).toBe(false)
  })

  it("accepts valid measured-zero evidence", () => {
    expect(
      zRoutingInputEvidence.safeParse({ signal: "expectedFileCount", value: 0, source: "prompt" }).success,
    ).toBe(true)
    expect(
      zEvidenceReference.safeParse({ id: "score.cx.zero", source: "scoring.complexity", detail: "measured zero" })
        .success,
    ).toBe(true)
  })

  it("rejects empty classification evidence", () => {
    expect(
      zClassificationResult.safeParse({
        taskClass: "local_bug",
        confidence: 90,
        evidence: [],
        usedModelFallback: false,
        policyVersion: "1.0.0",
      }).success,
    ).toBe(false)
  })

  it("rejects duplicate classification evidence ids", () => {
    expect(
      zClassificationResult.safeParse({
        taskClass: "local_bug",
        confidence: 90,
        evidence: [
          { id: "e1", source: "s", detail: "d1" },
          { id: "e1", source: "s", detail: "d2" },
        ],
        usedModelFallback: false,
        policyVersion: "1.0.0",
      }).success,
    ).toBe(false)
  })

  it("rejects duplicate score evidence ids within a dimension", () => {
    expect(
      zScoredTask.safeParse({
        scores: { complexity: 10, ambiguity: 10, risk: 10, confidence: 10 },
        evidence: {
          complexity: [
            { id: "dup", source: "s", detail: "d1" },
            { id: "dup", source: "s", detail: "d2" },
          ],
          ambiguity: [{ id: "e2", source: "s", detail: "d" }],
          risk: [{ id: "e3", source: "s", detail: "d" }],
          confidence: [{ id: "e4", source: "s", detail: "d" }],
        },
        weightsVersion: "1.0.0",
        policyVersion: "1.0.0",
      }).success,
    ).toBe(false)
  })

  it("rejects cross-dimension duplicate score evidence ids", () => {
    expect(
      zScoredTask.safeParse({
        scores: { complexity: 10, ambiguity: 10, risk: 10, confidence: 10 },
        evidence: {
          complexity: [{ id: "shared", source: "s", detail: "d" }],
          ambiguity: [{ id: "shared", source: "s", detail: "d" }],
          risk: [{ id: "e3", source: "s", detail: "d" }],
          confidence: [{ id: "e4", source: "s", detail: "d" }],
        },
        weightsVersion: "1.0.0",
        policyVersion: "1.0.0",
      }).success,
    ).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 6. Model contracts — timeouts and deterministic fallback
// ───────────────────────────────────────────────────────────────────────────
describe("closure: model timeout and fallback invariants", () => {
  it("rejects queueMs > totalMs", () => {
    expect(zTimeoutPolicy.safeParse({ queueMs: 2000, firstTokenMs: 10, totalMs: 1000 }).success).toBe(false)
  })

  it("rejects firstTokenMs > totalMs", () => {
    expect(zTimeoutPolicy.safeParse({ queueMs: 0, firstTokenMs: 5000, totalMs: 1000 }).success).toBe(false)
  })

  it("rejects totalMs === 0", () => {
    expect(zTimeoutPolicy.safeParse({ queueMs: 0, firstTokenMs: 0, totalMs: 0 }).success).toBe(false)
  })

  it("accepts a valid timeout policy", () => {
    expect(zTimeoutPolicy.safeParse({ queueMs: 500, firstTokenMs: 10000, totalMs: 120000 }).success).toBe(true)
  })

  it("rejects a whitespace-only provider", () => {
    const base = {
      tier: "strong_reasoning",
      provider: "  ",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
  })

  it("rejects a whitespace-only model", () => {
    const base = {
      tier: "strong_reasoning",
      provider: "anthropic",
      model: "  ",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
  })

  it("rejects a model without a provider (documented policy: model requires provider)", () => {
    const base = {
      tier: "strong_reasoning",
      model: "claude-opus",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
  })

  it("accepts provider/model when both present and meaningful", () => {
    const base = {
      tier: "strong_reasoning",
      provider: "anthropic",
      model: "claude-opus",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(true)
  })

  it("rejects the selected tier appearing in fallback tiers", () => {
    const base = {
      tier: "strong_reasoning",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["strong_reasoning", "general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
  })

  it("rejects duplicate fallback tiers", () => {
    const base = {
      tier: "strong_reasoning",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding", "general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
  })

  it("rejects wrong fallback order (escalation mixed into degradation-only)", () => {
    const base = {
      tier: "strong_reasoning",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["small_fast", "general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
  })

  it("accepts degradation-only fallback ordering (strongest-first)", () => {
    const base = {
      tier: "strong_reasoning",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding", "small_fast"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(true)
  })

  it("rejects duplicate capability-floor entries", () => {
    const base = {
      tier: "strong_reasoning",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection", "GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
    expect(
      zModelRoutingInput.safeParse({
        taskId: "t",
        taskClass: "ui_feature",
        scores: { complexity: 50, ambiguity: 30, risk: 20, confidence: 80 },
        capabilityFloor: ["UI implementation", "UI implementation"],
        strategy: "parallel_implementation",
        timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      }).success,
    ).toBe(false)
  })

  it("rejects an unknown capability in the floor", () => {
    const base = {
      tier: "strong_reasoning",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["not_a_capability"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
  })

  it("accepts a valid decision whose tier and fallbacks meet the floor", () => {
    expect(
      zModelSelectionDecision.safeParse({
        tier: "strong_reasoning",
        provider: "anthropic",
        model: "claude-opus",
        confidence: 90,
        reasonCodes: ["complex"],
        fallbackTiers: [],
        timeoutPolicy: { queueMs: 500, firstTokenMs: 10000, totalMs: 120000 },
        capabilityFloor: ["security audit"],
      }).success,
    ).toBe(true)
    // A degradation fallback is only valid when it still meets the floor.
    expect(
      zModelSelectionDecision.safeParse({
        tier: "strong_reasoning",
        confidence: 90,
        reasonCodes: ["complex"],
        fallbackTiers: ["general_coding"],
        timeoutPolicy: { queueMs: 500, firstTokenMs: 10000, totalMs: 120000 },
        capabilityFloor: ["security audit"],
      }).success,
    ).toBe(false)
  })

  it("rejects duplicate reason codes", () => {
    const base = {
      tier: "strong_reasoning",
      confidence: 90,
      reasonCodes: ["complex", "complex"],
      fallbackTiers: ["general_coding", "small_fast"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 1000 },
      capabilityFloor: ["GitHub inspection"],
    }
    expect(zModelSelectionDecision.safeParse(base).success).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 7. Specialist-result contracts
// ───────────────────────────────────────────────────────────────────────────
describe("closure: specialist-result contracts", () => {
  it("rejects a completed result with a whitespace-only summary", () => {
    expect(zSpecialistResult.safeParse(validSpecialistResult({ summary: "   " })).success).toBe(false)
  })

  it("rejects a completed result without evidence", () => {
    expect(zSpecialistResult.safeParse(validSpecialistResult({ evidence: [] })).success).toBe(false)
  })

  it("rejects a blocked result without a meaningful reason", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({ status: "blocked", summary: "  ", evidence: [] }),
      ).success,
    ).toBe(false)
  })

  it("rejects a failed result without a meaningful reason", () => {
    expect(
      zSpecialistResult.safeParse(validSpecialistResult({ status: "failed", summary: "unknown", evidence: [] }))
        .success,
    ).toBe(false)
  })

  it("rejects a cancelled result without a cancellation reason", () => {
    expect(
      zSpecialistResult.safeParse(validSpecialistResult({ status: "cancelled", summary: "   " })).success,
    ).toBe(false)
  })

  it("rejects an empty evidence detail", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({ evidence: [{ id: "e1", kind: "test", detail: " " }] }),
      ).success,
    ).toBe(false)
  })

  it("rejects an absolute changed-file path", () => {
    expect(
      zSpecialistResult.safeParse(validSpecialistResult({ changes: [{ file: "/etc/passwd", kind: "modify" }] }))
        .success,
    ).toBe(false)
  })

  it("rejects a traversal changed-file path", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({ changes: [{ file: "../outside/repo.ts", kind: "modify" }] }),
      ).success,
    ).toBe(false)
  })

  it("rejects absolute and traversal ownership paths", () => {
    expect(zSpecialistResult.safeParse(validSpecialistResult({ ownershipUsed: ["/abs/path"] })).success).toBe(false)
    expect(zSpecialistResult.safeParse(validSpecialistResult({ ownershipUsed: ["../escape"] })).success).toBe(false)
  })

  it("rejects duplicate evidence ids", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          evidence: [
            { id: "e1", kind: "test", detail: "first" },
            { id: "e1", kind: "test", detail: "second" },
          ],
        }),
      ).success,
    ).toBe(false)
  })

  it("rejects duplicate finding ids", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          findings: [
            { id: "f1", summary: "first", severity: "warning" },
            { id: "f1", summary: "second", severity: "warning" },
          ],
        }),
      ).success,
    ).toBe(false)
  })

  it("rejects duplicate ownership paths", () => {
    expect(
      zSpecialistResult.safeParse(validSpecialistResult({ ownershipUsed: ["src/x.ts", "src/x.ts"] })).success,
    ).toBe(false)
  })

  it("rejects whitespace-only assumptions and unresolved risks", () => {
    expect(zSpecialistResult.safeParse(validSpecialistResult({ assumptions: ["   "] })).success).toBe(false)
    expect(zSpecialistResult.safeParse(validSpecialistResult({ unresolvedRisks: ["   "] })).success).toBe(false)
  })

  it("rejects a completed result with changes but no evidence", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({ changes: [{ file: "src/y.ts", kind: "create" }], evidence: [] }),
      ).success,
    ).toBe(false)
  })

  it("accepts a valid completed result and a valid read-only result", () => {
    expect(zSpecialistResult.safeParse(validSpecialistResult()).success).toBe(true)
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          status: "completed",
          changes: [],
          summary: "Audit complete; no mutation performed",
          findings: [{ id: "f1", summary: "no critical findings", severity: "info" }],
        }),
      ).success,
    ).toBe(true)
  })

  it("accepts a blocked result with an explicit terminal reason", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          status: "blocked",
          summary: "blocked on credentials",
          terminalReason: "credentials unavailable in the vault",
          evidence: [{ id: "e1", kind: "observation", detail: "credentials unavailable" }],
        }),
      ).success,
    ).toBe(true)
  })

  it("rejects a blocked result whose terminal reason is only the status word", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          status: "blocked",
          summary: "blocked",
          terminalReason: "blocked",
          evidence: [{ id: "e1", kind: "observation", detail: "credentials unavailable" }],
        }),
      ).success,
    ).toBe(false)
  })

  it("rejects a blocked result with evidence but no explicit terminal reason", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          status: "blocked",
          summary: "blocked on credentials",
          evidence: [{ id: "e1", kind: "observation", detail: "credentials unavailable" }],
        }),
      ).success,
    ).toBe(false)
  })

  it("isRepositoryRelativePath rejects absolute, drive, and traversal paths", () => {
    expect(isRepositoryRelativePath("src/x.ts")).toBe(true)
    expect(isRepositoryRelativePath("/abs")).toBe(false)
    expect(isRepositoryRelativePath("C:\\abs")).toBe(false)
    expect(isRepositoryRelativePath("../x")).toBe(false)
    expect(isRepositoryRelativePath("src/../x")).toBe(false)
    expect(isRepositoryRelativePath("  ")).toBe(false)
  })

  it("specialistResultHasRequiredEvidence is whitespace/placeholder aware", () => {
    const base = validSpecialistResult() as unknown as Parameters<typeof specialistResultHasRequiredEvidence>[0]
    expect(specialistResultHasRequiredEvidence({ ...base, summary: "   " })).toBe(false)
    expect(specialistResultHasRequiredEvidence({ ...base, summary: "unknown", evidence: [] })).toBe(false)
    // A completed result with a meaningful summary and evidence satisfies the check.
    expect(specialistResultHasRequiredEvidence({ ...base })).toBe(true)
    // A completed result with meaningful summary but NO evidence fails.
    expect(specialistResultHasRequiredEvidence({ ...base, evidence: [] })).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 8. Strategy-policy contracts
// ───────────────────────────────────────────────────────────────────────────
describe("closure: strategy-policy contracts", () => {
  const base = getStrategyPolicy("planned_execution")

  it("rejects empty allowedStates", () => {
    expect(zStrategyPolicy.safeParse({ ...base, allowedStates: [] }).success).toBe(false)
  })

  it("rejects duplicate stages", () => {
    expect(
      zStrategyPolicy.safeParse({ ...base, allowedStates: ["execute", "execute"] }).success,
    ).toBe(false)
  })

  it("rejects unknown capabilities", () => {
    expect(
      zStrategyPolicy.safeParse({ ...base, requiredCapabilities: ["not_a_capability"] }).success,
    ).toBe(false)
  })

  it("rejects duplicate capabilities", () => {
    expect(
      zStrategyPolicy.safeParse({ ...base, requiredCapabilities: ["planning", "planning"] }).success,
    ).toBe(false)
  })

  it("rejects empty/whitespace approval requirements", () => {
    expect(zStrategyPolicy.safeParse({ ...base, approvalRequirements: ["  "] }).success).toBe(false)
  })

  it("rejects duplicate approval requirements", () => {
    expect(
      zStrategyPolicy.safeParse({
        ...base,
        approvalRequirements: ["high_risk_approval", "high_risk_approval"],
      }).success,
    ).toBe(false)
  })

  it("rejects a strategy requiring reviewers but omitting the review stage", () => {
    expect(
      zStrategyPolicy.safeParse({ ...base, requiredReviewers: 1, allowedStates: ["task", "execute", "verify"] })
        .success,
    ).toBe(false)
  })

  it("rejects required verification without a verify stage", () => {
    expect(
      zStrategyPolicy.safeParse({ ...base, verificationLevel: "full", allowedStates: ["task", "execute", "review"] })
        .success,
    ).toBe(false)
  })

  it("rejects a zero context budget", () => {
    expect(zStrategyPolicy.safeParse({ ...base, contextBudget: 0 }).success).toBe(false)
  })

  it("rejects a recovery limit above the documented maximum", () => {
    expect(zStrategyPolicy.safeParse({ ...base, recoveryLimit: MAX_RECOVERY_LIMIT + 1 }).success).toBe(false)
    expect(MAX_RECOVERY_LIMIT).toBe(3)
  })

  it("rejects an unbounded specialist count", () => {
    expect(zStrategyPolicy.safeParse({ ...base, maximumSpecialists: MAX_SPECIALISTS_LIMIT + 1 }).success).toBe(false)
  })

  it("rejects a high-risk approval on a policy that fails the full posture", () => {
    expect(
      zStrategyPolicy.safeParse({
        ...base,
        approvalRequirements: ["high_risk_approval"],
        verificationLevel: "focused",
        requiredReviewers: 0,
        allowedStates: ["execute"],
      }).success,
    ).toBe(false)
  })

  it("every default strategy validates", () => {
    for (const strategy of Object.keys(DEFAULT_STRATEGY_POLICIES)) {
      const parsed = zStrategyPolicy.safeParse(DEFAULT_STRATEGY_POLICIES[strategy as keyof typeof DEFAULT_STRATEGY_POLICIES])
      expect(parsed.success, `${strategy} default must validate`).toBe(true)
    }
  })

  it("every high-risk-compatible default passes the full posture", () => {
    for (const strategy of [
      "planned_execution",
      "parallel_implementation",
      "root_cause_repair",
      "audit_only",
      "repair_and_independent_audit",
      "recovery_resume",
    ] as const) {
      expect(isHighRiskCompatible(DEFAULT_STRATEGY_POLICIES[strategy]), strategy).toBe(true)
    }
    expect(isHighRiskCompatible(DEFAULT_STRATEGY_POLICIES.fast_direct)).toBe(false)
  })

  it("explore_then_execute includes the verify stage (standard verification)", () => {
    const policy = DEFAULT_STRATEGY_POLICIES.explore_then_execute
    expect(policy.verificationLevel).toBe("standard")
    expect(policy.allowedStates).toContain("verify")
  })

  it("low-risk strategies do not carry contradictory high-risk approvals", () => {
    expect(DEFAULT_STRATEGY_POLICIES.fast_direct.approvalRequirements).toHaveLength(0)
    expect(DEFAULT_STRATEGY_POLICIES.direct_verified.approvalRequirements).toHaveLength(0)
    expect(DEFAULT_STRATEGY_POLICIES.explore_then_execute.approvalRequirements).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 9. Specialist mapping parity (two-way)
// ───────────────────────────────────────────────────────────────────────────
describe("closure: specialist mapping parity", () => {
  it("mapping is frozen", () => {
    expect(Object.isFrozen(SPECIALIST_TASK_CLASS)).toBe(true)
  })

  it("canonical subagent ids === specialist mapping keys (two-way equality)", () => {
    expect(specialistMappingParity()).toBe(true)
    const mappingKeys = Object.keys(SPECIALIST_TASK_CLASS).sort()
    const canonicalSubagents = [...CANONICAL_SPECIALIST_IDS].sort()
    expect(mappingKeys).toEqual(canonicalSubagents)
    expect(specialistMappingComplete()).toBe(true)
  })

  it("no primary agent appears in the specialist mapping", () => {
    for (const primary of getPrimaryAgentIds()) {
      expect(primary in SPECIALIST_TASK_CLASS, `${primary} must not be a mapping key`).toBe(false)
    }
  })

  it("every mapped task class is canonical", () => {
    for (const taskClass of Object.values(SPECIALIST_TASK_CLASS)) {
      expect(zTaskClass.safeParse(taskClass).success).toBe(true)
    }
  })

  it("normalization happens before lookup", () => {
    expect(normalizeSpecialistId("  Backend-Coder  ")).toBe("backend-coder")
    expect(resolveSpecialistClass("backend-coder")).toBe("cross_module_feature")
    expect(resolveSpecialistClass(normalizeSpecialistId("  Debug-Specialist "))).toBe("local_bug")
    expect(resolveSpecialistClass("heidi")).toBeUndefined()
  })

  it("registry-derived identity sets are consistent", () => {
    // CANONICAL_SUBAGENT_IDS and CANONICAL_SPECIALIST_IDS derive from the
    // same source; the parity test pins them together.
    expect([...CANONICAL_SUBAGENT_IDS].sort()).toEqual([...CANONICAL_SPECIALIST_IDS].sort())
    expect(CANONICAL_DELEGATING_AGENT_IDS).toEqual(["heidi", "orchestrator"])
    // No overlap between primary and subagent sets.
    for (const primary of getPrimaryAgentIds()) {
      expect(CANONICAL_SUBAGENT_IDS.includes(primary)).toBe(false)
    }
  })

  it("isCanonicalSubagent accepts only canonical subagents", () => {
    for (const sub of getSubagentIds()) {
      expect(isCanonicalSubagent(sub)).toBe(true)
    }
    expect(isCanonicalSubagent("heidi")).toBe(false)
    expect(isCanonicalSubagent("orchestrator")).toBe(false)
    expect(isCanonicalSubagent("not-an-agent")).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Req 14: adversarial counterexamples (escalation, provenance, identity,
// path normalization, capability-gated mutation).
// ───────────────────────────────────────────────────────────────────────────
describe("closure: adversarial counterexamples for fallback, provenance, and identity", () => {
  it("rejects an escalating fallback (stronger tier after small_fast) at record level", () => {
    const record = makeRecord({
      modelCandidates: [{ tier: "small_fast", reason: "cheap" }],
      selectedTier: "small_fast",
      fallback: ["strong_reasoning"],
    })
    const result = validateRoutingDecisionRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("strictly weaker")
  })

  it("rejects a fallback tier that equals the selected tier at record level", () => {
    const record = makeRecord({
      modelCandidates: [{ tier: "general_coding", reason: "balanced" }],
      selectedTier: "general_coding",
      fallback: ["general_coding"],
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("rejects modelFallbackUsed that contradicts classification.usedModelFallback", () => {
    // makeRecord defaults: modelFallbackUsed=false, classification.usedModelFallback=false.
    const record = makeRecord({ modelFallbackUsed: true })
    const result = validateRoutingDecisionRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("modelFallbackUsed")
  })

  it("rejects record-wide evidence id collisions across scopes", () => {
    // Classification evidence id "e-cx" collides with scores.complexity "e-cx".
    const record = makeRecord({
      classification: {
        ...makeRecord().classification,
        evidence: [{ id: "e-cx", source: "classifier", detail: "stack trace found" }],
      },
    })
    const result = validateRoutingDecisionRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("collision")
  })

  it("rejects routing input evidence whose observed value is undefined", () => {
    expect(
      zRoutingInputEvidence.safeParse({ signal: "expectedFileCount", value: undefined, source: "prompt" }).success,
    ).toBe(false)
    const record = makeRecord({
      inputEvidence: [{ signal: "expectedFileCount", value: undefined, source: "prompt" }],
    })
    expect(validateRoutingDecisionRecord(record).ok).toBe(false)
  })

  it("accepts explicit falsy evidence values (0, false, empty string) as real observations", () => {
    expect(zRoutingInputEvidence.safeParse({ signal: "s", value: 0, source: "src" }).success).toBe(true)
    expect(zRoutingInputEvidence.safeParse({ signal: "s", value: false, source: "src" }).success).toBe(true)
    expect(zRoutingInputEvidence.safeParse({ signal: "s", value: "", source: "src" }).success).toBe(true)
    expect(zRoutingInputEvidence.safeParse({ signal: "s", value: null, source: "src" }).success).toBe(true)
  })

  it("rejects a cancelled result whose terminal reason is only the status word", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          status: "cancelled",
          summary: "cancelled",
          terminalReason: "cancelled",
          evidence: [{ id: "e1", kind: "observation", detail: "dependency never became available" }],
        }),
      ).success,
    ).toBe(false)
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          status: "cancelled",
          summary: "cancelled",
          terminalReason: "canceled",
          evidence: [{ id: "e1", kind: "observation", detail: "dependency never became available" }],
        }),
      ).success,
    ).toBe(false)
  })

  it("accepts a cancelled result with a meaningful terminal reason", () => {
    expect(
      zSpecialistResult.safeParse(
        validSpecialistResult({
          status: "cancelled",
          summary: "cancelled before start",
          terminalReason: "dependency never became available",
          evidence: [{ id: "e1", kind: "observation", detail: "dependency never became available" }],
        }),
      ).success,
    ).toBe(true)
  })

  it("rejects a read-only specialist result that claims file changes", () => {
    // reviewer holds ["independent_review", "read_only"] — no mutating capability.
    const envelope: SpecialistResultEnvelope = {
      taskId: "task-closure-1",
      assignmentId: "assignment-1",
      specialistId: "reviewer",
      assignedCapabilities: ["independent_review", "read_only"],
      assignedOwnership: [],
      result: validSpecialistResult({
        ownershipUsed: [],
        evidence: [{ id: "e1", kind: "observation", detail: "src/x.ts reviewed; no mutation performed" }],
      }),
    }
    const result = validateSpecialistResultEnvelope(envelope)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems.join(" ")).toContain("no mutating capability")
  })

  it("accepts a mutating specialist result when changes are authorized and evidenced", () => {
    const envelope: SpecialistResultEnvelope = {
      taskId: "task-closure-1",
      assignmentId: "assignment-1",
      specialistId: "backend-coder",
      assignedCapabilities: ["code mutation", "implementation"],
      assignedOwnership: ["src/x.ts"],
      result: validSpecialistResult({
        ownershipUsed: ["src/x.ts"],
        evidence: [{ id: "e1", kind: "test", detail: "src/x.ts: unit test passes" }],
      }),
    }
    expect(validateSpecialistResultEnvelope(envelope).ok).toBe(true)
  })

  it("rejects reported ownership outside the assigned ownership", () => {
    const envelope: SpecialistResultEnvelope = {
      taskId: "task-closure-1",
      assignmentId: "assignment-1",
      specialistId: "backend-coder",
      assignedCapabilities: ["code mutation", "implementation"],
      assignedOwnership: ["src/a.ts"],
      result: validSpecialistResult({
        ownershipUsed: ["src/x.ts"],
        evidence: [{ id: "e1", kind: "test", detail: "src/x.ts: unit test passes" }],
      }),
    }
    const result = validateSpecialistResultEnvelope(envelope)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.problems.join(" ")).toContain("outside the assigned ownership")
  })

  it("rejects a canonical strategy policy reconfigured with multiple specialists", () => {
    // fast_direct canonical maximumSpecialists is 0.
    const mutated = { ...getStrategyPolicy("fast_direct"), maximumSpecialists: 2 }
    const problems = validateCanonicalStrategyPolicy(mutated)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(" ")).toContain("maximumSpecialists")
  })

  it("rejects an audit-only strategy reconfigured to mutate", () => {
    // audit_only canonical requiredCapabilities is ["read_only"].
    const mutated = { ...getStrategyPolicy("audit_only"), requiredCapabilities: ["code mutation"] }
    const problems = validateCanonicalStrategyPolicy(mutated)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(" ")).toContain("requiredCapabilities")
  })

  it("accepts canonical strategies untouched", () => {
    expect(validateCanonicalStrategyPolicy(getStrategyPolicy("fast_direct"))).toEqual([])
    expect(validateCanonicalStrategyPolicy(getStrategyPolicy("audit_only"))).toEqual([])
    expect(validateCanonicalStrategyPolicy(getStrategyPolicy("root_cause_repair"))).toEqual([])
  })

  it("normalizes repeated separators, dot segments, and backslashes", () => {
    expect(normalizeRepositoryRelativePath("src//file.ts")).toBe("src/file.ts")
    expect(normalizeRepositoryRelativePath("src/./file.ts")).toBe("src/file.ts")
    expect(normalizeRepositoryRelativePath("./src/file.ts")).toBe("src/file.ts")
    expect(normalizeRepositoryRelativePath("src\\nested\\file.ts")).toBe("src/nested/file.ts")
    expect(normalizeRepositoryRelativePath("src/file.ts")).toBe("src/file.ts")
  })

  it("rejects absolute, drive, UNC, device, and traversal paths", () => {
    expect(normalizeRepositoryRelativePath("/abs/file.ts")).toBeUndefined()
    expect(normalizeRepositoryRelativePath("C:/file.ts")).toBeUndefined()
    expect(normalizeRepositoryRelativePath("C:\\file.ts")).toBeUndefined()
    expect(normalizeRepositoryRelativePath("//server/share/file.ts")).toBeUndefined()
    expect(normalizeRepositoryRelativePath("//?/device/file.ts")).toBeUndefined()
    expect(normalizeRepositoryRelativePath("src/../file.ts")).toBeUndefined()
    expect(normalizeRepositoryRelativePath("")).toBeUndefined()
    expect(normalizeRepositoryRelativePath("   ")).toBeUndefined()
  })

  it("change refs normalize file paths at parse time (transform contract)", () => {
    const parsed = zChangeRef.safeParse({ file: "./src//x.ts", kind: "modify" })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.file).toBe("src/x.ts")
    expect(zChangeRef.safeParse({ file: "C:/abs.ts", kind: "modify" }).success).toBe(false)
    expect(zChangeRef.safeParse({ file: "src/../escape.ts", kind: "modify" }).success).toBe(false)
  })
})

describe("closure: alias lookup and capability floor are immutable", () => {
  it("CANONICAL_ALIAS_LOOKUP is deeply frozen", () => {
    expect(Object.isFrozen(CANONICAL_ALIAS_LOOKUP)).toBe(true)
    expect(() => {
      ;(CANONICAL_ALIAS_LOOKUP as Record<string, string>)["not-an-agent"] = "heidi"
    }).toThrow(TypeError)
  })

  it("HIGH_RISK_CAPABILITY_FLOOR is deeply frozen", () => {
    expect(Object.isFrozen(HIGH_RISK_CAPABILITY_FLOOR)).toBe(true)
    expect(() => {
      ;(HIGH_RISK_CAPABILITY_FLOOR as string[]).push("unsafe capability")
    }).toThrow(TypeError)
  })

  it("TASK_CLASSES is deeply frozen", () => {
    expect(Object.isFrozen(TASK_CLASSES)).toBe(true)
    expect(() => {
      ;(TASK_CLASSES as unknown as string[]).push("not_a_task_class")
    }).toThrow(TypeError)
  })
})
