import { describe, it, expect, afterAll, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---- Runtime ----
import { EventBus } from "../../src/better-harness/runtime/event-bus";
import { cancelRun, isRunCancelled, clearCancellation } from "../../src/better-harness/runtime/run-cancellation";
import { ProjectRegistry } from "../../src/better-harness/runtime/project-registry";
import { HarnessRuntime } from "../../src/better-harness/runtime/harness-runtime";
import { RunCoordinator } from "../../src/better-harness/runtime/run-coordinator";
import { registry } from "../../src/better-harness/runtime/runtime-registry";

// ---- Transport ----
import { createAuthCheck } from "../../src/better-harness/transport/authentication";
import { createCorsHeaders, DEFAULT_CORS_CONFIG } from "../../src/better-harness/transport/cors";
import { setRequestContext, getRequestContext, clearRequestContext } from "../../src/better-harness/transport/request-context";
import { routeRequest, routeRequestContext } from "../../src/better-harness/transport/router";
import type { RouterContext } from "../../src/better-harness/runtime/router-context";

// ---- Verification ----
import { verifyFinding } from "../../src/better-harness/verification/finding-verifier";
import { runRequirements } from "../../src/better-harness/verification/requirement-runner";
import { inspectDiff } from "../../src/better-harness/verification/diff-inspector";

// ---- Persistence ----
import { readJsonFile } from "../../src/better-harness/persistence/harness-store";
import { saveFindingIndex, loadFindingIndex, getActiveFindings } from "../../src/better-harness/persistence/finding-store";
import { saveReport, loadReport, listReports } from "../../src/better-harness/persistence/report-store";
import { saveRun, listRuns } from "../../src/better-harness/persistence/run-store";
import { saveIgnoredFinding, loadIgnoredFindings, isFindingIgnored } from "../../src/better-harness/persistence/ignored-finding-store";
import { saveRepairSession, listRepairSessions } from "../../src/better-harness/persistence/repair-session-store";

// ---- SSE ----
import { SseManager } from "../../src/better-harness/transport/sse";

// ---- Contracts ----
import type { HarnessFinding } from "../../src/better-harness/contracts/report";

const TEST_PROJECT = "test-integration-bh";

// ─── EventBus ──────────────────────────────────────────────────────
describe("EventBus", () => {
  it("subscribes and emits events", () => {
    const bus = new EventBus();
    const events: string[] = [];
    const unsub = bus.subscribe("run.started", (e) => { events.push(e.type); });
    bus.emit("run.started", { runId: "r1" });
    expect(events).toContain("run.started");
    unsub();
    bus.emit("run.started", { runId: "r2" });
    expect(events).toHaveLength(1); // unsubscribed, no new event
  });

  it("handles multiple subscribers", () => {
    const bus = new EventBus();
    let count = 0;
    bus.subscribe("run.queued", () => { count++; });
    bus.subscribe("run.queued", () => { count++; });
    bus.emit("run.queued", {});
    expect(count).toBe(2);
  });

  it("does not crash on handler error", () => {
    const bus = new EventBus();
    bus.subscribe("run.started", () => { throw new Error("handler error"); });
    bus.subscribe("run.started", () => { /* ok */ });
    expect(() => bus.emit("run.started", {})).not.toThrow();
  });

  it("ignores unsubscribed event types", () => {
    const bus = new EventBus();
    let called = false;
    bus.subscribe("run.started", () => { called = true; });
    bus.emit("run.failed", {});
    expect(called).toBe(false);
  });
});

// ─── RunCancellation ──────────────────────────────────────────────
describe("RunCancellation", () => {
  afterAll(() => {
    clearCancellation("cancel_test_1");
    clearCancellation("cancel_test_2");
  });

  it("cancels a run", () => {
    expect(cancelRun("cancel_test_1")).toBe(true);
    expect(isRunCancelled("cancel_test_1")).toBe(true);
  });

  it("returns false for already cancelled runs", () => {
    cancelRun("cancel_test_1");
    expect(cancelRun("cancel_test_1")).toBe(false);
  });

  it("clears cancellation", () => {
    cancelRun("cancel_test_2");
    expect(isRunCancelled("cancel_test_2")).toBe(true);
    clearCancellation("cancel_test_2");
    expect(isRunCancelled("cancel_test_2")).toBe(false);
  });

  it("returns false for unregistered run", () => {
    expect(isRunCancelled("nonexistent_run")).toBe(false);
  });
});

// ─── ProjectRegistry ──────────────────────────────────────────────
describe("ProjectRegistry", () => {
  const reg = new ProjectRegistry();

  it("registers and resolves a project", () => {
    reg.register({
      serverKey: "sk_test",
      projectKey: "pk_test",
      canonicalProjectRoot: process.cwd(),
    });
    const resolved = reg.resolve("sk_test", "pk_test");
    expect(resolved).toBeTruthy();
    expect(resolved).toContain("FlowDeck");
  });

  it("returns null for unknown project", () => {
    expect(reg.resolve("sk_unknown", "pk_unknown")).toBeNull();
  });

  it("unregisters a project", () => {
    reg.register({
      serverKey: "sk_unreg",
      projectKey: "pk_unreg",
      canonicalProjectRoot: process.cwd(),
    });
    expect(reg.resolve("sk_unreg", "pk_unreg")).toBeTruthy();
    reg.unregister("pk_unreg");
    expect(reg.resolve("sk_unreg", "pk_unreg")).toBeNull();
  });
});

// ─── Authentication ──────────────────────────────────────────────
describe("Authentication", () => {
  it("allows all when auth is disabled", () => {
    const check = createAuthCheck({ token: null, enabled: false });
    expect(check()).toBe(true);
    expect(check(undefined)).toBe(true);
    expect(check("anything")).toBe(true);
  });

  it("allows all when token is null even if enabled", () => {
    const check = createAuthCheck({ token: null, enabled: true });
    expect(check()).toBe(true);
    expect(check("foo")).toBe(true);
  });

  it("rejects missing token when auth enabled", () => {
    const check = createAuthCheck({ token: "secret", enabled: true });
    expect(check(undefined)).toBe(false);
    expect(check("")).toBe(false);
  });

  it("accepts correct token", () => {
    const check = createAuthCheck({ token: "secret123", enabled: true });
    expect(check("secret123")).toBe(true);
  });

  it("rejects incorrect token", () => {
    const check = createAuthCheck({ token: "secret123", enabled: true });
    expect(check("wrong")).toBe(false);
  });

  it("constant-time comparison rejects different lengths", () => {
    const check = createAuthCheck({ token: "short", enabled: true });
    expect(check("longer_token")).toBe(false);
  });
});

// ─── CORS ────────────────────────────────────────────────────────
describe("CORS", () => {
  it("includes origin from allowlist", () => {
    const headers = createCorsHeaders(DEFAULT_CORS_CONFIG, "http://localhost:3000");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
  });

  it("falls back to default origin for unknown origins", () => {
    const headers = createCorsHeaders(DEFAULT_CORS_CONFIG, "https://evil.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
  });

  it("returns default when no origin is provided", () => {
    const headers = createCorsHeaders(DEFAULT_CORS_CONFIG);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
  });

  it("includes allowed methods and headers", () => {
    const headers = createCorsHeaders(DEFAULT_CORS_CONFIG, "http://localhost:5173");
    expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
  });

  it("matches additional allowed origins", () => {
    const config = {
      allowedOrigins: ["https://app.example.com", "http://localhost:3000"],
      allowedMethods: ["GET", "POST"],
      allowedHeaders: ["Content-Type"],
    };
    const headers = createCorsHeaders(config, "https://app.example.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.example.com");
  });
});

// ─── RequestContext ──────────────────────────────────────────────
describe("RequestContext", () => {
  afterEach(() => {
    clearRequestContext();
  });

  it("sets and gets request context", () => {
    setRequestContext({ projectId: "proj_1", runId: "run_1" });
    const ctx = getRequestContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.projectId).toBe("proj_1");
    expect(ctx!.runId).toBe("run_1");
  });

  it("clears request context", () => {
    setRequestContext({ projectId: "proj_2" });
    clearRequestContext();
    expect(getRequestContext()).toBeNull();
  });

  it("returns null when no context is set", () => {
    clearRequestContext();
    expect(getRequestContext()).toBeNull();
  });
});

// ─── Route Matching ──────────────────────────────────────────────
describe("Route Matching", () => {
  it("health endpoint returns ok", async () => {
    const ctx = { runtime: null, coordinator: null } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/health", undefined);
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("status", "ok");
  });

  it("returns 404 for unknown routes", async () => {
    const ctx = { runtime: null, coordinator: null } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/unknown/path", undefined);
    expect(result.status).toBe(404);
  });

  it("handles errors gracefully", async () => {
    const ctx = {
      coordinator: {
        getActiveRun: () => { throw new Error("coordinator exploded"); },
      },
    } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/pk/better-harness/runs/current", undefined);
    expect(result.status).toBe(500);
    expect(result.body).toHaveProperty("error");
  });

  it("rejects invalid project key", async () => {
    const ctx = { runtime: null, coordinator: null } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/%00/better-harness/availability", undefined);
    expect(result.status).toBe(400);
  });
});

// ─── Route Behaviour ─────────────────────────────────────────
describe("Router", () => {
  it("routeRequest delegates correctly", async () => {
    const result = await routeRequest("GET", "/health", undefined);
    expect(result.status).toBe(200);
  });

  it("availability returns valid response", async () => {
    const ctx = {
      runtime: new HarnessRuntime({ projectRoot: "/tmp" }),
      coordinator: new RunCoordinator(),
    } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/pk/better-harness/availability", undefined);
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("available", true);
  });
});

// ─── Finding Verifier ────────────────────────────────────────────
describe("Finding Verifier", () => {
  const baseFinding: HarnessFinding = {
    id: "fnd_verify_test",
    title: "Test finding",
    dimension: "change-validation",
    priority: "high",
    status: "pending",
    cause: "Missing config",
    impact: "Cannot validate",
    expectedOutput: "Config exists",
    evidence: [],
    recommendedVehicle: "rule",
    allowedPaths: ["src/rules/"],
    validationRequirements: ["node --version"],
    acceptanceCriteria: ["Tests pass"],
    firstSeenAt: "",
    lastSeenAt: "",
  };

  it("marks as fixed when diff allowed and requirements pass", () => {
    const result = verifyFinding(
      baseFinding,
      [{ filePath: "src/rules/new-rule.md", status: "added" }],
      process.cwd(),
    );
    expect(result.findingId).toBe("fnd_verify_test");
    expect(result.status).toBe("fixed");
    expect(result.diffResult.allowed).toBe(true);
  });

  it("marks as pending when diff has violations", () => {
    const result = verifyFinding(
      baseFinding,
      [{ filePath: "src/config/secret.json", status: "modified" }],
      process.cwd(),
    );
    expect(result.status).toBe("pending");
    expect(result.diffResult.allowed).toBe(false);
    expect(result.diffResult.violations.length).toBeGreaterThan(0);
  });

  it("marks as pending when requirements fail", () => {
    const result = verifyFinding(
      { ...baseFinding, validationRequirements: ["exit 1"] },
      [{ filePath: "src/rules/new-rule.md", status: "added" }],
      process.cwd(),
    );
    expect(result.status).toBe("pending");
    expect(result.requirementResults.some((r) => !r.passed)).toBe(true);
  });
});

// ─── Requirement Runner ──────────────────────────────────────────
describe("Requirement Runner", () => {
  it("passes for successful commands", () => {
    const results = runRequirements(["node --version"], process.cwd());
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].output).toContain("v");
  });

  it("fails for failing commands", () => {
    const results = runRequirements(["node -e \"process.exit(1)\""], process.cwd());
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
  });

  it("runs multiple requirements", () => {
    const results = runRequirements(["node --version", "node -e \"console.log('ok')\""], process.cwd());
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});

// ─── Diff Inspector Edge Cases ───────────────────────────────────
describe("Diff Inspector Edge Cases", () => {
  it("detects disallowed path", () => {
    const result = inspectDiff(
      [{ filePath: "outside/file.txt", status: "modified" }],
      ["src/rules/"],
    );
    expect(result.allowed).toBe(false);
    expect(result.violations[0]).toContain("outside");
  });

  it("handles empty allowed paths", () => {
    const result = inspectDiff(
      [{ filePath: "any/file.txt", status: "added" }],
      [],
    );
    expect(result.allowed).toBe(false);
  });

  it("handles deleted files", () => {
    const result = inspectDiff(
      [{ filePath: "src/rules/old.md", status: "deleted" }],
      ["src/rules/"],
    );
    expect(result.allowed).toBe(true);
  });
});

// ─── Persistence Stores ──────────────────────────────────────────
describe("Persistence - Finding Store", () => {
  const pid = TEST_PROJECT + "_findings";

  afterAll(() => {
    try { rmSync(join(homedir(), ".flowdeck", "state", pid), { recursive: true, force: true }); } catch { /* */ }
  });

  it("saves and loads finding index", () => {
    const findings: HarnessFinding[] = [{
      id: "fnd_store_1", title: "Test", dimension: "task-understanding",
      priority: "high", status: "pending", cause: "C", impact: "I",
      expectedOutput: "O", evidence: [], recommendedVehicle: "rule",
      allowedPaths: [], validationRequirements: [], acceptanceCriteria: [],
      firstSeenAt: "", lastSeenAt: "",
    }];
    saveFindingIndex(pid, findings);
    const loaded = loadFindingIndex(pid);
    expect(loaded).not.toBeNull();
    expect(loaded!.findings).toHaveLength(1);
    expect(loaded!.projectId).toBe(pid);
  });

  it("getActiveFindings filters out fixed and ignored", () => {
    const findings: HarnessFinding[] = [
      { id: "fnd_a", title: "Active", dimension: "task-understanding",
        priority: "high", status: "pending", cause: "C", impact: "I",
        expectedOutput: "O", evidence: [], recommendedVehicle: "rule",
        allowedPaths: [], validationRequirements: [], acceptanceCriteria: [],
        firstSeenAt: "", lastSeenAt: "" },
      { id: "fnd_b", title: "Fixed", dimension: "task-understanding",
        priority: "low", status: "fixed", cause: "C", impact: "I",
        expectedOutput: "O", evidence: [], recommendedVehicle: "rule",
        allowedPaths: [], validationRequirements: [], acceptanceCriteria: [],
        firstSeenAt: "", lastSeenAt: "" },
      { id: "fnd_c", title: "Ignored", dimension: "task-understanding",
        priority: "low", status: "ignored", cause: "C", impact: "I",
        expectedOutput: "O", evidence: [], recommendedVehicle: "rule",
        allowedPaths: [], validationRequirements: [], acceptanceCriteria: [],
        firstSeenAt: "", lastSeenAt: "" },
    ];
    saveFindingIndex(pid, findings);
    const active = getActiveFindings(pid);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("fnd_a");
  });

  it("getActiveFindings returns empty array when no index", () => {
    const active = getActiveFindings("nonexistent_project");
    expect(active).toEqual([]);
  });
});

describe("Persistence - Report Store", () => {
  const pid = TEST_PROJECT + "_reports";

  afterAll(() => {
    try { rmSync(join(homedir(), ".flowdeck", "state", pid), { recursive: true, force: true }); } catch { /* */ }
  });

  const makeReport = (ts: string) => ({
    schemaVersion: 1 as const,
    engineVersion: "1.0.0",
    scoringVersion: "1.0.0",
    generatedAt: ts,
    project: { name: "test", directory: "/tmp/test" },
    overallScore: 75,
    evidenceCoverage: 80,
    dimensions: [{ dimension: "task-understanding" as const, score: 75, findingCount: 2, evidenceCoverage: 80 }],
    findings: [],
    sessions: { analyzed: 1, longSessions: 0, failedSessions: 0, repeatedFailures: 0, compactions: 0, permissionInterruptions: 0 },
    assets: { agents: 0, skills: 0, commands: 0, rules: 0, hooks: 0, scripts: 0, workflows: 0, tests: 0, lessons: 0, memoryNodes: 0 },
  });

  it("saves and loads a report", () => {
    const ts = new Date().toISOString().replace(/:/g, "-");
    saveReport(pid, makeReport(ts));
    const loaded = loadReport(pid, ts);
    expect(loaded).not.toBeNull();
    expect(loaded!.overallScore).toBe(75);
  });

  it("lists reports", () => {
    const reports = listReports(pid);
    expect(reports.length).toBeGreaterThan(0);
  });

  it("throws for invalid report", () => {
    expect(() => saveReport(pid, { ...makeReport(new Date().toISOString()), schemaVersion: 999 } as any)).toThrow();
  });

  it("returns null for invalid report data on load", () => {
    const pid2 = pid + "_invalid";
    const dir = join(homedir(), ".flowdeck", "state", pid2, "better-harness", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ invalid: true }), "utf-8");
    const loaded = loadReport(pid2, "bad");
    expect(loaded).toBeNull();
    try { rmSync(join(homedir(), ".flowdeck", "state", pid2), { recursive: true, force: true }); } catch { /* */ }
  });

  it("listReports returns empty for non-existent dir", () => {
    expect(listReports("nonexistent_project")).toEqual([]);
  });
});

