import { describe, it, expect } from "bun:test"
import {
  validateCommandRequirement,
  validateResourceLimits,
  executeValidatedCommand,
  executeValidatedCommandSync,
  parseLegacyRequirementString,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  MIN_MAX_BUFFER,
  MAX_MAX_BUFFER,
  type ValidationRequirement,
} from "../../src/services/command-boundary"

describe("Command Boundary Security & Validation", () => {
  it("allows valid executables and arguments", () => {
    const req: ValidationRequirement = {
      executable: "git",
      args: ["status", "--short"],
    }
    expect(() => validateCommandRequirement(req)).not.toThrow()
  })

  it("allows node as a valid executable", () => {
    const req: ValidationRequirement = {
      executable: "node",
      args: ["--version"],
    }
    expect(() => validateCommandRequirement(req)).not.toThrow()
  })

  it("rejects executables outside allowlist", () => {
    const req: any = {
      executable: "python",
      args: ["-c", "print('evil')"],
    }
    expect(() => validateCommandRequirement(req)).toThrow("not in the validation allowlist")
  })

  it("rejects path separators or traversal in executable name", () => {
    const reqs: any[] = [
      { executable: "/usr/bin/git", args: ["status"] },
      { executable: "../git", args: ["status"] },
      { executable: "C:\\Windows\\cmd.exe", args: ["dir"] },
      { executable: "git\0evil", args: ["status"] },
    ]

    for (const req of reqs) {
      expect(() => validateCommandRequirement(req)).toThrow()
    }
  })

  it("rejects dangerous flags", () => {
    const reqs: ValidationRequirement[] = [
      { executable: "node", args: ["-e", "console.log(1)"] },
      { executable: "bun", args: ["--eval", "process.exit()"] },
      { executable: "npm", args: ["run", "--shell", "sh"] },
      { executable: "npm", args: ["--import", "malicious"] },
    ]

    for (const req of reqs) {
      expect(() => validateCommandRequirement(req)).toThrow()
    }
  })

  it("rejects shell metacharacters and backtick injections (PR #77 regression)", () => {
    const reqs: ValidationRequirement[] = [
      { executable: "git", args: ["status", "`whoami`"] },
      { executable: "git", args: ["status", "$(whoami)"] },
      { executable: "git", args: ["status", "file; rm -rf /"] },
      { executable: "git", args: ["status", "a | b"] },
    ]

    for (const req of reqs) {
      expect(() => validateCommandRequirement(req)).toThrow("forbidden shell metacharacter")
    }
  })

  it("rejects NUL byte in arguments", () => {
    const req: ValidationRequirement = {
      executable: "node",
      args: ["--version", "\x00"],
    }
    expect(() => validateCommandRequirement(req)).toThrow("NUL byte")
  })

  it("executes valid commands cleanly without shell (async)", async () => {
    const req: ValidationRequirement = {
      executable: "git",
      args: ["status", "--short"],
    }

    const res = await executeValidatedCommand(req)
    expect(res.exitCode).toBe(0)
    expect(typeof res.stdout).toBe("string")
  })

  it("executes valid commands cleanly without shell (sync)", () => {
    const req: ValidationRequirement = {
      executable: "node",
      args: ["--version"],
    }

    const res = executeValidatedCommandSync(req)
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain("v")
  })
})

