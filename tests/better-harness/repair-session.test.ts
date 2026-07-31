import { describe, it, expect } from "bun:test";
import os from "os";
import { createRepairSession } from "../../src/better-harness/opencode/repair-session";
import { buildRepairPrompt } from "../../src/better-harness/opencode/repair-prompt";
import { executeValidation } from "../../src/better-harness/opencode/validation-executor";

describe("Repair Session", () => {
  it("creates a repair session with unique ID", async () => {
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
    const result = await createRepairSession({ finding, projectPath: os.tmpdir() });
    expect(result.opencodeSessionId).toBe("");
    expect(result.error).toBeTruthy();
    expect(result.prompt).toContain("Missing config");
    expect(result.prompt).toContain("src/rules/");
  });
});

describe("generateRestrictedRepairPrompt", () => {
  it("supports options-object call and positional call producing identical output", async () => {
    const { generateRestrictedRepairPrompt } = await import(
      "../../src/better-harness/opencode/repair-session"
    );

    const cause = "Missing config";
    const evidence = ["Config file not found", "Entry missing"];
    const expectedOutput = "Config should exist";
    const allowedPaths = ["src/config/"];
    const validationRequirements = ["npm test"];
    const acceptanceCriteria = ["Tests pass"];

    const promptPositional = generateRestrictedRepairPrompt(
      cause,
      evidence,
      expectedOutput,
      allowedPaths,
      validationRequirements,
      acceptanceCriteria,
    );

    const promptOptions = generateRestrictedRepairPrompt({
      cause,
      evidence,
      expectedOutput,
      allowedPaths,
      validationRequirements,
      acceptanceCriteria,
    });

    expect(promptPositional).toBe(promptOptions);
  });

  it("preserves section headings and ordering", async () => {
    const { generateRestrictedRepairPrompt } = await import(
      "../../src/better-harness/opencode/repair-session"
    );

    const prompt = generateRestrictedRepairPrompt({
      cause: "Root cause",
      evidence: ["ev1"],
      expectedOutput: "exp",
      allowedPaths: ["path1"],
      validationRequirements: ["val1"],
      acceptanceCriteria: ["acc1"],
    });

    const causeIdx = prompt.indexOf("## Cause");
    const evidenceIdx = prompt.indexOf("## Evidence");
    const expectedIdx = prompt.indexOf("## Expected Output");
    const prohibitedIdx = prompt.indexOf("## Prohibited Changes");
    const validationIdx = prompt.indexOf("## Validation Requirements");
    const acceptanceIdx = prompt.indexOf("## Acceptance Criteria");

    expect(causeIdx).toBeGreaterThan(-1);
    expect(evidenceIdx).toBeGreaterThan(causeIdx);
    expect(expectedIdx).toBeGreaterThan(evidenceIdx);
    expect(prohibitedIdx).toBeGreaterThan(expectedIdx);
    expect(validationIdx).toBeGreaterThan(prohibitedIdx);
    expect(acceptanceIdx).toBeGreaterThan(validationIdx);
  });

  it("handles empty arrays and empty strings properly", async () => {
    const { generateRestrictedRepairPrompt } = await import(
      "../../src/better-harness/opencode/repair-session"
    );

    const prompt = generateRestrictedRepairPrompt({
      cause: "",
      evidence: [],
      expectedOutput: "",
      allowedPaths: [],
      validationRequirements: [],
      acceptanceCriteria: [],
    });

    expect(prompt).toContain("## Cause\n\n");
    expect(prompt).toContain("## Evidence\n\n");
    expect(prompt).toContain("## Expected Output\n\n");
    expect(prompt).toContain("You are restricted to the following paths: \n");
  });

  it("does not mutate input arrays", async () => {
    const { generateRestrictedRepairPrompt } = await import(
      "../../src/better-harness/opencode/repair-session"
    );

    const evidence = ["ev1", "ev2"];
    const allowedPaths = ["path1"];
    const validationRequirements = ["val1"];
    const acceptanceCriteria = ["acc1"];

    const evidenceCopy = [...evidence];
    const allowedPathsCopy = [...allowedPaths];
    const validationRequirementsCopy = [...validationRequirements];
    const acceptanceCriteriaCopy = [...acceptanceCriteria];

    generateRestrictedRepairPrompt({
      cause: "cause",
      evidence,
      expectedOutput: "exp",
      allowedPaths,
      validationRequirements,
      acceptanceCriteria,
    });

    expect(evidence).toEqual(evidenceCopy);
    expect(allowedPaths).toEqual(allowedPathsCopy);
    expect(validationRequirements).toEqual(validationRequirementsCopy);
    expect(acceptanceCriteria).toEqual(acceptanceCriteriaCopy);
  });

  it("is deterministic across multiple invocations", async () => {
    const { generateRestrictedRepairPrompt } = await import(
      "../../src/better-harness/opencode/repair-session"
    );

    const opts = {
      cause: "cause",
      evidence: ["e1"],
      expectedOutput: "output",
      allowedPaths: ["src/"],
      validationRequirements: ["v1"],
      acceptanceCriteria: ["a1"],
    };

    const run1 = generateRestrictedRepairPrompt(opts);
    const run2 = generateRestrictedRepairPrompt(opts);

    expect(run1).toBe(run2);
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
    const prompt = buildRepairPrompt({ finding, projectPath: os.tmpdir() });
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
    const prompt = buildRepairPrompt({ finding, projectPath: os.tmpdir(), previousAttempts: 2 });
    expect(prompt).toContain("attempt #3");
  });
});

describe("Validation Executor", () => {
  it("rejects shell injection patterns", () => {
    const result = executeValidation("ls; rm -rf /", os.tmpdir());
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Command rejected");
  });

  it("rejects path traversal", () => {
    // echo is not a permitted executable, so it is rejected at parse time
    const result = executeValidation("echo ..", os.tmpdir());
    expect(result.passed).toBe(false);
    expect(result.error).toContain("Command rejected");
  });

  it("returns validation result for simple commands", () => {
    const result = executeValidation("node --version", os.tmpdir());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("v");
  });
});