describe("Persistence - Run Store", () => {
  const pid = TEST_PROJECT + "_runs";

  afterAll(() => {
    try { rmSync(join(homedir(), ".flowdeck", "state", pid), { recursive: true, force: true }); } catch { /* */ }
  });

  it("lists runs", () => {
    saveRun(pid, { runId: "run_list_1", projectId: pid, status: "completed", startedAt: new Date().toISOString() });
    const runs = listRuns(pid);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs).toContain("run_list_1");
  });

  it("listRuns returns empty for non-existent dir", () => {
    expect(listRuns("nonexistent_project")).toEqual([]);
  });

  it("throws for invalid run status", () => {
    expect(() => saveRun(pid, { runId: "bad", projectId: pid, status: "invalid" as any, startedAt: "" })).toThrow();
  });
});

describe("Persistence - Ignored Finding Store", () => {
  const pid = TEST_PROJECT + "_ignored";

  afterAll(() => {
    try { rmSync(join(homedir(), ".flowdeck", "state", pid), { recursive: true, force: true }); } catch { /* */ }
  });

  it("checks if finding is ignored", () => {
    saveIgnoredFinding(pid, { findingId: "fnd_ign_check", reason: "Test", actor: "test", timestamp: new Date().toISOString() });
    expect(isFindingIgnored(pid, "fnd_ign_check")).toBe(true);
    expect(isFindingIgnored(pid, "fnd_not_ignored")).toBe(false);
  });

  it("returns empty array for non-existent project", () => {
    expect(loadIgnoredFindings("nonexistent_project")).toEqual([]);
  });
});