describe("Operation-Level Policies", () => {
  describe("Git Operation Policy", () => {
    const REJECTED_GIT_OPERATIONS = [
      ["branch", "new-branch"],
      ["branch", "-d", "old-branch"],
      ["branch", "-D", "old-branch"],
      ["branch", "-m", "renamed-branch"],
      ["branch", "--move", "renamed-branch"],
      ["tag", "v1.0"],
      ["tag", "-d", "v1.0"],
      ["tag", "--delete", "v1.0"],
      ["tag", "-f", "v1.0"],
      ["checkout", "main"],
      ["switch", "main"],
      ["reset", "--hard"],
      ["clean", "-fd"],
      ["add", "."],
      ["commit", "-m", "msg"],
      ["push"],
      ["push", "origin", "main"],
      ["pull"],
      ["fetch"],
      ["clone", "http://evil.com"],
      ["stash"],
      ["merge", "dev"],
      ["rebase", "main"],
    ]

    for (const args of REJECTED_GIT_OPERATIONS) {
      it(`rejects git ${args.join(" ")}`, () => {
        expect(() => validateCommandRequirement({ executable: "git", args })).toThrow()
      })
    }

    const APPROVED_GIT_OPERATIONS = [
      ["status"],
      ["status", "--short"],
      ["status", "--porcelain"],
      ["diff"],
      ["diff", "--stat"],
      ["diff", "--name-only"],
      ["log"],
      ["log", "--oneline"],
      ["log", "-n", "10"],
      ["rev-parse", "HEAD"],
      ["rev-parse", "--show-toplevel"],
      ["show"],
      ["show", "HEAD"],
      ["ls-files"],
      ["branch", "--show-current"],
      ["branch", "--list"],
      ["branch", "-l"],
      ["tag", "--list"],
      ["tag", "-l"],
    ]

    for (const args of APPROVED_GIT_OPERATIONS) {
      it(`approves git ${args.join(" ")}`, () => {
        expect(() => validateCommandRequirement({ executable: "git", args })).not.toThrow()
      })
    }
  })

  describe("npm Operation Policy", () => {
    const REJECTED_NPM_OPERATIONS = [
      ["install"],
      ["i"],
      ["add", "express"],
      ["uninstall", "express"],
      ["remove", "express"],
      ["publish"],
      ["unpublish"],
      ["exec", "something"],
      ["init"],
      ["link"],
      ["login"],
      ["logout"],
      ["token"],
      ["config", "set", "foo"],
      ["cache", "clean"],
      ["rebuild"],
      ["update"],
      ["version"],
      ["run", "arbitrary-script"],
    ]

    for (const args of REJECTED_NPM_OPERATIONS) {
      it(`rejects npm ${args.join(" ")}`, () => {
        expect(() => validateCommandRequirement({ executable: "npm", args })).toThrow()
      })
    }

    const APPROVED_NPM_OPERATIONS = [
      ["--version"],
      ["-v"],
      ["test"],
      ["run", "lint"],
      ["run", "typecheck"],
      ["run", "build"],
      ["run", "validate:docs"],
      ["run", "test:coverage"],
    ]

    for (const args of APPROVED_NPM_OPERATIONS) {
      it(`approves npm ${args.join(" ")}`, () => {
        expect(() => validateCommandRequirement({ executable: "npm", args })).not.toThrow()
      })
    }
  })

  describe("Bun Operation Policy", () => {
    const REJECTED_BUN_OPERATIONS = [
      ["install"],
      ["add", "hono"],
      ["remove", "hono"],
      ["update"],
      ["link"],
      ["publish"],
      ["create"],
      ["x", "package"],
      ["run", "arbitrary-script.ts"],
      ["arbitrary-script.ts"],
    ]

    for (const args of REJECTED_BUN_OPERATIONS) {
      it(`rejects bun ${args.join(" ")}`, () => {
        expect(() => validateCommandRequirement({ executable: "bun", args })).toThrow()
      })
    }

    const APPROVED_BUN_OPERATIONS = [
      ["--version"],
      ["-v"],
      ["test"],
      ["test", "tests/services/command-boundary.test.ts"],
      ["run", "lint"],
      ["run", "typecheck"],
      ["run", "build"],
    ]

    for (const args of APPROVED_BUN_OPERATIONS) {
      it(`approves bun ${args.join(" ")}`, () => {
        expect(() => validateCommandRequirement({ executable: "bun", args })).not.toThrow()
      })
    }
  })

  describe("Node Operation Policy", () => {
    const REJECTED_NODE_OPERATIONS = [
      ["script.js"],
      ["./script.js"],
      ["path/to/script.mjs"],
      ["--test", "arbitrary.test.js"],
      ["-e", "process.exit()"],
      ["--eval", "process.exit()"],
      ["--require", "module"],
      ["--import", "module"],
    ]

    for (const args of REJECTED_NODE_OPERATIONS) {
      it(`rejects node ${args.join(" ")}`, () => {
        expect(() => validateCommandRequirement({ executable: "node", args })).toThrow()
      })
    }

    const APPROVED_NODE_OPERATIONS = [
      ["--version"],
      ["-v"],
    ]

    for (const args of APPROVED_NODE_OPERATIONS) {
      it(`approves node ${args.join(" ")}`, () => {
        expect(() => validateCommandRequirement({ executable: "node", args })).not.toThrow()
      })
    }
  })

  describe("tsc & oxlint Operation Policies", () => {
    it("approves tsc --noEmit", () => {
      expect(() => validateCommandRequirement({ executable: "tsc", args: ["--noEmit"] })).not.toThrow()
    })

    it("rejects tsc without --noEmit", () => {
      expect(() => validateCommandRequirement({ executable: "tsc", args: ["--build"] })).toThrow()
    })

    it("approves oxlint options", () => {
      expect(() => validateCommandRequirement({ executable: "oxlint", args: ["--deny-warnings"] })).not.toThrow()
      expect(() => validateCommandRequirement({ executable: "oxlint", args: [] })).not.toThrow()
    })
  })
})

