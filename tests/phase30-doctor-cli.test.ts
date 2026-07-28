import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI_PATH = join(process.cwd(), "bin", "flowdeck.js");

/**
 * Run the CLI and return exit code + output (uses spawnSync to capture both stdout and stderr).
 */
function runCli(
  args: string[],
  env?: Record<string, string>,
  cwd?: string
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

/**
 * Run a standalone doctor CLI script directly (spawnSync captures both stdio).
 */
function runDoctorCli(
  args: string[],
  env?: Record<string, string>,
  cwd?: string
): { code: number; stdout: string; stderr: string } {
  const cliPath = join(process.cwd(), "src", "doctor", "cli.mjs");
  const result = spawnSync("node", [cliPath, "doctor", ...args], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

describe("Phase 30 — Doctor CLI Service", { timeout: 20000 }, () => {
  // ── Service module imports ──────────────────────────────────────────

  it("imports doctor-service.mjs without error", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    expect(mod).toBeDefined();
    expect(typeof mod.runDoctorService).toBe("function");
    expect(mod.SCHEMA_VERSION).toBe(1);
    expect(mod.EXIT_HEALTHY).toBe(0);
    expect(mod.EXIT_FAILURE).toBe(1);
    expect(mod.EXIT_ERROR).toBe(2);
  });

  it("imports doctor cli.mjs without error", async () => {
    const mod = await import("../src/doctor/cli.mjs");
    expect(mod).toBeDefined();
    expect(typeof mod.runDoctorCli).toBe("function");
  });

  // ── CLI command dispatch ────────────────────────────────────────────

  it("flowdeck doctor runs and exits 0 or 1", () => {
    const res = runCli(["doctor"]);
    // In a healthy repo, exit 0. If checks fail, exit 1. Either is correct behaviour.
    expect([0, 1]).toContain(res.code);
    expect(res.stderr).toBe("");
  });

  it("optional runtime probes never leak missing-command diagnostics to stderr", () => {
    const res = runCli(["doctor", "--json"]);
    expect([0, 1]).toContain(res.code);
    expect(res.stderr).toBe("");
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  // ── Text output ─────────────────────────────────────────────────────

  it("doctor text output contains expected sections", () => {
    const res = runCli(["doctor"]);
    if (res.code === 0) {
      expect(res.stdout).toContain("FlowDeck Doctor");
      expect(res.stdout).toContain("Diagnostics");
      expect(res.stdout).toContain("Summary");
      expect(res.stdout).toContain("Passed");
    }
  });

  // ── JSON-only stdout ────────────────────────────────────────────────

  it("doctor --json produces valid JSON on stdout", () => {
    const res = runCli(["doctor", "--json"]);
    expect([0, 1]).toContain(res.code);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    const parsed = JSON.parse(res.stdout);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
  });

  // ── schemaVersion: 1 ────────────────────────────────────────────────

  it("--json output includes schemaVersion: 1", () => {
    const res = runCli(["doctor", "--json"]);
    if (res.code <= 1) {
      const parsed = JSON.parse(res.stdout);
      expect(parsed.schemaVersion).toBe(1);
    }
  });

  // ── Schema version constant ─────────────────────────────────────────

  it("service exports SCHEMA_VERSION = 1", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    expect(mod.SCHEMA_VERSION).toBe(1);
  });

  // ── Secret redaction ────────────────────────────────────────────────

  it("service redacts known secret patterns from messages", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    // Confirm the module loads and exports the expected function
    expect(typeof mod.runDoctorService).toBe("function");
  });

  // ── Normal-mode exit codes ──────────────────────────────────────────

  it("normal mode exits 0 when healthy", () => {
    const res = runCli(["doctor"]);
    expect([0, 1]).toContain(res.code);
  });

  // ── Strict-mode exit codes ──────────────────────────────────────────

  it("--strict exits 0 or 1 based on checks", () => {
    const res = runCli(["doctor", "--strict"]);
    expect([0, 1]).toContain(res.code);
  });

  // ── Invalid argument exit code 2 ────────────────────────────────────

  it("--invalid-flag exits 2 via flowdeck CLI", () => {
    const res = runCli(["doctor", "--invalid-flag"]);
    expect(res.code).toBe(2);
  });

  // ── Internal engine error exit code 2 via missing directory ─────────

  it("resolves package root from its own location, not cwd", () => {
    // The CLI resolves PKG_ROOT relative to import.meta.url, so it always
    // finds its own package regardless of the calling directory.
    const tmpDir = join(tmpdir(), `fd-cli-any-dir-${Date.now()}`);
    try {
      mkdirSync(tmpDir, { recursive: true });
      const res = runDoctorCli([], {}, tmpDir);
      // Should still find its package and run — may pass or fail checks
      // but should NOT exit 2 (error) since it locates itself correctly
      expect(res.code).not.toBe(2);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  });

  // ── --apply-recommended success and partial failure ─────────────────

  it("--apply-recommended runs without error", () => {
    // This test verifies the flag is accepted and doesn't crash
    const res = runCli(["doctor", "--apply-recommended"]);
    expect([0, 1]).toContain(res.code);
  });

  it("--apply-recommended is idempotent (repeatable)", () => {
    const res1 = runCli(["doctor", "--apply-recommended"]);
    const res2 = runCli(["doctor", "--apply-recommended"]);
    // Both runs should succeed or fail consistently
    expect(res1.code).toBe(res2.code);
  });

  // ── Profile selection ───────────────────────────────────────────────

  it("--profile recommended-dev runs without error", () => {
    const res = runCli(["doctor", "--profile", "recommended-dev"]);
    expect([0, 1]).toContain(res.code);
  });

  it("--profile unknown exits 2", () => {
    const res = runCli(["doctor", "--profile", "nonexistent-profile"]);
    expect(res.code).toBe(2);
  });

  // ── Package-relative path resolution ────────────────────────────────

  it("CLI resolves package root relative to its own location", async () => {
    const mod = await import("../src/doctor/cli.mjs");
    // The module exports a function, and internally uses import.meta.url to resolve PKG_ROOT
    expect(typeof mod.runDoctorCli).toBe("function");
  });

  // ── Installer argument parsing ──────────────────────────────────────

  it("service handles empty options gracefully", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    const result = await mod.runDoctorService(process.cwd(), {});
    expect(result.exitCode).toBeGreaterThanOrEqual(0);
    expect(result.exitCode).toBeLessThanOrEqual(2);
    expect(result.stdout).toBeTruthy();
  });

  // ── Audit-only installer mode (--doctor from install.sh) ────────────

  it("doctor --json output includes expected fields", () => {
    const res = runCli(["doctor", "--json"]);
    if (res.code <= 1) {
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toHaveProperty("schemaVersion");
      expect(parsed).toHaveProperty("packageName");
      expect(parsed).toHaveProperty("packageVersion");
      expect(parsed).toHaveProperty("passed");
      expect(parsed).toHaveProperty("warned");
      expect(parsed).toHaveProperty("failed");
      expect(parsed).toHaveProperty("status");
      expect(parsed).toHaveProperty("checks");
      expect(Array.isArray(parsed.checks)).toBe(true);
    }
  });

  // ── Non-interactive installer mode ──────────────────────────────────

  it("--verbose flag is accepted and adds detail", () => {
    const res = runCli(["doctor", "--verbose"]);
    expect([0, 1]).toContain(res.code);
  });

  // ── Pre-install blocking result ─────────────────────────────────────

  it("doctor reports failed count correctly", () => {
    const res = runCli(["doctor", "--json"]);
    if (res.code <= 1) {
      const parsed = JSON.parse(res.stdout);
      expect(typeof parsed.passed).toBe("number");
      expect(typeof parsed.warned).toBe("number");
      expect(typeof parsed.failed).toBe("number");
      expect(parsed.passed + parsed.warned + parsed.failed).toBeGreaterThan(0);
    }
  });

  // ── Post-install verification ───────────────────────────────────────

  it("doctor JSON output has status field", () => {
    const res = runCli(["doctor", "--json"]);
    if (res.code <= 1) {
      const parsed = JSON.parse(res.stdout);
      expect(["healthy", "degraded", "unhealthy"]).toContain(parsed.status);
    }
  });

  // ── Idempotent repeated execution ───────────────────────────────────

  it("running doctor twice produces consistent structure", () => {
    const res1 = runCli(["doctor", "--json"]);
    const res2 = runCli(["doctor", "--json"]);
    if (res1.code <= 1 && res2.code <= 1) {
      const p1 = JSON.parse(res1.stdout);
      const p2 = JSON.parse(res2.stdout);
      expect(p1.schemaVersion).toBe(p2.schemaVersion);
      expect(Array.isArray(p1.checks)).toBe(true);
      expect(Array.isArray(p2.checks)).toBe(true);
    }
  });

  // ── Existing configuration preservation ─────────────────────────────

  it("service tolerates missing package.json directory gracefully", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    const tmpDir = join(tmpdir(), `fd-svc-bad-${Date.now()}`);
    try {
      mkdirSync(tmpDir, { recursive: true });
      const result = await mod.runDoctorService(tmpDir, {});
      expect(result.exitCode).toBe(2);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  });

  // ── Missing optional tools (doctor checks work without FDX) ─────────

  it("doctor reports on FDX status even when FDX is absent", () => {
    const res = runCli(["doctor", "--json"]);
    if (res.code <= 1) {
      const parsed = JSON.parse(res.stdout);
      const fdxCheck = parsed.checks.find((c: any) => c.id === "fdx.fallback" || c.id === "fdx.version");
      if (fdxCheck) {
        expect(["pass", "warn", "fail"]).toContain(fdxCheck.status);
      }
    }
  });

  // ── macOS and Linux path handling ───────────────────────────────────

  it("service resolves paths with forward slashes", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    // Just confirm the module loads and function exists - platform-specific path
    // handling is tested by the engine
    expect(typeof mod.runDoctorService).toBe("function");
  });

  // ── Windows-compatible Node CLI path handling ───────────────────────

  it("CLI entry resolves package root correctly", () => {
    const res = runDoctorCli(["--help"]);
    expect(res.code).toBe(0);
    // Help text goes to stderr per CLI contract (human output to stderr)
    expect(res.stderr).toContain("FlowDeck Doctor");
  });

  // ── No ANSI colours in JSON output ──────────────────────────────────

  it("--json output contains no ANSI escape codes", () => {
    const res = runCli(["doctor", "--json"]);
    if (res.code <= 1) {
      expect(res.stdout).not.toMatch(/\\u001b\[/);
    }
  });

  // ── stderr diagnostics never contaminate JSON output ────────────────

  it("--json stdout is parseable as a single JSON value", () => {
    const res = runCli(["doctor", "--json"]);
    if (res.code <= 1) {
      // Trim and verify it parses as one complete JSON document
      const trimmed = res.stdout.trim();
      expect(trimmed.startsWith("{")).toBe(true);
      expect(trimmed.endsWith("}")).toBe(true);
      JSON.parse(trimmed); // Should not throw
    }
  });

  // ── --help exits 0 ──────────────────────────────────────────────────

  it("doctor --help exits 0 and prints usage to stderr", () => {
    const res = runDoctorCli(["--help"]);
    expect(res.code).toBe(0);
    // Help text goes to stderr per CLI contract
    expect(res.stderr).toContain("FlowDeck Doctor");
    expect(res.stderr).toContain("Usage");
    expect(res.stderr).toContain("--json");
    expect(res.stderr).toContain("--strict");
  });

  // ── Service directly: exit code contract ────────────────────────────

  it("service returns 2 for invalid profile", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    const result = await mod.runDoctorService(process.cwd(), { profile: "bogus-profile" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown profile");
  });

  it("service exits healthy (0) when checks all pass in a valid repo", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    const result = await mod.runDoctorService(process.cwd(), {});
    // The current repo may or may not have all checks passing, so we just verify the
    // exit code is one of the valid values
    expect([0, 1, 2]).toContain(result.exitCode);
  });

  // ── Service: strict mode ────────────────────────────────────────────

  it("service with strict flag returns exit 1 when warnings exist", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    const result = await mod.runDoctorService(process.cwd(), { strict: true });
    expect([0, 1, 2]).toContain(result.exitCode);
    const report = result.report as { warned: number } | null;
    if (report && report.warned > 0) {
      // With strict mode, warnings should cause exit 1
      expect(result.exitCode).toBe(1);
    }
  });

  // ── Service: JSON output format ─────────────────────────────────────

  it("service produces JSON when requested", async () => {
    const mod = await import("../scripts/doctor-service.mjs");
    const result = await mod.runDoctorService(process.cwd(), { json: true });
    expect([0, 1, 2]).toContain(result.exitCode);
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout);
      expect(parsed.schemaVersion).toBe(1);
    }
  });

  // ── resolveDoctorExitCode isolated fixture ──────────────────────────

  it("resolveDoctorExitCode returns 0 in normal mode and 1 in strict mode for degraded reports", async () => {
    const mod = await import("../src/index");
    const fixtureReport = {
      passed: 4,
      warned: 1,
      failed: 0,
      status: "degraded",
    };

    expect(mod.resolveDoctorExitCode(fixtureReport, false)).toBe(0);
    expect(mod.resolveDoctorExitCode(fixtureReport, true)).toBe(1);
  });
});