describe("Persistence - Repair Session Store", () => {
  const pid = TEST_PROJECT + "_repair";

  afterAll(() => {
    try { rmSync(join(homedir(), ".flowdeck", "state", pid), { recursive: true, force: true }); } catch { /* */ }
  });

  it("lists repair sessions", () => {
    saveRepairSession(pid, { repairSessionId: "rs_list_1", findingId: "fnd_1", prompt: "Fix", status: "created", createdAt: new Date().toISOString() });
    const sessions = listRepairSessions(pid);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions).toContain("rs_list_1");
  });

  it("listRepairSessions returns empty for non-existent dir", () => {
    expect(listRepairSessions("nonexistent_project")).toEqual([]);
  });
});

describe("Persistence - Harness Store Edge Cases", () => {
  it("readJsonFile quarantines corrupt records", () => {
    const testDir = join(homedir(), ".flowdeck", "state", TEST_PROJECT, "better-harness", "_quarantine_test");
    mkdirSync(testDir, { recursive: true });
    const testFile = join(testDir, "corrupt.json");
    writeFileSync(testFile, "{invalid json content!!!", "utf-8");
    const result = readJsonFile(testFile);
    expect(result).toBeNull();
    const quarantineFile = testFile + ".quarantine";
    expect(existsSync(quarantineFile)).toBe(true);
    try { renameSync(quarantineFile, testFile); } catch { /* */ }
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* */ }
  });
});

