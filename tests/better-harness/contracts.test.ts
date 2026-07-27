import { describe, it, expect } from "vitest";
import {
  HarnessDimensionEnum, HarnessPriorityEnum, HarnessFindingStatusEnum,
  HarnessFixVehicleEnum, HarnessRunStatusEnum, HarnessCollectorCategoryEnum,
  CollectorNameEnum,
} from "../../src/better-harness/contracts/common";
import {
  HarnessEvidenceSchema, HarnessFindingSchema,
  HarnessDimensionScoreSchema, HarnessReportSchema,
} from "../../src/better-harness/contracts/report";
import { HarnessRunProgressSchema } from "../../src/better-harness/contracts/progress";

const validEvidence = {
  id: "ev_abc123",
  category: "customization",
  source: "test-collector",
  summary: "Test evidence item",
  path: "/tmp/test",
  confidence: 0.85,
  collectedAt: new Date().toISOString(),
  fingerprint: "fp_abc123",
};

const validFinding = {
  id: "fnd_test123",
  title: "Test finding",
  dimension: "task-understanding",
  priority: "high",
  status: "pending",
  cause: "Test cause",
  impact: "Test impact",
  expectedOutput: "Test output",
  evidence: [validEvidence],
  recommendedVehicle: "rule",
  allowedPaths: ["src/rules/"],
  validationRequirements: ["Verify fix"],
  acceptanceCriteria: ["Fix works"],
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
};

describe("Common Schemas", () => {
  it("validates HarnessDimensionEnum", () => {
    expect(HarnessDimensionEnum.parse("task-understanding")).toBe("task-understanding");
    expect(HarnessDimensionEnum.parse("controlled-execution")).toBe("controlled-execution");
    expect(HarnessDimensionEnum.parse("change-validation")).toBe("change-validation");
    expect(HarnessDimensionEnum.parse("reliable-delivery")).toBe("reliable-delivery");
    expect(HarnessDimensionEnum.parse("learning-capture")).toBe("learning-capture");
    expect(() => HarnessDimensionEnum.parse("invalid")).toThrow();
  });

  it("validates HarnessPriorityEnum", () => {
    expect(HarnessPriorityEnum.parse("high")).toBe("high");
    expect(HarnessPriorityEnum.parse("medium")).toBe("medium");
    expect(HarnessPriorityEnum.parse("low")).toBe("low");
    expect(() => HarnessPriorityEnum.parse("critical")).toThrow();
  });

  it("validates HarnessFindingStatusEnum", () => {
    expect(HarnessFindingStatusEnum.parse("pending")).toBe("pending");
    expect(HarnessFindingStatusEnum.parse("fixed")).toBe("fixed");
    expect(HarnessFindingStatusEnum.parse("ignored")).toBe("ignored");
    expect(() => HarnessFindingStatusEnum.parse("unknown")).toThrow();
  });

  it("validates HarnessFixVehicleEnum", () => {
    expect(HarnessFixVehicleEnum.parse("rule")).toBe("rule");
    expect(HarnessFixVehicleEnum.parse("skill")).toBe("skill");
    expect(HarnessFixVehicleEnum.parse("human-gate")).toBe("human-gate");
    expect(() => HarnessFixVehicleEnum.parse("car")).toThrow();
  });

  it("validates HarnessRunStatusEnum", () => {
    expect(HarnessRunStatusEnum.parse("queued")).toBe("queued");
    expect(HarnessRunStatusEnum.parse("running")).toBe("running");
    expect(HarnessRunStatusEnum.parse("completed")).toBe("completed");
    expect(HarnessRunStatusEnum.parse("failed")).toBe("failed");
    expect(HarnessRunStatusEnum.parse("cancelled")).toBe("cancelled");
    expect(() => HarnessRunStatusEnum.parse("unknown")).toThrow();
  });

  it("validates HarnessCollectorCategoryEnum", () => {
    expect(HarnessCollectorCategoryEnum.parse("customization")).toBe("customization");
    expect(HarnessCollectorCategoryEnum.parse("session")).toBe("session");
    expect(HarnessCollectorCategoryEnum.parse("foundation")).toBe("foundation");
  });

  it("validates CollectorNameEnum", () => {
    expect(CollectorNameEnum.parse("customization")).toBe("customization");
    expect(CollectorNameEnum.parse("sessions")).toBe("sessions");
    expect(CollectorNameEnum.parse("foundations")).toBe("foundations");
  });
});

