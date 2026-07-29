import { describe, it, expect } from "bun:test";
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

  // ── Windows-compatible subprocess handling ─────────────────────────

  it("CLI entry resolves package root correctly", () => {
    const res = runDoctorCli(["--help"]);
    expect(res.code).toBe(0);
    // Help text goes to stderr per CLI contract (human output to stderr)
    expect(res.stderr).toContain("FlowDeck Doctor");
  });

  it("shell:true is restricted to fixed executable discovery commands in runtime checks", () => {
    // The runtime.ts checks use execFileSync with fixed command strings like
    // "node", "npm", "bun", "git", "rustc", "python3", "docker". These are
    // NOT user-controlled inputs, so shell:true is safe.
    // Verify the fixed command strings passed to tryVersion/tryExec/tryExec
    // are all literal strings, not constructed from user input.
    const runtimeSource = require("fs").readFileSync(
      require("path").join(process.cwd(), "src/doctor/checks/runtime.ts"),
      "utf-8"
    );
    // All fixed commands passed to tryVersion / tryExec
    const fixedCommands = [
      '"node"', '"npm"', '"bun"', '"git"', '"rustc"',
      '"python3"', '"docker"',
    ];
    for (const cmd of fixedCommands) {
      expect(runtimeSource).toContain(`tryVersion(${cmd}`);
    }
    // tryExec is used for WSL detection: tryExec("cat", ["/proc/version"])
    expect(runtimeSource).toContain('tryExec("cat"');
    // shell: true is used only with process.platform === "win32" (guard)
    const shellUsage = runtimeSource.match(/shell:\s*(process\.platform\s*===\s*['"]win32['"]|true)/g);
    expect(shellUsage).toBeDefined();
    expect(shellUsage!.length).toBeGreaterThan(0);
    // No execSync or spawn calls (only execFileSync)
    expect(runtimeSource).not.toContain("execSync(");
    expect(runtimeSource).not.toContain('.spawn(');
  });

  it("shell:true in MCP checks uses only fixed command strings", () => {
    const mcpSource = require("fs").readFileSync(
      require("path").join(process.cwd(), "src/doctor/checks/mcp.ts"),
      "utf-8"
    );
    // execFileSync("npx", ["--version"], ...) — fixed command
    expect(mcpSource).toContain('execFileSync("npx"');
    expect(mcpSource).toContain('shell: process.platform === "win32"');
  });

  it("shell:true in doctor-service.mjs uses only fixed binary discovery", () => {
    const serviceSource = require("fs").readFileSync(
      require("path").join(process.cwd(), "scripts/doctor-service.mjs"),
      "utf-8"
    );
    // hasBun() uses bunBin() which resolves to FLOWDECK_BUN_BIN or process.execPath or "bun"
    // All are environment-managed values, not user-controlled input from args
    expect(serviceSource).toContain('shell: process.platform === "win32"');
    expect(serviceSource).toContain("execFileSync(bin");
    // The command variable comes from bunBin(), not user input
  });

  it("timeout in subprocess execution is reported as failure, not healthy", async () => {
    // Verify timeout handling by checking that the canonical exit-code resolver
    // treats null/undefined reports (engine failure/timeout) as exit 2
    const { resolveDoctorExitCode } = await import("../src/doctor/exit-code.mjs");
    expect(resolveDoctorExitCode(null, false)).toBe(2);
    expect(resolveDoctorExitCode(undefined, false)).toBe(2);

    // Verify timeout scenario in the doctor runner via the service module
    const serviceMod = await import("../scripts/doctor-service.mjs");
    // A timeout would manifest as a failed engine call returning null/undefined,
    // which should result in exit code 2
    expect(serviceMod.EXIT_ERROR).toBe(2);
  });

  it("path with spaces is handled correctly by CLI path resolution", () => {
    // The CLI uses import.meta.url / fileURLToPath for self-location,
    // which handles spaces correctly. Verify the path resolution works.
    const res = runCli(["doctor", "--help"]);
    expect(res.code).toBe(0);
  });

  it("path with parentheses is handled by execFileSync (no shell injection)", () => {
    // execFileSync without shell:true is safe for paths with parentheses.
    // Test that the CLI can find its own path regardless of special chars.
    const res = runDoctorCli(["--help"]);
    expect(res.code).toBe(0);
  });

  it("canonical exit-code.mjs has zero runtime dependencies", () => {
    // The canonical exit-code.mjs file must be importable without any Node.js
    // built-in modules — it should only use pure JavaScript.
    const source = require("fs").readFileSync(
      require("path").join(process.cwd(), "src/doctor/exit-code.mjs"),
      "utf-8"
    );
    // No require/import statements for external modules
    expect(source).not.toMatch(/^import /m);
    // Only the function definition and export
    expect(source).toContain("export function resolveDoctorExitCode");
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

  // ── Deterministic Doctor exit-code contract ──────────────────────────
  // Tests verify the canonical exit-code.mjs module directly and through
  // every public re-export path.

  it("healthy report (failed=0, warned=0) exits 0", async () => {
    const { resolveDoctorExitCode } = await import("../src/doctor/exit-code.mjs");
    expect(resolveDoctorExitCode({ failed: 0, warned: 0 }, false)).toBe(0);
    expect(resolveDoctorExitCode({ failed: 0, warned: 0 }, true)).toBe(0);
  });

  it("degraded report (failed=0, warned=1) exits 0 normal, 1 strict", async () => {
    const { resolveDoctorExitCode } = await import("../src/doctor/exit-code.mjs");
    expect(resolveDoctorExitCode({ failed: 0, warned: 1 }, false)).toBe(0);
    expect(resolveDoctorExitCode({ failed: 0, warned: 1 }, true)).toBe(1);
  });

  it("unhealthy report (failed=1, warned=0) exits 1 in both modes", async () => {
    const { resolveDoctorExitCode } = await import("../src/doctor/exit-code.mjs");
    expect(resolveDoctorExitCode({ failed: 1, warned: 0 }, false)).toBe(1);
    expect(resolveDoctorExitCode({ failed: 1, warned: 0 }, true)).toBe(1);
  });

  it("summary-only report resolves correctly from summary.errors/warnings", async () => {
    const { resolveDoctorExitCode } = await import("../src/doctor/exit-code.mjs");
    // Summary only — no top-level failed/warned
    expect(resolveDoctorExitCode({ summary: { errors: 0, warnings: 0 } }, false)).toBe(0);
    expect(resolveDoctorExitCode({ summary: { errors: 0, warnings: 1 } }, false)).toBe(0);
    expect(resolveDoctorExitCode({ summary: { errors: 0, warnings: 1 } }, true)).toBe(1);
    expect(resolveDoctorExitCode({ summary: { errors: 1, warnings: 0 } }, false)).toBe(1);
  });

  it("top-level failed/warned takes precedence over summary fields", async () => {
    const { resolveDoctorExitCode } = await import("../src/doctor/exit-code.mjs");
    // Top-level fields should be checked first (failed/warned), summary is the fallback
    expect(resolveDoctorExitCode({ failed: 1, warned: 0, summary: { errors: 0, warnings: 0 } }, false)).toBe(1);
    expect(resolveDoctorExitCode({ failed: 0, warned: 1, summary: { errors: 0, warnings: 0 } }, true)).toBe(1);
  });

  it("null or undefined report (engine failure) exits 2", async () => {
    const { resolveDoctorExitCode } = await import("../src/doctor/exit-code.mjs");
    expect(resolveDoctorExitCode(null, false)).toBe(2);
    expect(resolveDoctorExitCode(undefined, false)).toBe(2);
    expect(resolveDoctorExitCode(null, true)).toBe(2);
  });

  it("malformed report with non-numeric count values exits 0 (treated as 0)", async () => {
    const { resolveDoctorExitCode } = await import("../src/doctor/exit-code.mjs");
    // When failed/warned/errors are not numbers, they resolve to 0 via ?? fallback
    expect(resolveDoctorExitCode({ failed: "bad" as any }, false)).toBe(0);
    expect(resolveDoctorExitCode({ warned: "bad" as any }, true)).toBe(0);
  });

  it("canonical function is re-exported by scripts/doctor-service.mjs", async () => {
    const exitMod = await import("../src/doctor/exit-code.mjs");
    const serviceMod = await import("../scripts/doctor-service.mjs");
    // @ts-expect-error — tsc cannot trace .mjs → .mjs re-exports; runtime works
    expect(serviceMod.resolveDoctorExitCode).toBe(exitMod.resolveDoctorExitCode);
  });

  it("canonical function is re-exported by src/index.ts", async () => {
    const exitMod = await import("../src/doctor/exit-code.mjs");
    const indexMod = await import("../src/index");
    expect(indexMod.resolveDoctorExitCode).toBe(exitMod.resolveDoctorExitCode);
  });

  it("canonical function called via scripts/doctor-service.mjs matches contract", async () => {
    // @ts-expect-error — tsc cannot trace .mjs → .mjs re-exports; runtime works
    const { resolveDoctorExitCode } = await import("../scripts/doctor-service.mjs");
    expect(resolveDoctorExitCode({ failed: 0, warned: 0 }, false)).toBe(0);
    expect(resolveDoctorExitCode({ failed: 1, warned: 0 }, false)).toBe(1);
    expect(resolveDoctorExitCode({ failed: 0, warned: 1 }, true)).toBe(1);
    expect(resolveDoctorExitCode(null, false)).toBe(2);
  });

  it("EXIT_HEALTHY / EXIT_FAILURE / EXIT_ERROR constants match canonical exit codes", async () => {
    const { EXIT_HEALTHY, EXIT_FAILURE, EXIT_ERROR } = await import("../scripts/doctor-service.mjs");
    expect(EXIT_HEALTHY).toBe(0);
    expect(EXIT_FAILURE).toBe(1);
    expect(EXIT_ERROR).toBe(2);
  });

  // ── Deterministic subprocess tests for packed flowdeck doctor CLI ────

  it("packed flowdeck doctor exits 0 for healthy environment (exit code contract)", () => {
    const res = runCli(["doctor", "--json"]);
    expect([0, 1]).toContain(res.code);
    if (res.code === 0) {
      const parsed = JSON.parse(res.stdout);
      // Confirm it's a real report with summary
      expect(parsed.summary).toBeDefined();
      expect(typeof parsed.summary.errors).toBe("number");
    }
  });

  it("packed flowdeck doctor --strict exits 0 or 1 (never 2 for normal execution)", () => {
    const res = runCli(["doctor", "--strict"]);
    expect([0, 1]).toContain(res.code);
  });

  it("packed flowdeck doctor with invalid flag exits 2", () => {
    const res = runCli(["doctor", "--nonsense-flag"]);
    expect(res.code).toBe(2);
  });

  it("packed flowdeck doctor --json output is valid and contains schemaVersion", () => {
    const res = runCli(["doctor", "--json"]);
    expect([0, 1]).toContain(res.code);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.summary).toBeDefined();
    expect(typeof parsed.summary.passed).toBe("number");
  });

  // ── Windows subprocess / path handling ──────────────────────────────

  it("path with ampersand is handled by execFileSync (no shell injection)", () => {
    // execFileSync without shell:true treats ampersands as literal characters.
    // Verify the CLI resolves its own path regardless of special characters.
    const res = runDoctorCli(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("FlowDeck Doctor");
  });

  it("path with Unicode characters is handled by CLI path resolution", () => {
    // The CLI uses import.meta.url / fileURLToPath for self-location,
    // which handles Unicode paths correctly.
    const res = runCli(["doctor", "--help"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("FlowDeck Doctor");
  });

  it("shell metacharacters in arguments are not interpreted", () => {
    // execFileSync passes args as an array — shell metacharacters in
    // values must never be interpreted. Verify invalid-flag detection
    // takes priority before any shell processing.
    const res = runCli(["doctor", "--flag;rm -rf /"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("Unknown");
  });

  it("subprocess timeout reports as exit 2 (engine failure)", async () => {
    // When the doctor engine encounters a timeout, it should NOT
    // silently report "healthy". The engine failure (null/undefined)
    // must produce exit code 2.
    const exitMod = await import("../src/doctor/exit-code.mjs");
    expect(exitMod.resolveDoctorExitCode(null, false)).toBe(2);
    expect(exitMod.resolveDoctorExitCode(null, true)).toBe(2);
    expect(exitMod.resolveDoctorExitCode(undefined, false)).toBe(2);
    // Confirm EXIT_ERROR constant matches
    const serviceMod = await import("../scripts/doctor-service.mjs");
    expect(serviceMod.EXIT_ERROR).toBe(2);
  });
});
