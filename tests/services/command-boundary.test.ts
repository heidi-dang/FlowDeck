import { describe, it, expect } from "bun:test"
import {
  validateCommandRequirement,
  executeValidatedCommand,
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
      { executable: "node" as any, args: ["-e", "console.log(1)"] },
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

  it("executes valid commands cleanly without shell", async () => {
    const req: ValidationRequirement = {
      executable: "git",
      args: ["status", "--short"],
    }

    const res = await executeValidatedCommand(req)
    expect(res.exitCode).toBe(0)
    expect(typeof res.stdout).toBe("string")
  })
})
