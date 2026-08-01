import { describe, it, expect } from "bun:test";
import {
  // task.ts
  SCORE_MIN,
  SCORE_MAX,
  isScoreInRange,
  isValidTaskClass,
  isValidExecutionStrategy,
  zTaskClass,
  zTaskScores,
  zClassificationInput,
  zClassificationResult,
  // strategy.ts
  EXECUTION_STRATEGIES,
  zExecutionStrategy,
  zStrategyPolicy,
  DEFAULT_STRATEGY_POLICIES,
  getStrategyPolicy,
  // agents.ts
  zSpecialistResult,
  zDelegationReason,
  zDelegationDecision,
  zWorkNodeType,
  zWorkNode,
  zLatencyClass,
  specialistResultHasRequiredEvidence,
  // type-only imports (agents.ts)
  SpecialistResult,
  SpecialistStatus,
  // models.ts
  MODEL_TIERS,
  MODEL_TIER_RANK,
  isValidModelTier,
  tierMeetsFloor,
  zModelTier,
  zModelRoutingInput,
  zModelSelectionDecision,
  // index.ts
  ROUTING_POLICY_VERSION,
  ROUTING_WEIGHTS_VERSION,
  canonicalJson,
  parseCanonicalJson,
  zRoutingDecisionRecord,
  validateRoutingDecisionRecord,
  bindDecisionToSha,
  type RoutingDecisionRecord,
} from "@/orchestration/routing/contracts";

function makeValidSpecialistResult(status: SpecialistStatus = "completed"): SpecialistResult {
  return {
    status,
    summary: "Fixed the failing test",
    findings: [
      { id: "f1", summary: "root cause identified", severity: "warning", location: "src/x.ts" },
    ],
    changes: [{ file: "src/x.ts", kind: "modify", symbol: "foo" }],
    evidence: [{ id: "e1", kind: "test", detail: "unit test passes" }],
    assumptions: ["assumes network is available"],
    unresolvedRisks: [],
    confidence: 90,
    recommendedNextAction: "run full suite",
    ownershipUsed: ["src/x.ts"],
    tokens: { input: 1000, output: 400 },
    durationMs: 1234,
  };
}

const VALID_SHA = "0123456789abcdef0123456789abcdef01234567";

function makeValidRecord(): RoutingDecisionRecord {
  return bindDecisionToSha({
    taskId: "task-1",
    decisionId: "dec-42",
    repositorySha: VALID_SHA,
    weightsVersion: ROUTING_WEIGHTS_VERSION,
    inputEvidence: [{ signal: "expectedFileCount", value: 3, source: "prompt" }],
    rulesApplied: ["rule:classify"],
    modelFallbackUsed: false,
    classification: {
      taskClass: "local_bug",
      confidence: 92,
      evidence: [{ id: "e1", source: "classifier", detail: "stack trace found" }],
      usedModelFallback: false,
      policyVersion: "1.0.0",
    },
    scores: { complexity: 40, ambiguity: 30, risk: 25, confidence: 80 },
    selectedStrategy: "root_cause_repair",
    rejectedStrategies: [{ strategy: "audit_only", reason: "task is mutating" }],
    specialistCandidates: ["debug-specialist"],
    delegationDecisions: [
      {
        taskId: "task-1",
        delegatingAgent: "orchestrator",
        targetAgent: "debug-specialist",
        depth: 1,
        allowed: true,
        reason: "specialist_expertise",
        justification: ["stack trace present in prompt"],
      },
    ],
    modelCandidates: [{ tier: "strong_reasoning", reason: "debugging requires strong reasoning" }],
    selectedTier: "strong_reasoning",
    fallback: ["general_coding", "small_fast"],
    confidence: 90,
  });
}

