import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { captureWorkspaceSnapshot } from "../../src/better-harness/workspace/workspace-snapshot";
import { getProjectIdentity } from "../../src/better-harness/workspace/project-identity";
import { runAllCollectors } from "../../src/better-harness/collectors/collector-runner";
import { analyzeTaskUnderstanding } from "../../src/better-harness/analyzers/task-understanding";
import { analyzeControlledExecution } from "../../src/better-harness/analyzers/controlled-execution";
import { analyzeChangeValidation } from "../../src/better-harness/analyzers/change-validation";
import { analyzeReliableDelivery } from "../../src/better-harness/analyzers/reliable-delivery";
import { analyzeLearningCapture } from "../../src/better-harness/analyzers/learning-capture";
import { synthesizeFindings } from "../../src/better-harness/analyzers/finding-synthesizer";
import { scoreDimension } from "../../src/better-harness/scoring/dimension-scoring";
import { calculateOverallScore } from "../../src/better-harness/scoring/overall-scoring";
import { readSessionRecords } from "../../src/better-harness/opencode/session-reader";
import { analyzeSessions } from "../../src/better-harness/opencode/session-analyzer";
import { createRepairSession } from "../../src/better-harness/opencode/repair-session";
import { verifyFinding } from "../../src/better-harness/verification/finding-verifier";
import { saveRun, loadRun } from "../../src/better-harness/persistence/run-store";
import { EventBus } from "../../src/better-harness/runtime/event-bus";
import { cancelRun, isRunCancelled } from "../../src/better-harness/runtime/run-cancellation";
import { generateEvidenceFingerprint } from "../../src/better-harness/evidence/evidence-fingerprint";
import { deduplicateEvidence } from "../../src/better-harness/evidence/evidence-deduplicator";
import type { HarnessFinding } from "../../src/better-harness/contracts/report";

const TEST_ROOT = join(homedir(), ".flowdeck", "test-e2e-project");

