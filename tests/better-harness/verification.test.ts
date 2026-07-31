import { describe, it, expect } from "bun:test";
import { inspectDiff } from "../../src/better-harness/verification/diff-inspector";
import { detectRegressions } from "../../src/better-harness/verification/regression-detector";
import { generateLearningProposal } from "../../src/better-harness/verification/learning-capture";

describe("Diff Inspector", () => {
  it("marks changes as allowed within allowed paths", () => {
    const result = inspectDiff(
      [{ filePath: "src/rules/new-rule.md", status: "added" as const }],
      ["src/rules/"],
    );
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("detects violations outside allowed paths", () => {
    const result = inspectDiff(
      [{ filePath: "src/config/secret.json", status: "modified" as const }],
      ["src/rules/"],
    );
    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("handles empty changes", () => {
    const result = inspectDiff([], ["src/"]);
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("Regression Detector", () => {
  it("detects regressed findings", () => {
    const previous = [
      { id: "fnd_1", dimension: "task-understanding" as const, status: "fixed" as const, priority: "high" as const, title: "T1", cause: "C", impact: "I", expectedOutput: "O", evidence: [], recommendedVehicle: "rule" as const, allowedPaths: [], validationRequirements: [], acceptanceCriteria: [], firstSeenAt: "", lastSeenAt: "" },
    ];
    const current = [
      { id: "fnd_1", dimension: "task-understanding" as const, status: "pending" as const, priority: "high" as const, title: "T1", cause: "C", impact: "I", expectedOutput: "O", evidence: [], recommendedVehicle: "rule" as const, allowedPaths: [], validationRequirements: [], acceptanceCriteria: [], firstSeenAt: "", lastSeenAt: "" },
    ];
    const result = detectRegressions(previous, current);
    expect(result.regressedFindings).toHaveLength(1);
  });

  it("detects new findings", () => {
    const result = detectRegressions([], [
      { id: "fnd_new", dimension: "task-understanding" as const, status: "pending" as const, priority: "low" as const, title: "T", cause: "C", impact: "I", expectedOutput: "O", evidence: [], recommendedVehicle: "rule" as const, allowedPaths: [], validationRequirements: [], acceptanceCriteria: [], firstSeenAt: "", lastSeenAt: "" },
    ]);
    expect(result.newFindings).toHaveLength(1);
  });

  it("detects resolved findings", () => {
    const previous = [
      { id: "fnd_old", dimension: "task-understanding" as const, status: "fixed" as const, priority: "high" as const, title: "T", cause: "C", impact: "I", expectedOutput: "O", evidence: [], recommendedVehicle: "rule" as const, allowedPaths: [], validationRequirements: [], acceptanceCriteria: [], firstSeenAt: "", lastSeenAt: "" },
    ];
    const result = detectRegressions(previous, []);
    expect(result.resolvedFindings).toHaveLength(1);
  });
});

describe("Learning Capture", () => {
  it("generates learning proposal from finding", () => {
    const finding = {
      id: "fnd_lc",
      title: "Missing lint script",
      dimension: "change-validation" as const,
      priority: "high" as const,
      status: "pending" as const,
      cause: "No lint configured",
      impact: "Quality issues undetected",
      expectedOutput: "Lint script added",
      evidence: [],
      recommendedVehicle: "script" as const,
      allowedPaths: ["package.json"],
      validationRequirements: ["Add linter"],
      acceptanceCriteria: ["Lint passes"],
      firstSeenAt: "",
      lastSeenAt: "",
    };
    const proposal = generateLearningProposal(finding);
    expect(proposal.findingId).toBe("fnd_lc");
    expect(proposal.requiresApproval).toBe(true);
    expect(proposal.recommendedVehicle).toBe("script");
    expect(proposal.targetPath).toBe("scripts/");
  });
});