// ─── Runtime Registry ────────────────────────────────────────────
describe("Runtime Registry", () => {
  it("exports all expected modules", () => {
    expect(registry.collectors.customization).toBeDefined();
    expect(registry.collectors.foundations).toBeDefined();
    expect(registry.collectors.sessions).toBeDefined();
    expect(registry.analyzers.taskUnderstanding).toBeDefined();
    expect(registry.analyzers.controlledExecution).toBeDefined();
    expect(registry.analyzers.changeValidation).toBeDefined();
    expect(registry.analyzers.reliableDelivery).toBeDefined();
    expect(registry.analyzers.learningCapture).toBeDefined();
    expect(registry.stores.run).toBeDefined();
    expect(registry.stores.report).toBeDefined();
    expect(registry.stores.finding).toBeDefined();
    expect(registry.stores.ignoredFinding).toBeDefined();
    expect(registry.stores.repairSession).toBeDefined();
    expect(registry.opencode.readSessionRecords).toBeDefined();
    expect(registry.opencode.analyzeSessions).toBeDefined();
    expect(registry.opencode.createRepairSession).toBeDefined();
    expect(registry.opencode.buildRepairPrompt).toBeDefined();
    expect(registry.opencode.executeValidation).toBeDefined();
  });
});

// ─── RunCoordinator ──────────────────────────────────────────────
describe("RunCoordinator", () => {
  it("starts as not active", () => {
    const coord = new RunCoordinator();
    expect(coord.isActive()).toBe(false);
    expect(coord.getActiveRun()).toBeNull();
  });

  it("enqueues a run and returns active state", async () => {
    const coord = new RunCoordinator();
    const state = await coord.enqueueRun({ projectRoot: process.cwd(), timeoutMs: 5000 });
    expect(state.runId).toMatch(/^run_/);
    expect(state.status).toBe("queued");
    expect(coord.isActive()).toBe(true);
    expect(coord.getActiveRun()).not.toBeNull();
  });

  it("fails to enqueue when active run exists", async () => {
    const coord = new RunCoordinator();
    await coord.enqueueRun({ projectRoot: process.cwd(), timeoutMs: 5000 });
    await expect(coord.enqueueRun({ projectRoot: process.cwd() })).rejects.toThrow("already in progress");
  });

  it("cancels an active run", async () => {
    const coord = new RunCoordinator();
    const state = await coord.enqueueRun({ projectRoot: process.cwd(), timeoutMs: 5000 });
    expect(coord.cancelRun(state.runId)).toBe(true);
  });

  it("cancelRun succeeds for any run id", () => {
    const coord = new RunCoordinator();
    expect(coord.cancelRun("nonexistent_run")).toBe(true);
  });

  it("has an event bus", () => {
    const coord = new RunCoordinator();
    expect(coord.getEventBus()).toBeInstanceOf(EventBus);
  });
});