describe("E2E: Full Lifecycle", () => {
  beforeAll(() => {
    // Create test project structure
    if (!existsSync(TEST_ROOT)) mkdirSync(TEST_ROOT, { recursive: true });
    writeFileSync(join(TEST_ROOT, "package.json"), JSON.stringify({
      name: "e2e-test-project",
      scripts: { build: "echo build", test: "echo test" },
    }));
    writeFileSync(join(TEST_ROOT, "tsconfig.json"), "{}");
    writeFileSync(join(TEST_ROOT, "README.md"), "# E2E Test\n");
  });

  afterAll(() => {
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("1. captures workspace snapshot", () => {
    const snapshot = captureWorkspaceSnapshot(TEST_ROOT);
    expect(snapshot.projectId).toBeTruthy();
    expect(snapshot.projectPath).toBe(TEST_ROOT);
    expect(snapshot.languages).toContain("typescript");
  });

  it("2. resolves project identity", () => {
    const identity = getProjectIdentity(TEST_ROOT);
    expect(identity.name).toBe("e2e-test-project");
    expect(identity.directory).toBe(TEST_ROOT);
  });

  it("3. collects evidence from all collectors", async () => {
    const { evidence, collectorResults } = await runAllCollectors(TEST_ROOT);
    expect(evidence.length).toBeGreaterThan(0);
    expect(collectorResults.length).toBe(3);
    // All collectors should succeed
    for (const r of collectorResults) {
      expect(r.error).toBeNull();
    }
  });

  it("4. runs analysis on evidence", async () => {
    const { evidence } = await runAllCollectors(TEST_ROOT);

    const dimensionResults = [
      analyzeTaskUnderstanding(evidence),
      analyzeControlledExecution(evidence),
      analyzeChangeValidation(evidence),
      analyzeReliableDelivery(evidence, TEST_ROOT),
      analyzeLearningCapture(evidence),
    ];

    expect(dimensionResults).toHaveLength(5);
    for (const dr of dimensionResults) {
      expect(dr.dimension).toBeTruthy();
      expect(Array.isArray(dr.findings)).toBe(true);
    }
  });

  it("5. synthesizes findings from dimension results", async () => {
    const { evidence } = await runAllCollectors(TEST_ROOT);
    const dimensionResults = [
      analyzeTaskUnderstanding(evidence),
      analyzeControlledExecution(evidence),
      analyzeChangeValidation(evidence),
      analyzeReliableDelivery(evidence, TEST_ROOT),
      analyzeLearningCapture(evidence),
    ];

    const findings = synthesizeFindings(dimensionResults.map((r) => ({
      dimension: r.dimension,
      findings: r.findings,
    })));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.id).toMatch(/^fnd_/);
      expect(f.dimension).toBeTruthy();
    }
  });

  it("6. scores dimensions and calculates overall", async () => {
    const { evidence } = await runAllCollectors(TEST_ROOT);
    const dimensionResults = [
      analyzeTaskUnderstanding(evidence),
      analyzeControlledExecution(evidence),
      analyzeChangeValidation(evidence),
      analyzeReliableDelivery(evidence, TEST_ROOT),
      analyzeLearningCapture(evidence),
    ];

    const findings = synthesizeFindings(dimensionResults.map((r) => ({
      dimension: r.dimension,
      findings: r.findings,
    })));

    const dimensionScores = dimensionResults.map((dr) =>
      scoreDimension({
        dimension: dr.dimension,
        findings,
        evidenceCoverage: evidence.length > 0 ? Math.min(100, Math.round((evidence.length / 5) * 100)) : 0,
      })
    );

    expect(dimensionScores).toHaveLength(5);
    for (const ds of dimensionScores) {
      expect(ds.score).toBeGreaterThanOrEqual(0);
      expect(ds.score).toBeLessThanOrEqual(100);
    }

    const { overallScore, evidenceCoverage } = calculateOverallScore(dimensionScores);
    expect(overallScore).toBeGreaterThanOrEqual(0);
    expect(evidenceCoverage).toBeGreaterThanOrEqual(0);
  });

  it("7. reads session records (nonexistent dir)", () => {
    const records = readSessionRecords(TEST_ROOT);
    expect(Array.isArray(records)).toBe(true);
    const analysis = analyzeSessions(records);
    expect(analysis.totalSessions).toBe(0);
  });

  it("8. creates repair session from finding", async () => {
    const { evidence } = await runAllCollectors(TEST_ROOT);
    const findings = analyzeChangeValidation(evidence).findings;
    if (findings.length > 0) {
      const result = await createRepairSession({ finding: findings[0] as HarnessFinding, projectPath: TEST_ROOT });
      // Without an OpenCode client, the session creation returns an error
      expect(result.repairSessionId).toBe("");
      expect(result.error).toBeTruthy();
      expect(result.prompt).toContain("## Finding");
    }
  });

  it("9. verifies a finding", () => {
    const finding = {
      id: "fnd_verify",
      title: "Test",
      dimension: "change-validation" as const,
      priority: "high" as const,
      status: "pending" as const,
      cause: "No lint",
      impact: "Quality issues",
      expectedOutput: "Lint added",
      evidence: [],
      recommendedVehicle: "script" as const,
      allowedPaths: ["package.json"],
      validationRequirements: ["echo ok"],
      acceptanceCriteria: ["Done"],
      firstSeenAt: "",
      lastSeenAt: "",
    };
    const verification = verifyFinding(finding, [{ filePath: "package.json", status: "modified" as const }], TEST_ROOT);
    expect(verification.findingId).toBe("fnd_verify");
    expect(verification.status).toBe("fixed");
  });

  it("10. persists run and report", () => {
    const projectId = "e2e-test-project";
    saveRun(projectId, {
      runId: "e2e_run",
      projectId,
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const loaded = loadRun(projectId, "e2e_run");
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("completed");
  });

  it("11. event bus works", () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.subscribe("run.started", (e) => { events.push(e.type); });
    bus.subscribe("report.completed", (e) => { events.push(e.type); });

    bus.emit("run.started", { runId: "test" });
    bus.emit("report.completed", {});

    expect(events).toContain("run.started");
    expect(events).toContain("report.completed");
  });

  it("12. cancellation is idempotent", () => {
    expect(cancelRun("test_run")).toBe(true);
    expect(cancelRun("test_run")).toBe(false); // already cancelled
    expect(isRunCancelled("test_run")).toBe(true);
    expect(isRunCancelled("nonexistent")).toBe(false);
  });

  it("13. deduplicates evidence", () => {
    const fp = generateEvidenceFingerprint("customization", "a", "b");
    const result = deduplicateEvidence([
      { id: "e1", category: "customization" as const, source: "a", summary: "b", confidence: 0.5, collectedAt: "", fingerprint: fp },
      { id: "e2", category: "customization" as const, source: "a", summary: "b", confidence: 0.9, collectedAt: "", fingerprint: fp },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
  });
});
