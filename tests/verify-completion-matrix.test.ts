/**
 * Tests for the completion-matrix validator (scripts/verify-completion-matrix.mjs).
 *
 * The validator hardens the master-plan completion matrix against a false 100%
 * claim. These tests assert that every enforcement check actually fires:
 *
 * 1. The committed matrix (JSON + generated markdown) validates and is in sync.
 * 2. Declared completionPercent must match the computed equal-weight rollup.
 * 3. 100% completion forbids non-terminal (open / partial) included phases.
 * 4. Every phase must be accounted for in includedPhases or excludedPhases.
 * 5. "superseded" phases require a non-empty justification field.
 * 6. "superseded" phases must stay in includedPhases (denominator integrity).
 * 7. The unofficial "out-of-scope" status is rejected; only the canonical
 *    statuses CLOSED / SUPERSEDED / PARTIAL / OPEN are allowed.
 *
 * Each negative case forges a scratch copy of the real matrix (evidence paths
 * stay valid because they are repository-relative), runs the validator against
 * it, and asserts a non-zero exit plus the specific failure message.
 */

import { describe, it, expect } from "bun:test";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT_PATH = join(__dirname, "../scripts/verify-completion-matrix.mjs");
const MATRIX_PATH = join(__dirname, "../docs/master-plan/completion-matrix.json");

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runValidator(matrixPath: string): RunResult {
  try {
    const result = execSync(`node ${SCRIPT_PATH} ${matrixPath}`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    return { stdout: result.toString(), stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      exitCode: err.status ?? null,
    };
  }
}

/**
 * Load the real matrix, apply a mutation, write it to a unique temp file,
 * run the validator against it, and clean up. Returns the run result.
 */
function runMutated(mutate: (matrix: any) => void): RunResult {
  const base = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
  const tmpPath = join(tmpdir(), `matrix-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    mutate(base);
    writeFileSync(tmpPath, JSON.stringify(base, null, 2), "utf8");
    return runValidator(tmpPath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

describe("verify-completion-matrix.mjs", () => {
  it("passes on the committed matrix and confirms the markdown report is in sync", () => {
    const { stdout, exitCode } = runValidator(MATRIX_PATH);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("completion-matrix validation PASSED");
    expect(stdout).toContain("(in sync)");
  });

  it("fails when completionPercent diverges from the computed equal-weight rollup", () => {
    const { stderr, exitCode } = runMutated((m) => {
      m.overall.completionPercent = 90; // all included phases are at 100 → rollup is 100
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("diverges from computed rollup");
  });

  it("fails when 100% is claimed but an included phase is non-terminal", () => {
    const { stderr, exitCode } = runMutated((m) => {
      m.phases.find((p: any) => p.id === "9")!.status = "partial"; // forged: overall stays 100
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("completion 100% claimed but non-terminal phases");
    expect(stderr).toContain("9:partial");
  });

  it("fails when a phase is missing from both includedPhases and excludedPhases", () => {
    const { stderr, exitCode } = runMutated((m) => {
      m.overall.includedPhases = m.overall.includedPhases.filter((id: string) => id !== "12");
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("phases not in includedPhases or excludedPhases");
    expect(stderr).toContain("12");
  });

  it("fails when a superseded phase has no justification", () => {
    const { stderr, exitCode } = runMutated((m) => {
      const phase = m.phases.find((p: any) => p.id === "10")!;
      phase.status = "superseded";
      delete phase.justification;
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('phase 10: "superseded" requires non-empty justification');
  });

  it("fails when a superseded phase is moved to excludedPhases (denominator tampering)", () => {
    const { stderr, exitCode } = runMutated((m) => {
      // Phase 10 is superseded in the committed matrix; moving it to
      // excludedPhases silently deletes required work from the denominator
      m.overall.includedPhases = m.overall.includedPhases.filter((id: string) => id !== "10");
      m.overall.excludedPhases = ["10"];
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("superseded phases must stay in includedPhases");
  });

  it("fails on the unofficial out-of-scope status", () => {
    const { stderr, exitCode } = runMutated((m) => {
      m.phases.find((p: any) => p.id === "12")!.status = "out-of-scope";
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('phase 12: invalid status "out-of-scope"');
  });

  it("fails on an open requirement while 100% is claimed", () => {
    const { stderr, exitCode } = runMutated((m) => {
      m.phases.find((p: any) => p.id === "9")!.status = "open";
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("completion 100% claimed but non-terminal phases");
    expect(stderr).toContain("9:open");
  });

  it("fails when a non-terminal phase is hidden in excludedPhases with 100% claimed", () => {
    const { stderr, exitCode } = runMutated((m) => {
      // Move a partial phase to excludedPhases while still claiming 100%
      m.phases.find((p: any) => p.id === "3")!.status = "partial";
      m.overall.includedPhases = m.overall.includedPhases.filter((id: string) => id !== "3");
      m.overall.excludedPhases = ["3"];
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("non-terminal phases must not be in excludedPhases");
  });

  it("fails when 100% is claimed with any phase in excludedPhases", () => {
    const { stderr, exitCode } = runMutated((m) => {
      m.overall.includedPhases = m.overall.includedPhases.filter((id: string) => id !== "11");
      m.overall.excludedPhases = ["11"];
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("completion 100% claimed but phases are excluded");
  });
});