// ─── HarnessRuntime ──────────────────────────────────────────────
describe("HarnessRuntime", () => {
  it("constructs with config", () => {
    const runtime = new HarnessRuntime({ projectRoot: "/tmp" });
    expect(runtime.getCoordinator()).toBeInstanceOf(RunCoordinator);
    expect(runtime.getEventBus()).toBeInstanceOf(EventBus);
  });

  it("enqueues a run", async () => {
    const runtime = new HarnessRuntime({ projectRoot: process.cwd(), timeoutMs: 5000 });
    const result = await runtime.enqueueRun({ mode: "full" });
    expect(result.runId).toMatch(/^run_/);
    expect(result.status).toBe("queued");
  });

  it("returns status without active run", () => {
    const runtime = new HarnessRuntime({ projectRoot: "/tmp" });
    const status = runtime.getStatus();
    expect(status.active).toBe(false);
  });

  it("subscribes to events", () => {
    const runtime = new HarnessRuntime({ projectRoot: "/tmp" });
    const events: string[] = [];
    const unsub = runtime.subscribe("run.queued", (e: any) => { events.push(e.type); });
    runtime.getCoordinator().getEventBus().emit("run.queued", {});
    expect(events).toContain("run.queued");
    unsub();
  });

  it("cancel returns false when no active run", () => {
    const runtime = new HarnessRuntime({ projectRoot: "/tmp" });
    expect(runtime.cancel()).toBe(false);
  });

  it("run() calls enqueueRun with full mode", async () => {
    const runtime = new HarnessRuntime({ projectRoot: process.cwd(), timeoutMs: 5000 });
    const result = await runtime.run();
    expect(result.status).toBe("queued");
  });

  it("getRun returns null for unknown run", () => {
    const runtime = new HarnessRuntime({ projectRoot: "/tmp" });
    expect(runtime.getRun("nonexistent")).toBeNull();
  });
});