describe("routing contracts: runtime validation", () => {
  it("accepts a valid ClassificationResult", () => {
    const result = zClassificationResult.safeParse({
      taskClass: "local_bug",
      confidence: 92,
      evidence: [{ id: "e1", source: "scorer:stacktrace", detail: "stack trace found" }],
      usedModelFallback: false,
      policyVersion: "1.0.0",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid TaskScores record", () => {
    const result = zTaskScores.safeParse({
      complexity: 40,
      ambiguity: 30,
      risk: 25,
      confidence: 80,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid StrategyPolicy", () => {
    const policy = getStrategyPolicy("parallel_implementation");
    const result = zStrategyPolicy.safeParse(policy);
    expect(result.success).toBe(true);
  });

  it("accepts a valid SpecialistResult", () => {
    const result = zSpecialistResult.safeParse(makeValidSpecialistResult());
    expect(result.success).toBe(true);
  });

  it("accepts a valid DelegationDecision", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "task-1",
      delegatingAgent: "orchestrator",
      targetAgent: "backend-coder",
      depth: 1,
      allowed: true,
      reason: "specialist_expertise",
      justification: ["backend ownership"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid WorkNode", () => {
    const result = zWorkNode.safeParse({
      id: "n1",
      type: "implement",
      dependencies: ["n0"],
      fileOwnership: ["src/a.ts"],
      requiredCapabilities: ["planning"],
      estimatedTokens: 1000,
      estimatedDurationMs: 5000,
      priority: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid ModelSelectionDecision", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "strong_reasoning",
      provider: "anthropic",
      model: "claude-opus",
      confidence: 90,
      reasonCodes: ["complex"],
      fallbackTiers: ["general_coding", "small_fast"],
      timeoutPolicy: { queueMs: 500, firstTokenMs: 10000, totalMs: 120000 },
      capabilityFloor: ["GitHub inspection"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid RoutingDecisionRecord", () => {
    const record = makeValidRecord();
    const result = zRoutingDecisionRecord.safeParse(record);
    expect(result.success).toBe(true);
  });

  it("accepts a valid ModelRoutingInput", () => {
    const result = zModelRoutingInput.safeParse({
      taskId: "task-1",
      taskClass: "ui_feature",
      scores: { complexity: 50, ambiguity: 30, risk: 20, confidence: 80 },
      capabilityFloor: ["UI implementation"],
      strategy: "parallel_implementation",
      timeoutPolicy: { queueMs: 500, firstTokenMs: 10000, totalMs: 120000 },
      providerHealth: { anthropic: 90, openai: 85 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid TaskClass enum value", () => {
    expect(zTaskClass.safeParse("not_a_class").success).toBe(false);
    expect(isValidTaskClass("not_a_class")).toBe(false);
  });

  it("rejects an invalid ExecutionStrategy enum value", () => {
    expect(zExecutionStrategy.safeParse("not_a_strategy").success).toBe(false);
    expect(isValidExecutionStrategy("planned_execution")).toBe(true);
  });

  it("rejects an invalid ModelTier enum value", () => {
    expect(zModelTier.safeParse("junk_tier").success).toBe(false);
    expect(isValidModelTier("junk_tier")).toBe(false);
  });

  it("rejects an invalid SpecialistStatus ('completedx')", () => {
    const result = zSpecialistResult.safeParse({
      ...makeValidSpecialistResult(),
      status: "completedx",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid WorkNodeType enum value", () => {
    expect(zWorkNodeType.safeParse("not_a_type").success).toBe(false);
    const node = {
      id: "n1",
      type: "nope",
      dependencies: [],
      fileOwnership: [],
      requiredCapabilities: [],
      estimatedTokens: 0,
      estimatedDurationMs: 0,
      priority: 0,
    };
    expect(zWorkNode.safeParse(node).success).toBe(false);
  });

  it("rejects an invalid DelegationReason enum value", () => {
    expect(zDelegationReason.safeParse("not_a_reason").success).toBe(false);
  });

  it("rejects an invalid LatencyClass enum value", () => {
    expect(zLatencyClass.safeParse("instantx").success).toBe(false);
  });

  it("rejects out-of-range and non-integer scores in zTaskScores", () => {
    const base = { ambiguity: 50, risk: 50, confidence: 50 };
    expect(zTaskScores.safeParse({ ...base, complexity: -1 }).success).toBe(false);
    expect(zTaskScores.safeParse({ ...base, complexity: 101 }).success).toBe(false);
    expect(zTaskScores.safeParse({ ...base, complexity: 1.5 }).success).toBe(false);
  });

  it("rejects ambiguityLevel above 100 in zClassificationInput", () => {
    expect(zClassificationInput.safeParse({ ambiguityLevel: 101 }).success).toBe(false);
  });

  it("rejects a negative expectedFileCount in zClassificationInput", () => {
    expect(zClassificationInput.safeParse({ expectedFileCount: -1 }).success).toBe(false);
  });

  it("accepts an empty {} ClassificationInput (all fields optional)", () => {
    const result = zClassificationInput.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("routing contracts: unknown fields are stripped", () => {
  it("strips unknown keys from TaskScores without failing", () => {
    const result = zTaskScores.safeParse({
      complexity: 10,
      ambiguity: 10,
      risk: 10,
      confidence: 10,
      extra: "should be stripped",
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.extra).toBeUndefined();
    expect("extra" in data).toBe(false);
  });

  it("strips unknown keys from WorkNode without failing", () => {
    const result = zWorkNode.safeParse({
      id: "n1",
      type: "inspect",
      dependencies: [],
      fileOwnership: [],
      requiredCapabilities: [],
      estimatedTokens: 0,
      estimatedDurationMs: 0,
      priority: 0,
      unrelated: 42,
    });
    expect(result.success).toBe(true);
    expect("unrelated" in (result.data as Record<string, unknown>)).toBe(false);
  });

  it("strips unknown keys from ModelSelectionDecision without failing", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "small_fast",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: [],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: [],
      bogusKey: true,
    });
    expect(result.success).toBe(true);
    expect("bogusKey" in (result.data as Record<string, unknown>)).toBe(false);
  });
});

describe("routing contracts: score boundaries", () => {
  it("accepts the inclusive bounds 0 and 100", () => {
    expect(isScoreInRange(0)).toBe(true);
    expect(isScoreInRange(100)).toBe(true);
    expect(SCORE_MIN).toBe(0);
    expect(SCORE_MAX).toBe(100);
  });

  it("rejects values just outside the range", () => {
    expect(isScoreInRange(-0.01)).toBe(false);
    expect(isScoreInRange(100.01)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isScoreInRange(NaN)).toBe(false);
  });
});

describe("routing contracts: required evidence", () => {
  it("returns false for a completed result with empty evidence and summary", () => {
    const r = makeValidSpecialistResult("completed");
    r.evidence = [];
    r.summary = "";
    expect(specialistResultHasRequiredEvidence(r)).toBe(false);
  });

  it("returns true for a completed result with summary and evidence", () => {
    expect(specialistResultHasRequiredEvidence(makeValidSpecialistResult("completed"))).toBe(true);
  });

  it("returns false for a non-completed terminal status with neither summary nor evidence", () => {
    for (const status of ["blocked", "failed", "cancelled"] as const) {
      const r = makeValidSpecialistResult(status);
      r.evidence = [];
      r.summary = "";
      expect(specialistResultHasRequiredEvidence(r)).toBe(false);
    }
  });

  it("returns true for a non-completed terminal status with evidence but no summary", () => {
    for (const status of ["blocked", "failed", "cancelled"] as const) {
      const r = makeValidSpecialistResult(status);
      r.evidence = [{ id: "e1", kind: "log", detail: "reason logged" }];
      r.summary = "";
      expect(specialistResultHasRequiredEvidence(r)).toBe(true);
    }
  });

  it("returns true for a non-completed terminal status with a summary but no evidence", () => {
    for (const status of ["blocked", "failed", "cancelled"] as const) {
      const r = makeValidSpecialistResult(status);
      r.evidence = [];
      r.summary = "blocked on credentials";
      expect(specialistResultHasRequiredEvidence(r)).toBe(true);
    }
  });
});

describe("routing contracts: policy version", () => {
  it("is a non-empty semver-like string", () => {
    expect(typeof ROUTING_POLICY_VERSION).toBe("string");
    expect(ROUTING_POLICY_VERSION.length).toBeGreaterThan(0);
    expect(ROUTING_POLICY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("routing contracts: SHA binding (provenance)", () => {
  it("stamps the full provenance fields on the record", () => {
    const record = makeValidRecord();
    expect(record.taskId).toBe("task-1");
    expect(record.decisionId).toBe("dec-42");
    expect(record.repositorySha).toBe(VALID_SHA);
    expect(record.routingPolicyVersion).toBe(ROUTING_POLICY_VERSION);
    expect(record.weightsVersion).toBe(ROUTING_WEIGHTS_VERSION);
    expect(record.inputEvidence).toEqual([
      { signal: "expectedFileCount", value: 3, source: "prompt" },
    ]);
    expect(record.selectedStrategy).toBe("root_cause_repair");
    expect(record.selectedTier).toBe("strong_reasoning");
  });

  it("uses a valid ISO-8601 timestamp", () => {
    const record = makeValidRecord();
    expect(typeof record.timestamp).toBe("string");
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
  });

  it("validateRoutingDecisionRecord accepts a bound record", () => {
    const record = makeValidRecord();
    const result = validateRoutingDecisionRecord(record);
    expect(result.ok).toBe(true);
  });

  it("validateRoutingDecisionRecord rejects a record missing repositorySha", () => {
    const record = makeValidRecord();
    const { repositorySha: _repositorySha, ...rest } = record;
    const result = validateRoutingDecisionRecord(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("repositorySha");
    }
  });

  it("validateRoutingDecisionRecord rejects a record with a wrong-typed inputEvidence array", () => {
    const record = makeValidRecord();
    const result = validateRoutingDecisionRecord({
      ...record,
      inputEvidence: [{ not: "evidence" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("inputEvidence");
    }
  });

  it("record round-trips through parseCanonicalJson(canonicalJson(record))", () => {
    const record = makeValidRecord();
    const roundTripped = parseCanonicalJson(canonicalJson(record));
    expect(roundTripped).toEqual(record);
  });
});

describe("routing contracts: deterministic serialization", () => {
  it("is independent of object key insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("omits undefined-valued keys", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(canonicalJson({ b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("sorts nested object keys recursively", () => {
    const nested = canonicalJson({ b: { d: 1, c: 2 }, a: 3 });
    expect(nested).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it("throws on circular references", () => {
    const x: any = {};
    x.self = x;
    expect(() => canonicalJson(x)).toThrow();
    expect(() => canonicalJson(x)).toThrow("non-serializable value");
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalJson({ n: NaN })).toThrow();
    expect(() => canonicalJson({ n: Infinity })).toThrow();
  });

  it("throws on bigint values", () => {
    expect(() => canonicalJson(1n as unknown)).toThrow();
    expect(() => canonicalJson(1n as unknown)).toThrow("non-serializable value");
  });

  it("serializes Date values as ISO strings", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(canonicalJson({ d })).toBe(canonicalJson({ d: "2026-01-01T00:00:00.000Z" }));
    expect(canonicalJson({ d })).toBe('{"d":"2026-01-01T00:00:00.000Z"}');
  });

  it("round-trips a nested object through parseCanonicalJson", () => {
    const original = { a: { b: [1, 2, { c: 3 }], d: "x" }, e: true, f: null };
    const restored = parseCanonicalJson(canonicalJson(original));
    expect(restored).toEqual(original);
  });
});

describe("routing contracts: strategy registry integrity", () => {
  it("defines exactly the 9 canonical execution strategies", () => {
    expect(Object.keys(DEFAULT_STRATEGY_POLICIES)).toHaveLength(9);
    expect(EXECUTION_STRATEGIES).toHaveLength(9);
    for (const strategy of EXECUTION_STRATEGIES) {
      expect(DEFAULT_STRATEGY_POLICIES[strategy]).toBeDefined();
    }
  });

  it("getStrategyPolicy returns a policy whose strategy matches the key", () => {
    for (const strategy of EXECUTION_STRATEGIES) {
      const policy = getStrategyPolicy(strategy);
      expect(policy.strategy).toBe(strategy);
    }
  });

  it("every default policy passes zStrategyPolicy", () => {
    for (const strategy of EXECUTION_STRATEGIES) {
      const parsed = zStrategyPolicy.safeParse(DEFAULT_STRATEGY_POLICIES[strategy]);
      expect(parsed.success).toBe(true);
    }
  });

  it("every default policy uses a valid ModelTier", () => {
    for (const strategy of EXECUTION_STRATEGIES) {
      const tier = DEFAULT_STRATEGY_POLICIES[strategy].modelTier;
      expect(isValidModelTier(tier)).toBe(true);
    }
  });

  it("every policy has maximumSpecialists >= 0", () => {
    for (const strategy of EXECUTION_STRATEGIES) {
      expect(DEFAULT_STRATEGY_POLICIES[strategy].maximumSpecialists).toBeGreaterThanOrEqual(0);
    }
  });

  it("fast_direct permits zero specialists", () => {
    expect(DEFAULT_STRATEGY_POLICIES.fast_direct.maximumSpecialists).toBe(0);
  });

  it("audit strategies require at least one reviewer", () => {
    expect(DEFAULT_STRATEGY_POLICIES.audit_only.requiredReviewers).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_STRATEGY_POLICIES.repair_and_independent_audit.requiredReviewers).toBeGreaterThanOrEqual(1);
  });

  it("audit_only never allows the execute stage", () => {
    expect(DEFAULT_STRATEGY_POLICIES.audit_only.allowedStates).not.toContain("execute");
  });
});

describe("routing contracts: model tier ordering", () => {
  it("ranks small_fast < general_coding < strong_reasoning", () => {
    expect(MODEL_TIER_RANK.small_fast).toBeLessThan(MODEL_TIER_RANK.general_coding);
    expect(MODEL_TIER_RANK.general_coding).toBeLessThan(MODEL_TIER_RANK.strong_reasoning);
  });

  it("MODEL_TIERS contains exactly the 3 canonical tiers", () => {
    expect(MODEL_TIERS).toHaveLength(3);
    expect(MODEL_TIERS).toEqual(["small_fast", "general_coding", "strong_reasoning"]);
  });

  it("tierMeetsFloor returns true when tier is at or above the floor", () => {
    expect(tierMeetsFloor("general_coding", "small_fast")).toBe(true);
    expect(tierMeetsFloor("strong_reasoning", "strong_reasoning")).toBe(true);
  });

  it("tierMeetsFloor returns false when tier is below the floor", () => {
    expect(tierMeetsFloor("small_fast", "strong_reasoning")).toBe(false);
  });

  it("isValidModelTier rejects junk values", () => {
    expect(isValidModelTier("junk")).toBe(false);
    expect(isValidModelTier(undefined)).toBe(false);
    expect(isValidModelTier(42)).toBe(false);
  });
});

describe("routing contracts: validation error quality", () => {
  it("returns ok:false with a field path in the message for missing fields", () => {
    const result = validateRoutingDecisionRecord({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("repositorySha");
      expect(result.error).toMatch(/repositorySha/);
    }
  });
});

describe("routing contracts: delegation cross-field invariants (D7)", () => {
  it("rejects an allowed decision without a reason", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "task-1",
      delegatingAgent: "orchestrator",
      targetAgent: "backend-coder",
      depth: 1,
      allowed: true,
      justification: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a rejected decision without a rejection reason", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "task-1",
      delegatingAgent: "orchestrator",
      targetAgent: "backend-coder",
      depth: 1,
      allowed: false,
      justification: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an allowed decision that also carries a rejection reason", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "task-1",
      delegatingAgent: "orchestrator",
      targetAgent: "backend-coder",
      depth: 1,
      allowed: true,
      reason: "specialist_expertise",
      rejectionReason: "rejected_trivial",
      justification: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects self-delegation", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "task-1",
      delegatingAgent: "orchestrator",
      targetAgent: "orchestrator",
      depth: 0,
      allowed: true,
      reason: "specialist_expertise",
      justification: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a delegation depth above 1", () => {
    const result = zDelegationDecision.safeParse({
      taskId: "task-1",
      delegatingAgent: "orchestrator",
      targetAgent: "backend-coder",
      depth: 2,
      allowed: true,
      reason: "specialist_expertise",
      justification: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("routing contracts: identifier and SHA strictness (D16)", () => {
  it("rejects empty and whitespace-only identifiers", () => {
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), taskId: "" }).success).toBe(false);
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), taskId: "   " }).success).toBe(false);
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), decisionId: "" }).success).toBe(false);
  });

  it("rejects a repositorySha that is not 40-hex", () => {
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), repositorySha: "abc123" }).success).toBe(false);
    expect(zRoutingDecisionRecord.safeParse({ ...makeValidRecord(), repositorySha: "G".repeat(40) }).success).toBe(false);
  });
});

describe("routing contracts: capability floor invariants (D8/D9)", () => {
  it("rejects a selected tier below the capability floor", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "small_fast",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: [],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: ["security audit"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate fallback tiers", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "strong_reasoning",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: ["general_coding", "general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects fallback tiers not ordered strongest-first", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "strong_reasoning",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: ["small_fast", "general_coding"],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a capability floor containing an unknown capability", () => {
    const result = zModelSelectionDecision.safeParse({
      tier: "strong_reasoning",
      confidence: 60,
      reasonCodes: [],
      fallbackTiers: [],
      timeoutPolicy: { queueMs: 0, firstTokenMs: 0, totalMs: 0 },
      capabilityFloor: ["not_a_real_capability"],
    });
    expect(result.success).toBe(false);
  });
});
