/**
 * State isolation tests for Better Harness standalone launcher.
 *
 * Proves that the standalone launcher writes all persistence into its
 * temporary state directory and never leaks files to ~/.flowdeck/state/.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { launchStandaloneServer, type StandaloneServerMeta } from "../../src/better-harness/testing/standalone-launcher";
import {
  getFlowDeckStateDir,
  setFlowDeckStateDir,
  resetFlowDeckStateDir,
  getProjectStoreDir,
} from "../../src/better-harness/persistence/harness-store";

const LIFECYCLE_TIMEOUT = 30_000;

describe("State isolation (standalone launcher)", () => {
  let meta: StandaloneServerMeta;
  let capturedRunId: string;

  beforeAll(async () => {
    meta = await launchStandaloneServer();
    // Start a run — this triggers saveRun() via emitProgress
    const runRes = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      },
    );
    const body: any = await runRes.json();
    expect(runRes.status).toBe(201);
    expect(body.accepted).toBe(true);
    expect(body.runId).toBeDefined();
    capturedRunId = body.runId;
    // Give the async emitProgress a moment to write
    await new Promise((r) => setTimeout(r, 1500));
  }, LIFECYCLE_TIMEOUT);

  afterAll(async () => {
    await meta.shutdown();
  }, 10_000);

  it("temp stateDir is distinct from default ~/.flowdeck/state/", () => {
    expect(meta.stateDir).not.toBe(join(homedir(), ".flowdeck", "state"));
    expect(meta.stateDir).toContain("flowdeck-state-");
  });

  it("run file exists in temp stateDir", () => {
    // Verify the file exists in the temp stateDir
    const projectStoreInTemp = join(meta.stateDir, meta.projectId, "better-harness");
    const runsDirInTemp = join(projectStoreInTemp, "runs");
    expect(existsSync(runsDirInTemp)).toBe(true);
    const runFilesInTemp = readdirSync(runsDirInTemp);
    expect(runFilesInTemp.some((f) => f.startsWith(capturedRunId))).toBe(true);
  });

  it("run file NOT present in real ~/.flowdeck/state/", () => {
    const defaultStateDir = join(homedir(), ".flowdeck", "state");
    if (!existsSync(defaultStateDir)) {
      // ~/.flowdeck/state/ doesn't exist — proves no leakage happened
      return;
    }
    // Check that our specific runId does NOT exist anywhere under real state dir
    const projectDirInDefault = join(defaultStateDir, meta.projectId);
    if (!existsSync(projectDirInDefault)) return; // No project dir = no leak
    const runPath = join(projectDirInDefault, "better-harness", "runs", `${capturedRunId}.json`);
    expect(existsSync(runPath)).toBe(false);
  });

  it("shutdown cleans temp stateDir", async () => {
    // Shutdown already called in afterAll, but we verify shutdown cleans up
    // by launching an inner server and checking its stateDir is deleted
    const inner = await launchStandaloneServer();
    const stateDirBeforeShutdown = inner.stateDir;
    expect(existsSync(stateDirBeforeShutdown)).toBe(true);
    await inner.shutdown();
    expect(existsSync(stateDirBeforeShutdown)).toBe(false);
  });
});

describe("harness-store override functions", () => {
  const ORIGINAL = join(homedir(), ".flowdeck", "state");

  afterEach(() => {
    resetFlowDeckStateDir();
  });

  it("getFlowDeckStateDir returns default when no override set", () => {
    expect(getFlowDeckStateDir()).toBe(ORIGINAL);
  });

  it("setFlowDeckStateDir redirects all subsequent calls", () => {
    const temp = "C:\\temp\\override-test";
    setFlowDeckStateDir(temp);
    expect(getFlowDeckStateDir()).toBe(temp);
    expect(getProjectStoreDir("test-proj")).toContain(temp);
    expect(getProjectStoreDir("test-proj")).toContain("test-proj");
  });

  it("resetFlowDeckStateDir restores default", () => {
    const temp = "C:\\temp\\override-after-reset";
    setFlowDeckStateDir(temp);
    expect(getFlowDeckStateDir()).toBe(temp);
    resetFlowDeckStateDir();
    expect(getFlowDeckStateDir()).toBe(ORIGINAL);
  });
});