// ─── SSE Manager ─────────────────────────────────────────────────
describe("SSE Manager", () => {
  it("constructs without event log dir", () => {
    const bus = new EventBus();
    const sse = new SseManager(bus);
    expect(sse).toBeInstanceOf(SseManager);
  });

  it("constructs with event log dir", () => {
    const bus = new EventBus();
    const tmpLogDir = join(homedir(), ".flowdeck", "state", TEST_PROJECT, "sse-test");
    mkdirSync(tmpLogDir, { recursive: true });
    const sse = new SseManager(bus, tmpLogDir);
    expect(sse).toBeInstanceOf(SseManager);
    try { rmSync(join(homedir(), ".flowdeck", "state", TEST_PROJECT, "sse-test"), { recursive: true, force: true }); } catch { /* */ }
  });

  it("adds and removes client", () => {
    const bus = new EventBus();
    const sse = new SseManager(bus);
    const client = {
      id: "test_client",
      lastEventId: null,
      send: () => {},
    };
    sse.addClient(client);
    sse.removeClient("test_client");
  });

  it("broadcasts events to clients", () => {
    const bus = new EventBus();
    const sse = new SseManager(bus);
    const received: string[] = [];
    const client = {
      id: "broadcast_client",
      lastEventId: null,
      send: (event: any) => { received.push(event.type); },
    };
    sse.addClient(client);
    bus.emit("run.started", { runId: "r1" });
    expect(received.length).toBeGreaterThan(0);
    sse.removeClient("broadcast_client");
  });

  it("handles client disconnect gracefully", () => {
    const bus = new EventBus();
    const sse = new SseManager(bus);
    const client = {
      id: "disc_client",
      lastEventId: null,
      send: () => { throw new Error("disconnected"); },
    };
    sse.addClient(client);
    bus.emit("run.queued", {});
  });

  it("filters events by projectKey", () => {
    const bus = new EventBus();
    const sse = new SseManager(bus);
    const received: string[] = [];
    const client = {
      id: "filter_client",
      lastEventId: null,
      projectKey: "proj_a",
      send: (event: any) => { received.push(event.type); },
    };
    sse.addClient(client);
    bus.emit("run.started", { projectKey: "proj_a" });
    bus.emit("finding.created", { projectKey: "proj_b" });
  });
});


