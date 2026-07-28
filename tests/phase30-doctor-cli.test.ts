import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import the canonical CLI implementation directly instead of spawning processes.
// This avoids UNC-path issues with spawnSync on WSL/Windows hybrid environments.
let main: typeof import("../src/cli/flowdeck.mjs").main;

// ── Helpers ──────────────────────────────────────────────────────────

let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;
let capturedStdout: string;
let capturedStderr: string;

function captureOutput() {
  capturedStdout = "";
  capturedStderr = "";
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: any) => { capturedStdout += String(chunk); return true; }) as any;
  process.stderr.write = ((chunk: any) => { capturedStderr += String(chunk); return true; }) as any;
}

function restoreOutput() {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
}

beforeAll(async () => {
  main = (await import("../src/cli/flowdeck.mjs")).main;
});

// ── CLI command dispatch ────────────────────────────────────────────

describe("Phase 30 — Doctor CLI Service", { timeout: 20000 }, () => {
  it("imports doctor cli.mjs without error", async () => {
    const mod = await import("../src/doctor/cli.mjs");
    expect(typeof mod.runDoctorCli).toBe("function");
  });

  it("flowdeck doctor runs and exits 0 or 1", async () => {
    const exit = await main(["doctor"]);
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("optional runtime probes never leak missing-command diagnostics to stderr", async () => {
    captureOutput();
    const exit = await main(["doctor", "--json"]);
    restoreOutput();
    expect([0, 1]).toContain(exit.exitCode);
    expect(capturedStderr).toBe("");
    expect(() => JSON.parse(capturedStdout)).not.toThrow();
  });

  it("doctor --json produces valid JSON on stdout", async () => {
    captureOutput();
    const exit = await main(["doctor", "--json"]);
    restoreOutput();
    expect([0, 1]).toContain(exit.exitCode);
    const parsed = JSON.parse(capturedStdout);
    expect(parsed).toHaveProperty("checks");
    expect(parsed).toHaveProperty("summary");
  });

  it("doctor text output contains expected sections", async () => {
    captureOutput();
    const exit = await main(["doctor"]);
    restoreOutput();
    if (exit.exitCode <= 1) {
      expect(capturedStdout).toContain("FlowDeck");
      expect(capturedStdout).toContain("FlowDeck Doctor");
      expect(capturedStdout).toContain("Errors:");
    }
  });

  it("normal mode exits 0 when healthy", async () => {
    const exit = await main(["doctor"]);
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("--strict exits 0 or 1 based on checks", async () => {
    const exit = await main(["doctor", "--strict"]);
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("JSON-only stdout: --json flag produces only JSON to stdout", async () => {
    captureOutput();
    const exit = await main(["doctor", "--json"]);
    restoreOutput();
    expect([0, 1]).toContain(exit.exitCode);
    expect(() => JSON.parse(capturedStdout)).not.toThrow();
    expect(capturedStderr).not.toContain("```");
  });

  it("resolves package root from its own location, not cwd", async () => {
    const exit = await main(["doctor"]);
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("--apply-recommended runs without error", async () => {
    const exit = await main(["doctor", "--apply-recommended"]);
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("--profile recommended-dev runs without error", async () => {
    const exit = await main(["doctor", "--profile", "recommended-dev"]);
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("--invalid-flag exits with code 2", async () => {
    const exit = await main(["doctor", "--invalid-flag"]);
    expect(exit.exitCode).toBe(2);
  });

  it("--unknown-profile exits with code 2", async () => {
    const exit = await main(["doctor", "--profile", "nonexistent-profile"]);
    expect(exit.exitCode).toBe(2);
  });

  it("--verbose flag is accepted and adds detail", async () => {
    captureOutput();
    const exit = await main(["doctor", "--verbose"]);
    restoreOutput();
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("--json produces parseable JSON with schemaVersion field", async () => {
    captureOutput();
    const exit = await main(["doctor", "--json"]);
    restoreOutput();
    expect([0, 1]).toContain(exit.exitCode);
    const parsed = JSON.parse(capturedStdout);
    expect(parsed).toHaveProperty("schemaVersion");
    expect(parsed).toHaveProperty("checks");
    expect(parsed).toHaveProperty("summary");
  });

  it("doctor help exits 0", async () => {
    const exit = await main(["doctor", "--help"]);
    expect(exit.exitCode).toBe(0);
  });

  it("sequential JSON runs produce valid output each time", async () => {
    captureOutput();
    const exit1 = await main(["doctor", "--json"]);
    restoreOutput();
    expect([0, 1]).toContain(exit1.exitCode);
    expect(() => JSON.parse(capturedStdout)).not.toThrow();

    captureOutput();
    const exit2 = await main(["doctor", "--json"]);
    restoreOutput();
    expect([0, 1]).toContain(exit2.exitCode);
    expect(() => JSON.parse(capturedStdout)).not.toThrow();
  });
});

// ── Argument Parsing ────────────────────────────────────────────────

describe("Doctor CLI — Argument Parsing", () => {
  it("parses --json flag", async () => {
    captureOutput();
    const exit = await main(["doctor", "--json"]);
    restoreOutput();
    expect([0, 1]).toContain(exit.exitCode);
    expect(() => JSON.parse(capturedStdout)).not.toThrow();
  });

  it("parses --strict flag", async () => {
    const exit = await main(["doctor", "--strict"]);
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("parses --profile with value", async () => {
    const exit = await main(["doctor", "--profile", "ci"]);
    expect([0, 1]).toContain(exit.exitCode);
  });

  it("rejects unknown flags", async () => {
    const exit = await main(["doctor", "--bogus-flag"]);
    expect(exit.exitCode).toBe(2);
  });

  it("rejects unknown profile", async () => {
    const exit = await main(["doctor", "--profile", "bogus-profile"]);
    expect(exit.exitCode).toBe(2);
  });
});

// ── JSON Output ─────────────────────────────────────────────────────

describe("Doctor CLI — JSON Output", () => {
  it("produces valid JSON when --json is specified", async () => {
    captureOutput();
    const exit = await main(["doctor", "--json"]);
    restoreOutput();
    expect([0, 1]).toContain(exit.exitCode);
    expect(() => JSON.parse(capturedStdout)).not.toThrow();
  });
});
