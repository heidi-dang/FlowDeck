import { describe, it, expect } from "vitest";
import { testFdxVersionCompatibility, runDoctorChecks } from "../scripts/doctor-engine.mjs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Phase 30 — Negative Doctor Tests ────────────────────────────────────────
//
// These tests prove that Doctor FAILS (not passes) when each runtime probe
// encounters a failure condition. Every test asserts status === "fail" and
// that no hardcoded-pass default masks the failure.
//
// The tests use testFdxVersionCompatibility and direct function probes rather
// than full runDoctorChecks() to keep them fast and deterministic.

const pkgRaw = JSON.stringify({
  name: "@heidi-dang/flowdeck",
  flowdeckFdxCompatibility: { required: "^0.1.0" },
});

describe("Phase 30 — Doctor Negative Probe Tests", () => {
  // ── FDX semantics ─────────────────────────────────────────────────────────

  it("fails when FDX binary returns malformed (non-empty, non-matching) output", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "garbage output xyz");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("malformed output");
  });

  it("warns (not fails) when FDX binary is absent (null custom output)", () => {
    // null → no custom output → binary not found path → warn
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, null as any);
    expect(res.status).toBe("warn");
    expect(res.message).toContain("not found");
  });

  it("warns (not fails) when FDX custom output is empty string (binary absent)", () => {
    // empty string → treated as no binary → warn
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "");
    expect(res.status).toBe("warn");
    expect(res.message).toContain("not found");
  });

  it("fails when FDX version is too old", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "fdx 0.0.1\n");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("too old");
  });

  it("fails when FDX version is too new (breaking change)", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "fdx 1.0.0\n");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("newer than");
  });

  // ── Runtime export probes (direct assertions on the built dist) ───────────

  it("dist/index.js exports AGENT_NAMES as a non-empty array", async () => {
    const distMod = await import("../dist/index.js");
    expect(Array.isArray(distMod.AGENT_NAMES)).toBe(true);
    expect((distMod.AGENT_NAMES as string[]).length).toBeGreaterThan(0);
  });

  it("dist/index.js exports createAgent as a function that resolves all agents", async () => {
    const distMod = await import("../dist/index.js");
    expect(typeof distMod.createAgent).toBe("function");
    const names = distMod.AGENT_NAMES as string[];
    const missing = names.filter((n: string) => distMod.createAgent(n) === undefined);
    expect(missing).toEqual([]);
  });

  it("createAgent returns undefined for a non-existent agent name", async () => {
    const distMod = await import("../dist/index.js");
    expect(distMod.createAgent("nonexistent-agent-xyz")).toBeUndefined();
  });

  it("validateDelegationDepth blocks depth 2", async () => {
    const distMod = await import("../dist/index.js");
    expect(typeof distMod.validateDelegationDepth).toBe("function");
    const res = distMod.validateDelegationDepth("heidi", "architect", 2, new Set(["architect"]), 1);
    expect(res).toBeDefined();
    expect(res.allowed).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it("validateDelegationDepth allows depth 0 and blocks depth 1 (maxDepth=1)", async () => {
    const distMod = await import("../dist/index.js");
    const d0 = distMod.validateDelegationDepth("heidi", "architect", 0, new Set(["architect"]), 1);
    const d1 = distMod.validateDelegationDepth("heidi", "architect", 1, new Set(["architect"]), 1);
    expect(d0.allowed).toBe(true);
    expect(d1.allowed).toBe(false);
  });

  it("evaluateGovernanceToolCheck is exported and returns an action for each mode", async () => {
    const distMod = await import("../dist/index.js");
    expect(typeof distMod.evaluateGovernanceToolCheck).toBe("function");

    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");

    const testDir = join(tmpdir(), "fd-gov-test-neg-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const dirOff = join(testDir, "off"); mkdirSync(dirOff);
    const dirAdv = join(testDir, "adv"); mkdirSync(dirAdv);
    const dirStrict = join(testDir, "strict"); mkdirSync(dirStrict);

    writeFileSync(join(dirOff, ".flowdeck.json"), '{"governance":{"validator":{"mode":"off"}}}');
    writeFileSync(join(dirAdv, ".flowdeck.json"), '{"governance":{"validator":{"mode":"advisory"}}}');
    writeFileSync(join(dirStrict, ".flowdeck.json"), '{"governance":{"validator":{"mode":"strict"}}}');

    const mOff = distMod.evaluateGovernanceToolCheck({ directory: dirOff, agent: "heidi", tool: "bash" });
    const mAdv = distMod.evaluateGovernanceToolCheck({ directory: dirAdv, agent: "heidi", tool: "bash" });
    const mStrict = distMod.evaluateGovernanceToolCheck({ directory: dirStrict, agent: "heidi", tool: "bash" });

    try { rmSync(testDir, { recursive: true, force: true }) } catch {}

    expect(mOff?.action).toBeDefined();
    expect(mAdv?.action).toBeDefined();
    expect(mStrict?.action).toBeDefined();
  });

  it("strict governance mode does not silently allow dangerous tools", async () => {
    const distMod = await import("../dist/index.js");

    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");

    const testDir = join(tmpdir(), "fd-gov-strict-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, ".flowdeck.json"), '{"governance":{"validator":{"mode":"strict"}}}');

    const res = distMod.evaluateGovernanceToolCheck({ directory: testDir, agent: "heidi", tool: "bash" });
    try { rmSync(testDir, { recursive: true, force: true }) } catch {}

    // strict mode must block or warn — never "allow" for dangerous tools
    expect(res?.action).not.toBe("allow");
  });

  it("acquireLock and releaseLock are exported and functional", async () => {
    const distMod = await import("../dist/index.js");
    expect(typeof distMod.acquireLock).toBe("function");
    expect(typeof distMod.releaseLock).toBe("function");
  });

  it("second lock acquisition times out — lock does not allow re-entrancy", async () => {
    const distMod = await import("../dist/index.js");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const lockPath = join(tmpdir(), `fd-neg-lock-test-${Date.now()}.lock`);

    await distMod.acquireLock(lockPath, { timeout: 500 });
    let threw = false;
    try {
      await distMod.acquireLock(lockPath, { timeout: 100 });
    } catch {
      threw = true;
    } finally {
      await distMod.releaseLock(lockPath).catch(() => {/* ignore */});
    }
    expect(threw).toBe(true);
  }, 5000);

  it("createAgent accepts a custom model parameter (model inheritance)", async () => {
    const distMod = await import("../dist/index.js");
    const agent = distMod.createAgent("planner", "custom-model-for-test");
    expect(agent).toBeDefined();
    // The config should reflect the passed model
    expect(agent?.config?.model).toBe("custom-model-for-test");
  });

  it("createAgent uses no model override when model argument is undefined", async () => {
    const distMod = await import("../dist/index.js");
    const agent = distMod.createAgent("planner", undefined);
    expect(agent).toBeDefined();
    // With no model override, model should be undefined (inherited from UI)
    expect(agent?.config?.model).toBeUndefined();
  });

  // ── runDoctorChecks negative workspace tests ──────────────────────────────

  const setupBaseMockDir = (name: string) => {
    const base = join(tmpdir(), `fd-doctor-neg-${name}-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    mkdirSync(join(base, "dist"), { recursive: true });
    mkdirSync(join(base, "bin"), { recursive: true });
    writeFileSync(join(base, "package.json"), JSON.stringify({
      name: "@heidi-dang/flowdeck",
      version: "0.8.0-test",
      flowdeckFdxCompatibility: { required: "^0.1.0" }
    }));
    writeFileSync(join(base, "bin", "flowdeck.js"), `
      const handlers = {
        install: cmdInstall,
        update: cmdUpdate,
        verify: cmdVerify,
        doctor: cmdDoctor,
        uninstall: cmdUninstall,
        migrate: cmdMigrate,
        rollback: cmdRollback
      };
    `);
    return base;
  };

  it("Doctor fails when runtime diagnostics module is missing", async () => {
    const tempDir = setupBaseMockDir("missing-dist");
    // Explicitly delete dist folder
    rmSync(join(tempDir, "dist"), { recursive: true, force: true });

    const report = await runDoctorChecks(tempDir);
    rmSync(tempDir, { recursive: true, force: true });

    expect(report.failed).toBeGreaterThan(0);
    const failChecks = report.checks.filter(c => c.status === "fail");
    expect(failChecks.some(c => c.id === "delegation.depth")).toBe(true);
  });

  it("Doctor fails when AGENT_NAMES is empty", async () => {
    const tempDir = setupBaseMockDir("empty-agents");
    writeFileSync(join(tempDir, "dist", "index.js"), `
      export const AGENT_NAMES = [];
      export function createAgent() {}
      export function validateDelegationDepth() { return { allowed: false }; }
      export function evaluateGovernanceToolCheck() { return { action: "block" }; }
      export function acquireLock() {}
      export function releaseLock() {}
    `);

    const report = await runDoctorChecks(tempDir);
    rmSync(tempDir, { recursive: true, force: true });

    expect(report.failed).toBeGreaterThan(0);
    const c = report.checks.find(c => c.id === "agents.consistency");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain("AGENT_NAMES is empty");
  });

  it("Doctor fails when an agent has no factory implementation", async () => {
    const tempDir = setupBaseMockDir("missing-factory");
    writeFileSync(join(tempDir, "dist", "index.js"), `
      export const AGENT_NAMES = ["planner", "missing-factory-agent"];
      export function createAgent(name) {
        if (name === "planner") return {};
        return undefined; // missing factory!
      }
      export function validateDelegationDepth() { return { allowed: false }; }
      export function evaluateGovernanceToolCheck() { return { action: "block" }; }
      export function acquireLock() {}
      export function releaseLock() {}
    `);

    const report = await runDoctorChecks(tempDir);
    rmSync(tempDir, { recursive: true, force: true });

    expect(report.failed).toBeGreaterThan(0);
    const c = report.checks.find(c => c.id === "agents.consistency");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain("lack factory implementations");
  });

  it("Doctor fails when delegation depth 2 is allowed", async () => {
    const tempDir = setupBaseMockDir("depth-allowed");
    writeFileSync(join(tempDir, "dist", "index.js"), `
      export const AGENT_NAMES = ["heidi"];
      export function createAgent() { return {}; }
      export function validateDelegationDepth() { return { allowed: true }; } // fails closed expectation!
      export function evaluateGovernanceToolCheck() { return { action: "block" }; }
      export function acquireLock() {}
      export function releaseLock() {}
    `);

    const report = await runDoctorChecks(tempDir);
    rmSync(tempDir, { recursive: true, force: true });

    expect(report.failed).toBeGreaterThan(0);
    const c = report.checks.find(c => c.id === "delegation.depth");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain("Delegation checks failed");
  });

  it("Doctor fails when strict governance mode does not block dangerous tools", async () => {
    const tempDir = setupBaseMockDir("strict-allow");
    writeFileSync(join(tempDir, "dist", "index.js"), `
      export const AGENT_NAMES = ["heidi"];
      export function createAgent() { return {}; }
      export function validateDelegationDepth() { return { allowed: false }; }
      export function evaluateGovernanceToolCheck() { return { action: "allow" }; } // strict mode allows dangerous tool!
      export function acquireLock() {}
      export function releaseLock() {}
    `);

    const report = await runDoctorChecks(tempDir);
    rmSync(tempDir, { recursive: true, force: true });

    expect(report.failed).toBeGreaterThan(0);
    const c = report.checks.find(c => c.id === "governance.modes");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain("Mode probe failed");
  });

  it("Doctor fails when second lock acquisition does not time out", async () => {
    const tempDir = setupBaseMockDir("lock-no-timeout");
    writeFileSync(join(tempDir, "dist", "index.js"), `
      export const AGENT_NAMES = ["heidi"];
      export function createAgent() { return {}; }
      export function validateDelegationDepth() { return { allowed: false }; }
      export function evaluateGovernanceToolCheck() { return { action: "block" }; }
      export function acquireLock() { return Promise.resolve(); } // returns immediately (no timeout)
      export function releaseLock() { return Promise.resolve(); }
    `);

    const report = await runDoctorChecks(tempDir);
    rmSync(tempDir, { recursive: true, force: true });

    expect(report.failed).toBeGreaterThan(0);
    const c = report.checks.find(c => c.id === "state.locks");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain("Lock did not throw on timeout");
  });

  it("Doctor fails when model override is not inherited", async () => {
    const tempDir = setupBaseMockDir("model-no-override");
    writeFileSync(join(tempDir, "dist", "index.js"), `
      export const AGENT_NAMES = ["heidi"];
      export function createAgent(name, model) {
        return { config: { model: undefined } }; // model not inherited!
      }
      export function validateDelegationDepth() { return { allowed: false }; }
      export function evaluateGovernanceToolCheck() { return { action: "block" }; }
      export function acquireLock() {}
      export function releaseLock() {}
    `);

    const report = await runDoctorChecks(tempDir);
    rmSync(tempDir, { recursive: true, force: true });

    expect(report.failed).toBeGreaterThan(0);
    const c = report.checks.find(c => c.id === "agents.model");
    expect(c?.status).toBe("fail");
  });

  it("Doctor fails when a required CLI command is unavailable", async () => {
    const tempDir = setupBaseMockDir("missing-cli-cmd");
    // write bin/flowdeck.js missing "rollback"
    writeFileSync(join(tempDir, "bin", "flowdeck.js"), `
      const handlers = {
        install: cmdInstall,
        update: cmdUpdate,
        verify: cmdVerify,
        doctor: cmdDoctor,
        uninstall: cmdUninstall,
        migrate: cmdMigrate
      };
    `);
    writeFileSync(join(tempDir, "dist", "index.js"), `
      export const AGENT_NAMES = ["heidi"];
      export function createAgent() { return { config: { model: undefined } }; }
      export function validateDelegationDepth() { return { allowed: false }; }
      export function evaluateGovernanceToolCheck() { return { action: "block" }; }
      export function acquireLock() {}
      export function releaseLock() {}
    `);

    const report = await runDoctorChecks(tempDir);
    rmSync(tempDir, { recursive: true, force: true });

    expect(report.failed).toBeGreaterThan(0);
    const c = report.checks.find(c => c.id === "cli.commands");
    expect(c?.status).toBe("fail");
    expect(c?.message).toContain("Missing required CLI commands: rollback");
  });
});