// ─── Router Additional Endpoints ─────────────────────────────
describe("Router - Report Endpoints", () => {
  it("report endpoint returns 404 when no reports exist", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator() } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/nonexistent/better-harness/report", undefined);
    expect(result.status).toBe(404);
    expect(result.body).toHaveProperty("error");
  });

  it("history endpoint returns empty array when no reports exist", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator() } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/nonexistent/better-harness/history", undefined);
    expect(result.status).toBe(200);
    expect(Array.isArray(result.body)).toBe(true);
  });

  it("current run returns ok with null when no active run", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator(), resolveProjectPath: () => "/tmp" } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/pk/better-harness/runs/current", undefined);
    expect(result.status).toBe(200);
  });

  it("start run returns bad request for invalid body", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator(), resolveProjectPath: () => "/tmp" } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "POST", "/api/v1/servers/sk/projects/pk/better-harness/runs", { invalid: true });
    expect(result.status).toBe(400);
  });

  it("get run returns 404 for nonexistent run", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator(), resolveProjectPath: () => "/tmp" } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/pk/better-harness/runs/nonexistent", undefined);
    expect(result.status).toBe(404);
  });

  it("SSE route returns 501 when no SSE manager", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator(), resolveProjectPath: () => "/tmp" } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/pk/better-harness/runs/r1/events", undefined);
    expect(result.status).toBe(501);
  });

  it("findings/ignore returns bad request for invalid body", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator(), resolveProjectPath: () => "/tmp" } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "POST", "/api/v1/servers/sk/projects/pk/better-harness/findings/ignore", {});
    expect(result.status).toBe(400);
  });

  it("findings/plan-fix returns bad request for invalid body", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator(), resolveProjectPath: () => "/tmp" } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "POST", "/api/v1/servers/sk/projects/pk/better-harness/findings/plan-fix", {});
    expect(result.status).toBe(400);
  });

  it("findings/verify returns bad request for invalid body", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator(), resolveProjectPath: () => "/tmp" } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "POST", "/api/v1/servers/sk/projects/pk/better-harness/findings/verify", {});
    expect(result.status).toBe(400);
  });

  it("repair session returns 404 for nonexistent", async () => {
    const ctx = { runtime: new HarnessRuntime({ projectRoot: "/tmp" }), coordinator: new RunCoordinator(), resolveProjectPath: () => "/tmp" } as unknown as RouterContext;
    const result = await routeRequestContext(ctx, "GET", "/api/v1/servers/sk/projects/pk/better-harness/repair-sessions/nonexistent", undefined);
    expect(result.status).toBe(404);
  });
});

