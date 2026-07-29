import { describe, it, expect } from "bun:test";
import { join } from "path";
import { getProjectStoreDir, atomicWriteFile, readJsonFile } from "../../src/better-harness/persistence/harness-store";
import { saveRun, loadRun } from "../../src/better-harness/persistence/run-store";
import { saveIgnoredFinding, loadIgnoredFindings } from "../../src/better-harness/persistence/ignored-finding-store";
import { saveRepairSession, loadRepairSession } from "../../src/better-harness/persistence/repair-session-store";

const TEST_PROJECT = "test-project-bh";

describe("Harness Store", () => {
  it("returns project store directory", () => {
    const dir = getProjectStoreDir(TEST_PROJECT);
    expect(dir).toContain(TEST_PROJECT);
    expect(dir).toContain("better-harness");
  });

  it("atomically writes and reads JSON", () => {
    const testPath = join(getProjectStoreDir(TEST_PROJECT), "_test.json");
    const data = { hello: "world", num: 42 };
    atomicWriteFile(testPath, data);
    const loaded = readJsonFile<typeof data>(testPath);
    expect(loaded).toEqual(data);
  });

  it("returns null for non-existent file", () => {
    const result = readJsonFile("/nonexistent/path.json");
    expect(result).toBeNull();
  });
});

describe("Run Store", () => {
  it("saves and loads a run", () => {
    const run = {
      runId: "run_test_1",
      projectId: TEST_PROJECT,
      status: "completed" as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      stage: "completed",
      progressPercent: 100,
    };
    saveRun(TEST_PROJECT, run);
    const loaded = loadRun(TEST_PROJECT, "run_test_1");
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("run_test_1");
    expect(loaded!.status).toBe("completed");
  });

  it("throws for invalid run status", () => {
    expect(() => saveRun(TEST_PROJECT, {
      runId: "bad",
      projectId: TEST_PROJECT,
      status: "invalid" as any,
      startedAt: "",
    })).toThrow();
  });
});

describe("Ignored Finding Store", () => {
  it("saves and loads ignored findings", () => {
    saveIgnoredFinding(TEST_PROJECT, {
      findingId: "fnd_ignore_1",
      reason: "False positive",
      actor: "test",
      timestamp: new Date().toISOString(),
    });
    const ignored = loadIgnoredFindings(TEST_PROJECT);
    expect(ignored.length).toBeGreaterThan(0);
    expect(ignored.some((i) => i.findingId === "fnd_ignore_1")).toBe(true);
  });
});

describe("Repair Session Store", () => {
  it("saves and loads repair sessions", () => {
    const session = {
      repairSessionId: "repair_test_1",
      findingId: "fnd_test",
      prompt: "Fix this",
      status: "created" as const,
      createdAt: new Date().toISOString(),
    };
    saveRepairSession(TEST_PROJECT, session);
    const loaded = loadRepairSession(TEST_PROJECT, "repair_test_1");
    expect(loaded).not.toBeNull();
    expect(loaded!.repairSessionId).toBe("repair_test_1");
  });
});