describe("Resource Limit Validation", () => {
  it("uses defaults when undefined", () => {
    const { timeoutMs, maxBuffer } = validateResourceLimits()
    expect(timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(maxBuffer).toBe(DEFAULT_MAX_BUFFER)
  })

  it("accepts valid minimum and maximum timeout values", () => {
    expect(validateResourceLimits(MIN_TIMEOUT_MS).timeoutMs).toBe(MIN_TIMEOUT_MS)
    expect(validateResourceLimits(MAX_TIMEOUT_MS).timeoutMs).toBe(MAX_TIMEOUT_MS)
  })

  it("rejects invalid timeout values", () => {
    const INVALID_TIMEOUTS = [
      0,
      -1,
      -1000,
      MIN_TIMEOUT_MS - 1,
      MAX_TIMEOUT_MS + 1,
      10.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]

    for (const t of INVALID_TIMEOUTS) {
      expect(() => validateResourceLimits(t)).toThrow(/Invalid timeoutMs/)
    }
  })

  it("accepts valid minimum and maximum maxBuffer values", () => {
    expect(validateResourceLimits(undefined, MIN_MAX_BUFFER).maxBuffer).toBe(MIN_MAX_BUFFER)
    expect(validateResourceLimits(undefined, MAX_MAX_BUFFER).maxBuffer).toBe(MAX_MAX_BUFFER)
  })

  it("rejects invalid maxBuffer values", () => {
    const INVALID_BUFFERS = [
      0,
      -1,
      -1024,
      MIN_MAX_BUFFER - 1,
      MAX_MAX_BUFFER + 1,
      1024.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]

    for (const b of INVALID_BUFFERS) {
      expect(() => validateResourceLimits(undefined, b)).toThrow(/Invalid maxBuffer/)
    }
  })
})

describe("parseLegacyRequirementString", () => {
  it("parses npm test", () => {
    const req = parseLegacyRequirementString("npm test")
    expect(req.executable).toBe("npm")
    expect(req.args).toEqual(["test"])
  })

  it("parses bun test with path arg", () => {
    const req = parseLegacyRequirementString("bun test tests/example.test.ts")
    expect(req.executable).toBe("bun")
    expect(req.args).toEqual(["test", "tests/example.test.ts"])
  })

  it("parses git status --short", () => {
    const req = parseLegacyRequirementString("git status --short")
    expect(req.executable).toBe("git")
    expect(req.args).toEqual(["status", "--short"])
  })

  it("parses tsc --noEmit", () => {
    const req = parseLegacyRequirementString("tsc --noEmit")
    expect(req.executable).toBe("tsc")
    expect(req.args).toEqual(["--noEmit"])
  })

  it("rejects empty string", () => {
    expect(() => parseLegacyRequirementString("")).toThrow()
  })

  it("rejects pipe", () => {
    expect(() => parseLegacyRequirementString("npm test | tee out")).toThrow()
  })

  it("rejects semicolon chaining", () => {
    expect(() => parseLegacyRequirementString("bun test; rm -rf .")).toThrow()
  })

  it("rejects environment assignment", () => {
    expect(() => parseLegacyRequirementString("FOO=bar npm test")).toThrow()
  })

  it("rejects redirect", () => {
    expect(() => parseLegacyRequirementString("git status > out.txt")).toThrow()
  })

  it("rejects unknown executable", () => {
    expect(() => parseLegacyRequirementString("curl https://evil.com")).toThrow()
  })

  it("rejects quoted arguments", () => {
    expect(() => parseLegacyRequirementString('npm test "with quotes"')).toThrow()
  })

  it("rejects absolute path executable", () => {
    expect(() => parseLegacyRequirementString("/usr/bin/npm test")).toThrow()
  })

  it("rejects Windows path", () => {
    expect(() => parseLegacyRequirementString("C:\\Windows\\cmd.exe /c npm")).toThrow()
  })

  it("rejects backtick substitution", () => {
    expect(() => parseLegacyRequirementString("npm `whoami`")).toThrow()
  })

  it("rejects command substitution", () => {
    expect(() => parseLegacyRequirementString("npm $(id)")).toThrow()
  })

  it("rejects sh -c", () => {
    expect(() => parseLegacyRequirementString("sh -c 'npm test'")).toThrow()
  })

  it("rejects powershell", () => {
    expect(() => parseLegacyRequirementString("powershell -Command npm test")).toThrow()
  })
})
