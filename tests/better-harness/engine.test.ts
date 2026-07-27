import { describe, it, expect } from "vitest";
import { generateEvidenceFingerprint } from "../../src/better-harness/evidence/evidence-fingerprint";
import { normalizeEvidence } from "../../src/better-harness/evidence/evidence-normalizer";
import { deduplicateEvidence } from "../../src/better-harness/evidence/evidence-deduplicator";
import { scoreDimension } from "../../src/better-harness/scoring/dimension-scoring";
import { calculateOverallScore, getScoreTrend } from "../../src/better-harness/scoring/overall-scoring";
import { SCORING_VERSION, formatScoreWithVersion } from "../../src/better-harness/scoring/scoring-version";

describe("Evidence Fingerprint", () => {
  it("generates same fingerprint for same inputs", () => {
    const a = generateEvidenceFingerprint("customization", "test.ts", "Found test file");
    const b = generateEvidenceFingerprint("customization", "test.ts", "Found test file");
    expect(a).toBe(b);
  });

  it("generates different fingerprints for different inputs", () => {
    const a = generateEvidenceFingerprint("customization", "a.ts", "First");
    const b = generateEvidenceFingerprint("foundation", "b.ts", "Second");
    expect(a).not.toBe(b);
  });

  it("is case-insensitive", () => {
    const a = generateEvidenceFingerprint("CUSTOMIZATION", "TEST.TS", "FOUND");
    const b = generateEvidenceFingerprint("customization", "test.ts", "found");
    expect(a).toBe(b);
  });

  it("returns 32-char hex string", () => {
    const fp = generateEvidenceFingerprint("a", "b", "c");
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("Evidence Normalizer", () => {
  it("normalizes raw evidence", () => {
    const result = normalizeEvidence([{
      category: "customization",
      source: "test.ts",
      summary: "Test evidence",
      confidence: 0.9,
    }]);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("customization");
    expect(result[0].id).toMatch(/^ev_/);
    expect(result[0].fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it("clamps confidence to 0-1", () => {
    const result = normalizeEvidence([{
      category: "customization",
      source: "test",
      summary: "test",
      confidence: 5.0,
    }]);
    expect(result[0].confidence).toBe(1.0);
  });

  it("generates valid timestamps", () => {
    const result = normalizeEvidence([{
      category: "foundation",
      source: "test",
      summary: "test",
      confidence: 0.5,
    }]);
    expect(() => new Date(result[0].collectedAt)).not.toThrow();
  });
});

describe("Evidence Deduplicator", () => {
  it("deduplicates by fingerprint, keeping highest confidence", () => {
    const evidence = [
      { id: "ev_1", category: "customization" as const, source: "a", summary: "test", confidence: 0.5, collectedAt: "", fingerprint: "fp1" },
      { id: "ev_2", category: "customization" as const, source: "a", summary: "test", confidence: 0.9, collectedAt: "", fingerprint: "fp1" },
    ];
    const result = deduplicateEvidence(evidence as any);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
  });

  it("keeps distinct fingerprints separate", () => {
    const evidence = [
      { id: "ev_1", category: "customization" as const, source: "a", summary: "test", confidence: 0.8, collectedAt: "", fingerprint: "fp1" },
      { id: "ev_2", category: "foundation" as const, source: "b", summary: "other", confidence: 0.7, collectedAt: "", fingerprint: "fp2" },
    ];
    const result = deduplicateEvidence(evidence as any);
    expect(result).toHaveLength(2);
  });
});

describe("Dimension Scoring", () => {
  it("scores 100 with no findings", () => {
    const result = scoreDimension({
      dimension: "task-understanding",
      findings: [],
      evidenceCoverage: 100,
    });
    expect(result.score).toBe(100);
    expect(result.findingCount).toBe(0);
  });

  it("deducts for high priority findings", () => {
    const findings = Array.from({ length: 3 }, (_, i) => ({
      id: `fnd_${i}`, title: "", dimension: "task-understanding" as const,
      priority: "high" as const, status: "pending" as const,
      cause: "", impact: "", expectedOutput: "",
      evidence: [], recommendedVehicle: "rule" as const,
      allowedPaths: [], validationRequirements: [], acceptanceCriteria: [],
      firstSeenAt: "", lastSeenAt: "",
    }));
    const result = scoreDimension({
      dimension: "task-understanding",
      findings: findings as any,
      evidenceCoverage: 100,
    });
    expect(result.score).toBe(100 - 3 * 18); // 46
  });

  it("clamps score to 0-100", () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({
      id: `fnd_${i}`, title: "", dimension: "controlled-execution" as const,
      priority: "high" as const, status: "pending" as const,
      cause: "", impact: "", expectedOutput: "",
      evidence: [], recommendedVehicle: "rule" as const,
      allowedPaths: [], validationRequirements: [], acceptanceCriteria: [],
      firstSeenAt: "", lastSeenAt: "",
    }));
    const result = scoreDimension({
      dimension: "controlled-execution",
      findings: findings as any,
      evidenceCoverage: 100,
    });
    expect(result.score).toBe(0);
  });

  it("applies evidence coverage penalty", () => {
    const low = scoreDimension({
      dimension: "task-understanding",
      findings: [],
      evidenceCoverage: 20,
    });
    const high = scoreDimension({
      dimension: "task-understanding",
      findings: [],
      evidenceCoverage: 80,
    });
    expect(low.score).toBeLessThan(high.score);
  });
});

describe("Overall Scoring", () => {
  it("calculates weighted mean", () => {
    const { overallScore, evidenceCoverage: _evidenceCoverage } = calculateOverallScore([
      { dimension: "task-understanding" as const, score: 100, findingCount: 0, evidenceCoverage: 100 },
      { dimension: "controlled-execution" as const, score: 100, findingCount: 0, evidenceCoverage: 100 },
      { dimension: "reliable-delivery" as const, score: 100, findingCount: 0, evidenceCoverage: 100 },
    ]);
    expect(overallScore).toBe(100);
  });

  it("returns 0 for empty scores", () => {
    const { overallScore } = calculateOverallScore([]);
    expect(overallScore).toBe(0);
  });
});

describe("Score Trend", () => {
  it("detects improvement", () => {
    expect(getScoreTrend(80, 70)).toBe("improvement");
  });

  it("detects decline", () => {
    expect(getScoreTrend(60, 80)).toBe("decline");
  });

  it("detects stable", () => {
    expect(getScoreTrend(75, 76)).toBe("stable");
  });

  it("detects first-run", () => {
    expect(getScoreTrend(75, undefined)).toBe("first-run");
  });
});

describe("Scoring Version", () => {
  it("has correct version", () => {
    expect(SCORING_VERSION).toBe("1.0.0");
  });

  it("formats score with version", () => {
    const result = formatScoreWithVersion(85);
    expect(result.score).toBe(85);
    expect(result.scoringVersion).toBe("1.0.0");
  });
});