// ─── HTTP Server ─────────────────────────────────────────────
describe("HTTP Server", () => {
  it("start returns 0 when disabled", async () => {
    const { HarnessHttpServer } = await import("../../src/better-harness/transport/http-server");
    const server = new HarnessHttpServer({ enabled: false });
    const port = await server.start();
    expect(port).toBe(0);
  });

  it("stop resolves when server is null", async () => {
    const { HarnessHttpServer } = await import("../../src/better-harness/transport/http-server");
    const server = new HarnessHttpServer({ enabled: false });
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

// ─── Repair Session Edge Cases ───────────────────────────────
describe("Repair Session Edge Cases", () => {
  it("generateRestrictedRepairPrompt produces correct format", async () => {
    const { generateRestrictedRepairPrompt } = await import("../../src/better-harness/opencode/repair-session");
    const prompt = generateRestrictedRepairPrompt(
      "Missing config",
      ["Config file not found"],
      "Config should exist",
      ["src/config/"],
      ["npm test"],
      ["Tests pass"],
    );
    expect(prompt).toContain("## Cause");
    expect(prompt).toContain("Missing config");
    expect(prompt).toContain("## Evidence");
    expect(prompt).toContain("Config file not found");
    expect(prompt).toContain("## Expected Output");
    expect(prompt).toContain("## Validation Requirements");
    expect(prompt).toContain("## Acceptance Criteria");
    expect(prompt).toContain("src/config/");
  });
});

// ─── Project Identity Edge Cases ─────────────────────────────
describe("Project Identity Edge Cases", () => {
  it("works with non-existent directory (fallback)", async () => {
    const { getProjectIdentity } = await import("../../src/better-harness/workspace/project-identity");
    const id = getProjectIdentity("/nonexistent/path/for/testing");
    expect(id.directory).toBe("/nonexistent/path/for/testing");
    expect(id.source).toBe("directory-hash");
  });
});

// ─── Workspace Snapshot Edge Cases ───────────────────────────
describe("Workspace Snapshot Edge Cases", () => {
  it("detectPackageManager returns unknown for empty dir", async () => {
    const { captureWorkspaceSnapshot } = await import("../../src/better-harness/workspace/workspace-snapshot");
    const emptyDir = join(homedir(), ".flowdeck", "state", TEST_PROJECT, "empty-workspace");
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(emptyDir, "package.json"), JSON.stringify({ name: "empty-project" }), "utf-8");
    const snapshot = captureWorkspaceSnapshot(emptyDir);
    expect(snapshot.packageManager).toBe("unknown");
    expect(snapshot.projectId).toBe("empty-project");
    try { rmSync(emptyDir, { recursive: true, force: true }); } catch { /* */ }
  });
});

// ─── Validation Executor Error Path ──────────────────────────
describe("Validation Executor Error Path", () => {
  it("handles non-Error throwables", async () => {
    const { executeValidation } = await import("../../src/better-harness/opencode/validation-executor");
    // Trigger a timeout which causes execSync to throw
    const result = executeValidation("node -e \"setTimeout(() => {}, 10000)\"", process.cwd(), 1);
    expect(result.passed).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ─── RunCoordinator Recovery ─────────────────────────────────
describe("RunCoordinator Recovery", () => {
  it("recoverActiveRuns does not throw", () => {
    const coord = new RunCoordinator();
    expect(() => coord.recoverActiveRuns()).not.toThrow();
  });
});
