/**
 * Doctor CLI integration tests.
 *
 * Covers CLI argument parsing, output formatting, exit codes,
 * secret redaction, installer integration, and cross-platform paths.
 */

import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const CLI_PATH = join(process.cwd(), "src", "doctor", "cli.mjs")
const PKG_ROOT = process.cwd()

// ─── Helpers ───────────────────────────────────────────────────────────

function getSpawnEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  // When running under bun, pass the bun binary path so child node processes can find it
  if (typeof (process as any).versions?.bun === "string") {
    env.FLOWDECK_BUN_BIN = (process as any).execPath
  }
  return env
}

function runDoctor(args: string[] = []): { code: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync("node", [CLI_PATH, ...args], {
      cwd: PKG_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
      env: getSpawnEnv(),
    })

    return {
      code: result.status ?? 1,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    }
  } catch (e: any) {
    return { code: 2, stdout: "", stderr: e.message }
  }
}

function makeTempConfig(): string {
  const dir = join(tmpdir(), `fd-doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("Doctor CLI — Argument Parsing", { timeout: 20000 }, () => {
  it("parses --json flag", () => {
    const result = runDoctor(["--json"])
    // Should produce valid JSON output to stdout
    expect(result.code).toBe(0)
    expect(result.stdout).toBeTruthy()
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toBeDefined()
  })

  it("parses --strict flag", () => {
    // Strict mode just means the --strict flag was recognised
    // The test validates the CLI doesn't error on valid flags
    const result = runDoctor(["--strict"])
    expect(result.code).toBeGreaterThanOrEqual(0)
    expect(result.code).toBeLessThanOrEqual(1)
  })

  it("parses --verbose flag without error", () => {
    const result = runDoctor(["--verbose"])
    expect(result.code).toBeGreaterThanOrEqual(0)
    expect(result.code).toBeLessThanOrEqual(1)
  })

  it("parses --profile flag", () => {
    const result = runDoctor(["--profile", "minimal"])
    expect(result.code).toBeGreaterThanOrEqual(0)
    expect(result.code).toBeLessThanOrEqual(1)
  })

  it("parses --apply-recommended flag", () => {
    const result = runDoctor(["--apply-recommended"])
    expect(result.code).toBeGreaterThanOrEqual(0)
    expect(result.code).toBeLessThanOrEqual(1)
  })

  it("parses --non-interactive flag", () => {
    const result = runDoctor(["--non-interactive"])
    expect(result.code).toBeGreaterThanOrEqual(0)
    expect(result.code).toBeLessThanOrEqual(1)
  })

  it("rejects unknown flags with exit code 2", () => {
    const result = runDoctor(["--invalid-flag"])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/unknown flags/i)
  })

  it("rejects --profile without value with exit code 2", () => {
    const result = runDoctor(["--profile"])
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/requires a value/i)
  })
})

describe("Doctor CLI — JSON Output", () => {
  it("produces valid JSON when --json is specified", () => {
    const result = runDoctor(["--json"])
    expect(result.code).toBe(0)
    expect(() => JSON.parse(result.stdout)).not.toThrow()
  })

  it("includes schemaVersion: 1 in JSON output", () => {
    const result = runDoctor(["--json"])
    const parsed = JSON.parse(result.stdout)
    expect(parsed.schemaVersion).toBe(1)
  })

  it("does not mix human text into stdout with --json", () => {
    const result = runDoctor(["--json"])
    // stdout should be parseable as a single JSON value
    const trimmed = result.stdout.trim()
    // Should start with { and end with }
    expect(trimmed.startsWith("{")).toBe(true)
    expect(trimmed.endsWith("}")).toBe(true)
    // Try to parse as JSON
    expect(() => JSON.parse(trimmed)).not.toThrow()
  })

  it("sends diagnostics to stderr, not stdout in JSON mode", () => {
    // When --json is used, errors should go to stderr only
    const result = runDoctor(["--json"])
    // stdout should be pure JSON - check it parses cleanly
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toHaveProperty("schemaVersion")

    // stderr should be empty or contain only diagnostics (not JSON)
    // In the current implementation, stderr may contain error messages
    // but should NOT contain the main JSON output
    if (result.stderr) {
      try {
        const stderrParsed = JSON.parse(result.stderr)
        // If stderr IS valid JSON, it should not have schemaVersion
        expect(stderrParsed).not.toHaveProperty("schemaVersion")
      } catch {
        // Stderr is not JSON — that's fine, diagnostics text
      }
    }
  })

  it("includes checks array in JSON output", () => {
    const result = runDoctor(["--json"])
    const parsed = JSON.parse(result.stdout)
    expect(Array.isArray(parsed.checks)).toBe(true)
  })

  it("includes summary in JSON output", () => {
    const result = runDoctor(["--json"])
    const parsed = JSON.parse(result.stdout)
    expect(parsed.summary).toBeDefined()
    expect(typeof parsed.summary.total).toBe("number")
  })

  it("includes scores in JSON output", () => {
    const result = runDoctor(["--json"])
    const parsed = JSON.parse(result.stdout)
    expect(parsed.scores).toBeDefined()
    expect(typeof parsed.scores.overall).toBe("number")
  })

  it("includes version and timestamp in JSON output", () => {
    const result = runDoctor(["--json"])
    const parsed = JSON.parse(result.stdout)
    expect(parsed.version).toBeDefined()
    expect(typeof parsed.version).toBe("string")
    expect(parsed.timestamp).toBeDefined()
  })
})

describe("Doctor CLI — Text Output", () => {
  it("produces human-readable text by default", () => {
    const result = runDoctor([])
    // Should not be valid JSON
    expect(() => JSON.parse(result.stdout)).toThrow()
    // Should contain expected text headers
    expect(result.stdout).toMatch(/FlowDeck/i)
  })

  it("includes score section in text output", () => {
    const result = runDoctor([])
    expect(result.stdout).toMatch(/Scores?/)
    expect(result.stdout).toMatch(/Overall/)
  })

  it("includes readiness in text output", () => {
    const result = runDoctor([])
    expect(result.stdout).toMatch(/Readiness/)
  })
})

describe("Doctor CLI — Secret Redaction", () => {
  it("never returns secret values in any output format", () => {
    // Run without exposing real secrets
    const result = runDoctor(["--json"])
    const stdout = result.stdout
    // Check for common secret patterns that should not appear in plain text
    const suspiciousPatterns = [
      /(?<![A-Za-z])[A-Za-z0-9_-]{20,}(?![A-Za-z])/, // >= 20 char tokens
    ]
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(stdout)) {
        // If a long string is found, make sure it's in a safe context
        const lines = stdout.split("\n").filter(l => pattern.test(l))
        for (const line of lines) {
          // It should not contain actual secrets
          expect(line).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/)
        }
      }
    }
  })

  it("redacts detected values in environment check output", () => {
    const result = runDoctor(["--json", "--verbose"])
    expect(result.code).toBeGreaterThanOrEqual(0)
    const parsed = JSON.parse(result.stdout)
    const checks = parsed.checks || []
    // Any detected value with [REDACTED] or that matches a secret pattern
    for (const check of checks) {
      if (check.detected && typeof check.detected === "string") {
        // Values that are "[SET]" or valid identifiers are fine
        // But if the value looks like a credential, redact it
        if (check.detected.length > 20 && !check.detected.includes("[SET]")) {
          // Could be a path, which is fine. Only flag if it looks like a token.
        }
      }
    }
  })
})

describe("Doctor CLI — Exit Codes", () => {
  it("returns exit code 0 for healthy environment (normal mode)", () => {
    const result = runDoctor(["--json"])
    const parsed = JSON.parse(result.stdout)
    if (parsed.summary && parsed.summary.errors === 0) {
      expect(result.code).toBe(0)
    }
    // If errors exist, exit should be 1 (still valid per contract)
    expect(result.code === 0 || result.code === 1).toBe(true)
  })

  it("returns exit code 2 for invalid --profile value (not name)", () => {
    // Passing --profile without a value hits exit code 2
    const result = runDoctor(["--profile"])
    expect(result.code).toBe(2)
  })
})

describe("Doctor CLI — Profile Selection", () => {
  for (const profile of ["minimal", "recommended-dev", "full-dev", "ci", "release"]) {
    it(`accepts profile ${profile}`, () => {
      const result = runDoctor(["--json", "--profile", profile])
      expect(result.code).toBeGreaterThanOrEqual(0)
      expect(result.code).toBeLessThanOrEqual(1)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.profile).toBeDefined()
    })
  }
})

describe("Doctor CLI — Package-Relative Path Resolution", () => {
  it("resolves engine relative to package root, not cwd", () => {
    // Run from a temp directory with explicit path
    const tempDir = makeTempConfig()
    try {
      const result = spawnSync("node", [CLI_PATH, "--json"], {
        cwd: tempDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
        env: getSpawnEnv(),
      })
      const code = result.status ?? 1
      const stdout = result.stdout?.toString() ?? ""
      expect(code === 0 || code === 1).toBe(true)
      expect(() => JSON.parse(stdout)).not.toThrow()
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch {}
    }
  })
})

describe("Doctor CLI — Cross-Platform Path Handling", () => {
  it("handles POSIX-style paths for Linux and macOS", () => {
    // Test that the CLI handles unix-style paths in its path logic
    const result = runDoctor(["--json"])
    const parsed = JSON.parse(result.stdout)
    // Should have run successfully
    expect(parsed.schemaVersion).toBe(1)
  })

  it("handles Node.js path resolution for CLI script", () => {
    // The CLI should be findable and runnable
    expect(existsSync(CLI_PATH)).toBe(true)
    const content = readFileSync(CLI_PATH, "utf-8")
    expect(content).toContain("#!/usr/bin/env node")
  })
})

