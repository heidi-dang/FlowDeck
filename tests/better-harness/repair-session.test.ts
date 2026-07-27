import { describe, it, expect } from "vitest";
import { createRepairSession } from "../../src/better-harness/opencode/repair-session";
import { buildRepairPrompt } from "../../src/better-harness/opencode/repair-prompt";
import { executeValidation } from "../../src/better-harness/opencode/validation-executor";

describe("Repair Session", () => {
  it("creates a repair session with unique ID", () => {
    const finding = {
      id: "fnd_test",
      title: "Test finding",
      dimension: "task-understanding" as const,
      priority: "high" as const,
      status: "pending" as const,
      cause: "Missing config",
      impact: "Cannot validate",
      expectedOutput: "Config exists",
      evidence: [],
      recommendedVehicle: "rule" as const,
      allowedPaths: ["src/rules/"],
      validationRequirements: ["npm test"],
      acceptanceCriteria: ["Tests pass"],
      firstSeenAt: "",
      lastSeenAt: "",
    };
    const result = createRepairSession({ finding, projectPath: "/tmp/test" });
    expect(result.repairSessionId).toMatch(/^repair_/);
    expect(result.prompt).toContain("Missing config");
    expect(result.prompt).toContain("src/rules/");
  });
});

describe("Repair Prompt", () => {
  it("builds prompt with all sections", () => {
    const finding = {
      id: "fnd_test",
      title: "Test",
      dimension: "task-understanding" as const,
      priority: "high" as const,
      status: "pending" as const,
      cause: "Cause",
      impact: "Impact",
      expectedOutput: "Output",
      evidence: [{ id: "e1", category: "customization" as const, source: "src", summary: "Summary", confidence: 0.8, collectedAt: "", fingerprint: "fp" }],
      recommendedVehicle: "rule" as const,
      allowedPaths: ["src/"],
      validationRequirements: ["Check"],
      acceptanceCriteria: ["Done"],
      firstSeenAt: "",
      lastSeenAt: "",
    };
    const prompt = buildRepairPrompt({ finding, projectPath: "/tmp" });
    expect(prompt).toContain("## Finding");
    expect(prompt).toContain("## Expected Output");
    expect(prompt).toContain("## Evidence");
    expect(prompt).toContain("## Validation Requirements");
    expect(prompt).toContain("## Acceptance Criteria");
    expect(prompt).toContain("## Prohibited Changes");
  });

  it("includes previous attempts note", () => {
    const finding = {
      id: "fnd_test",
      title: "Test",
      dimension: "task-understanding" as const,
      priority: "high" as const,
      status: "pending" as const,
      cause: "C", impact: "I", expectedOutput: "O",
      evidence: [],
      recommendedVehicle: "rule" as const,
      allowedPaths: [],
      validationRequirements: [],
      acceptanceCriteria: [],
      firstSeenAt: "",
      lastSeenAt: "",
    };
    const prompt = buildRepairPrompt({ finding, projectPath: "/tmp", previousAttempts: 2 });
    expect(prompt).toContain("attempt #3");
  });
});

describe("Validation Executor", () => {
  it("rejects shell injection patterns", () => {
    const result = executeValidation("ls; rm -rf /", "/tmp");
    expect(result.passed).toBe(false);
    expect(result.error).toContain("shell injection");
  });

  it("rejects path traversal", () => {
    const result = executeValidation("echo ..", "/tmp");
    expect(result.passed).toBe(false);
    expect(result.error).toContain("shell injection");
  });

  it("returns validation result for simple commands", () => {
    const result = executeValidation("echo hello", "/tmp");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });
});