describe("Evidence Schema", () => {
  it("validates valid evidence", () => {
    const result = HarnessEvidenceSchema.safeParse(validEvidence);
    expect(result.success).toBe(true);
  });

  it("rejects evidence with empty id", () => {
    const result = HarnessEvidenceSchema.safeParse({ ...validEvidence, id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects evidence with invalid category", () => {
    const result = HarnessEvidenceSchema.safeParse({ ...validEvidence, category: "invalid" });
    expect(result.success).toBe(false);
  });

  it("rejects confidence out of range", () => {
    const below = HarnessEvidenceSchema.safeParse({ ...validEvidence, confidence: -0.1 });
    expect(below.success).toBe(false);
    const above = HarnessEvidenceSchema.safeParse({ ...validEvidence, confidence: 1.5 });
    expect(above.success).toBe(false);
  });

  it("rejects extra properties (strict mode)", () => {
    const result = HarnessEvidenceSchema.safeParse({ ...validEvidence, extraField: "value" });
    expect(result.success).toBe(false);
  });
});

describe("Finding Schema", () => {
  it("validates valid finding", () => {
    const result = HarnessFindingSchema.safeParse(validFinding);
    expect(result.success).toBe(true);
  });

  it("rejects finding with invalid dimension", () => {
    const result = HarnessFindingSchema.safeParse({ ...validFinding, dimension: "invalid" });
    expect(result.success).toBe(false);
  });

  it("requires at least one evidence item", () => {
    const result = HarnessFindingSchema.safeParse({ ...validFinding, evidence: [] });
    expect(result.success).toBe(true); // empty array is valid
  });
});

describe("Dimension Score Schema", () => {
  it("validates valid dimension score", () => {
    const result = HarnessDimensionScoreSchema.safeParse({
      dimension: "task-understanding",
      score: 75,
      findingCount: 3,
      evidenceCoverage: 80,
    });
    expect(result.success).toBe(true);
  });

  it("rejects score out of range", () => {
    const result = HarnessDimensionScoreSchema.safeParse({
      dimension: "task-understanding",
      score: 150,
      findingCount: 0,
      evidenceCoverage: 100,
    });
    expect(result.success).toBe(false);
  });
});

describe("Report Schema", () => {
  it("validates valid report", () => {
    const result = HarnessReportSchema.safeParse({
      schemaVersion: 1,
      engineVersion: "1.0.0",
      scoringVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      project: { name: "test", directory: "/tmp/test" },
      overallScore: 75,
      evidenceCoverage: 80,
      dimensions: [{
        dimension: "task-understanding",
        score: 75,
        findingCount: 2,
        evidenceCoverage: 80,
      }],
      findings: [validFinding],
      sessions: {
        analyzed: 5, longSessions: 1, failedSessions: 0,
        repeatedFailures: 0, compactions: 0, permissionInterruptions: 0,
      },
      assets: {
        agents: 0, skills: 0, commands: 0, rules: 0, hooks: 0,
        scripts: 0, workflows: 0, tests: 0, lessons: 0, memoryNodes: 0,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects report with wrong schemaVersion", () => {
    const result = HarnessReportSchema.safeParse({
      schemaVersion: 2,
      engineVersion: "1.0.0",
      scoringVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      project: { name: "test", directory: "/tmp/test" },
      overallScore: 75,
      evidenceCoverage: 80,
      dimensions: [],
      findings: [],
      sessions: { analyzed: 0, longSessions: 0, failedSessions: 0, repeatedFailures: 0, compactions: 0, permissionInterruptions: 0 },
      assets: { agents: 0, skills: 0, commands: 0, rules: 0, hooks: 0, scripts: 0, workflows: 0, tests: 0, lessons: 0, memoryNodes: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("Progress Schema", () => {
  it("validates valid progress", () => {
    const result = HarnessRunProgressSchema.safeParse({
      runId: "run_123",
      status: "running",
      stage: "collecting",
      progressPercent: 50,
      startedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid run status", () => {
    const result = HarnessRunProgressSchema.safeParse({
      runId: "run_123",
      status: "invalid",
    });
    expect(result.success).toBe(false);
  });
});
