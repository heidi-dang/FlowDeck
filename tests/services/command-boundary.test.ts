import { describe, it, expect } from "bun:test"
import {
  validateCommandRequirement,
  executeValidatedCommand,
  executeValidatedCommandSync,
  parseLegacyRequirementString,
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

  it("rejects unauthorized git subcommands", () => {
    const req: ValidationRequirement = {
      executable: "git",
      args: ["config", "--global", "user.name", "attacker"],
    }
    expect(() => validateCommandRequirement(req)).toThrow("Git subcommand \"config\" is not allowed")
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
