/**
 * FDX Git Policy Tests
 *
 * Verifies that `validateGitPolicy()` in TypeScript and the compiled Rust native `fdx git`
 * binary correctly permit read-only git operations and reject all mutating commands and flags.
 */

import { describe, it, expect } from "bun:test"
import { execFileSync } from "child_process"
import { join } from "path"
import { existsSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { validateGitPolicy, resolveFdxBinaryPath } from "../src/tools/fdx"

describe("validateGitPolicy production implementation", () => {
  it("allows read-only subcommands and listing flags", () => {
    expect(() => validateGitPolicy("status")).not.toThrow()
    expect(() => validateGitPolicy("log", ["-n", "5"])).not.toThrow()
    expect(() => validateGitPolicy("diff", ["HEAD~1"])).not.toThrow()
    expect(() => validateGitPolicy("show", ["HEAD"])).not.toThrow()
    expect(() => validateGitPolicy("branch", ["--list"])).not.toThrow()
    expect(() => validateGitPolicy("branch", ["-a"])).not.toThrow()
    expect(() => validateGitPolicy("tag", ["-l"])).not.toThrow()
    expect(() => validateGitPolicy("stash", ["list"])).not.toThrow()
    expect(() => validateGitPolicy("stash", ["show"])).not.toThrow()
    expect(() => validateGitPolicy("rev-parse", ["HEAD"])).not.toThrow()
  })

  it("rejects mutating subcommands", () => {
    for (const sub of ["commit", "push", "pull", "merge", "rebase", "reset", "checkout", "switch", "restore", "clean"]) {
      expect(() => validateGitPolicy(sub)).toThrow(/not permitted under read-only policy/)
    }
  })

  it("rejects compact and combined branch mutation flags", () => {
    for (const flag of ["-Dname", "-dmain", "-mfeat", "-Mmain", "-cbranch", "-Cbranch", "--delete", "--move"]) {
      expect(() => validateGitPolicy("branch", [flag])).toThrow()
    }
  })

  it("rejects compact and combined tag mutation flags", () => {
    for (const flag of ["-fname", "-dv1.0", "-av1.0", "-sv1.0", "--delete", "--annotate", "--force"]) {
      expect(() => validateGitPolicy("tag", [flag])).toThrow()
    }
  })

  it("rejects prohibited diff flags", () => {
    for (const flag of ["--output=file", "--ext-diff", "--textconv"]) {
      expect(() => validateGitPolicy("diff", [flag])).toThrow()
    }
  })

  it("rejects prohibited stash operations", () => {
    for (const op of ["push", "pop", "drop", "apply", "clear"]) {
      expect(() => validateGitPolicy("stash", [op])).toThrow(/Stash operation/)
    }
    expect(() => validateGitPolicy("stash", [])).toThrow(/Stash operation/)
  })

  it("rejects unsafe config overrides and exec-path", () => {
    expect(() => validateGitPolicy("log", ["-c core.pager=less"])).toThrow()
    expect(() => validateGitPolicy("log", ["-c sequence.editor=vim"])).toThrow()
    expect(() => validateGitPolicy("log", ["--exec-path=/tmp"])).toThrow()
  })
})

describe("Native Rust FDX Git Policy Execution", () => {
  const candidateBins = [
    resolveFdxBinaryPath(),
    join(__dirname, "../target/debug/fdx"),
    join(__dirname, "../crates/fdx/target/debug/fdx"),
  ].filter(Boolean) as string[]
  const bin = candidateBins.find(b => existsSync(b)) || join(__dirname, "../target/debug/fdx")

  it("executes permitted read-only git commands natively", () => {
    expect(existsSync(bin)).toBe(true)
    if (!existsSync(bin)) return

    const repoDir = mkdtempSync(join(tmpdir(), "fdx-git-policy-"))
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "ignore" })
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })

      const out = execFileSync(bin, ["git", "status"], {
        cwd: repoDir,
        env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })
      expect(out.length).toBeGreaterThan(0)
    } finally {
      try {
        rmSync(repoDir, { recursive: true, force: true })
      } catch {}
    }
  })

  it("rejects compact mutation flags natively", () => {
    expect(existsSync(bin)).toBe(true)
    if (!existsSync(bin)) return

    const repoDir = mkdtempSync(join(tmpdir(), "fdx-git-policy-"))
    try {
      execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })

      const prohibitedCmds = [
        ["git", "branch", "-Dmain"],
        ["git", "tag", "-fname"],
        ["git", "diff", "--output=file"],
        ["git", "stash", "pop"],
      ]

      for (const cmd of prohibitedCmds) {
        let rejected = false
        try {
          execFileSync(bin, cmd, {
            cwd: repoDir,
            env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          })
        } catch (err: any) {
          rejected = true
          const msg = err.stderr || err.stdout || err.message
          expect(msg).toContain("[FDX Git Policy]")
        }
        expect(rejected).toBe(true)
      }
    } finally {
      try {
        rmSync(repoDir, { recursive: true, force: true })
      } catch {}
    }
  })
})
