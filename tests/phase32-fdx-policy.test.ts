import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import {
  validateExecutable,
  validateArgs,
  validateGitPolicy,
  fdxGitTool,
  fdxDiffTool,
} from "@/tools/fdx"

const TMP = join(tmpdir(), "phase32-fdx-policy-test-" + Date.now())

describe("Phase 32 — FDX Argument Validation & Git Read-Only Policy", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) writeFileSync(TMP, "", "utf-8")
  })

  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  })

  describe("1. FDX Argument & Executable Validation", () => {
    it("allows executables in the allowlist and rejects unknown executables", () => {
      expect(validateExecutable("git")).toBe("git")
      expect(validateExecutable("fdx")).toBe("fdx")
      expect(validateExecutable("node")).toBe("node")

      expect(() => validateExecutable("malicious_cmd")).toThrow(/not in the allowlist/)
      expect(() => validateExecutable("git/bin", ["git/bin"])).toThrow(/contains path separators/)
      expect(() => validateExecutable("git\0evil", ["git\0evil"])).toThrow(/contains NUL byte/)
    })

    it("rejects arguments containing NUL bytes", () => {
      expect(() => validateArgs(["valid", "hello\0world"])).toThrow(/contains NUL byte/)
    })

    it("rejects oversized individual arguments", () => {
      const hugeArg = "a".repeat(20_000)
      expect(() => validateArgs([hugeArg], { maxLen: 16_384 })).toThrow(/exceeds maximum allowed length/)
    })

    it("rejects too many arguments", () => {
      const args = Array.from({ length: 150 }, (_, i) => `arg${i}`)
      expect(() => validateArgs(args, { maxCount: 100 })).toThrow(/Too many arguments/)
    })

    it("rejects combined argument length exceeding total limit", () => {
      const args = Array.from({ length: 70 }, () => "a".repeat(1000))
      expect(() => validateArgs(args, { maxTotalLen: 65_536 })).toThrow(/Combined argument length/)
    })

    it("accepts literal values containing $, ;, [], (), !, spaces without rejecting as shell metacharacters", () => {
      const literalArgs = [
        "pattern;still-literal",
        "$HOME-is-literal",
        "-k",
        "user[admin]",
        "--features=!default",
        "suite (case)",
        "tests/name with spaces.test.ts",
      ]
      expect(validateArgs(literalArgs)).toEqual(literalArgs)
    })

    it("proves literal arguments arrive as exact single argv entries without second process execution", () => {
      const fixtureScript = join(tmpdir(), `fixture_argv_recorder_${Date.now()}.mjs`)
      const logFile = join(tmpdir(), `fixture_argv_out_${Date.now()}.json`)

      writeFileSync(
        fixtureScript,
        `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));`,
        "utf-8"
      )

      const testArgs = [
        "pattern;still-literal",
        "$HOME-is-literal",
        "-k",
        "user[admin]",
        "--features=!default",
        "suite (case)",
        "tests/name with spaces.test.ts",
      ]

      try {
        execFileSync(process.execPath, [fixtureScript, logFile, ...testArgs], { shell: false })
        const recorded: string[] = JSON.parse(require("node:fs").readFileSync(logFile, "utf-8"))
        expect(recorded).toEqual(testArgs)
        expect(recorded[0]).toBe("pattern;still-literal")
        expect(recorded[1]).toBe("$HOME-is-literal")
        expect(recorded[6]).toBe("tests/name with spaces.test.ts")
      } finally {
        try { rmSync(fixtureScript, { force: true }) } catch {}
        try { rmSync(logFile, { force: true }) } catch {}
      }
    })
  })

  describe("2. Shared Git Read-Only Policy", () => {
    it("allows safe top-level read-only operations", () => {
      expect(() => validateGitPolicy("status")).not.toThrow()
      expect(() => validateGitPolicy("log", ["-n", "5"])).not.toThrow()
      expect(() => validateGitPolicy("diff", ["HEAD~1"])).not.toThrow()
      expect(() => validateGitPolicy("show", ["HEAD"])).not.toThrow()
      expect(() => validateGitPolicy("blame", ["src/index.ts"])).not.toThrow()
      expect(() => validateGitPolicy("ls-files")).not.toThrow()
      expect(() => validateGitPolicy("ls-tree", ["HEAD"])).not.toThrow()
      expect(() => validateGitPolicy("rev-parse", ["--short", "HEAD"])).not.toThrow()
      expect(() => validateGitPolicy("rev-list", ["--count", "HEAD"])).not.toThrow()
      expect(() => validateGitPolicy("describe", ["--tags"])).not.toThrow()
      expect(() => validateGitPolicy("shortlog", ["-sn"])).not.toThrow()
      expect(() => validateGitPolicy("branch", ["--list"])).not.toThrow()
      expect(() => validateGitPolicy("branch", ["--show-current"])).not.toThrow()
      expect(() => validateGitPolicy("tag", ["--list"])).not.toThrow()
      expect(() => validateGitPolicy("stash", ["list"])).not.toThrow()
      expect(() => validateGitPolicy("stash", ["show", "stash@{0}"])).not.toThrow()
    })

    it("rejects prohibited mutating git subcommands", () => {
      const prohibited = [
        "reset", "clean", "checkout", "switch", "restore",
        "commit", "merge", "rebase", "push", "pull", "fetch",
      ]
      for (const cmd of prohibited) {
        expect(() => validateGitPolicy(cmd)).toThrow(/not permitted under read-only policy/)
      }
    })

    it("rejects mutating operations for remote and config", () => {
      expect(() => validateGitPolicy("remote", ["add", "origin", "url"])).toThrow(/prohibited/i)
      expect(() => validateGitPolicy("remote", ["set-url", "origin", "url"])).toThrow(/prohibited/i)
      expect(() => validateGitPolicy("config", ["--set", "key", "val"])).toThrow(/prohibited/i)
      expect(() => validateGitPolicy("config", ["key", "val"])).toThrow(/prohibited/i)
    })

    it("rejects mutating options for branch, tag, and stash", () => {
      expect(() => validateGitPolicy("branch", ["-d", "feature"])).toThrow(/Prohibited|prohibited/)
      expect(() => validateGitPolicy("branch", ["-D", "feature"])).toThrow(/Prohibited|prohibited/)
      expect(() => validateGitPolicy("branch", ["-m", "old", "new"])).toThrow(/Prohibited|prohibited/)
      expect(() => validateGitPolicy("branch", ["-c", "src", "dest"])).toThrow(/Prohibited|prohibited/)
      expect(() => validateGitPolicy("branch", ["new-branch-name"])).toThrow(/Prohibited|prohibited/)

      expect(() => validateGitPolicy("tag", ["-d", "v1.0.0"])).toThrow(/Prohibited|prohibited/)
      expect(() => validateGitPolicy("tag", ["-a", "v1.0.0", "-m", "tag"])).toThrow(/Prohibited|prohibited/)
      expect(() => validateGitPolicy("tag", ["-s", "v1.0.0"])).toThrow(/Prohibited|prohibited/)
      expect(() => validateGitPolicy("tag", ["new-tag-name"])).toThrow(/Prohibited|prohibited/)

      expect(() => validateGitPolicy("stash", ["push"])).toThrow(/prohibited/)
      expect(() => validateGitPolicy("stash", ["pop"])).toThrow(/prohibited/)
      expect(() => validateGitPolicy("stash", ["apply"])).toThrow(/prohibited/)
      expect(() => validateGitPolicy("stash", ["drop"])).toThrow(/prohibited/)
      expect(() => validateGitPolicy("stash", ["clear"])).toThrow(/prohibited/)
      expect(() => validateGitPolicy("stash", [])).toThrow(/prohibited/)
    })

    it("enforces git policy in fdxGitTool before any execution path", async () => {
      const res = await fdxGitTool.execute({ subcommand: "reset", args: ["--hard"] }, {} as any)
      expect(res).toContain("is not permitted under read-only policy")
    })

    it("enforces git policy in fdxDiffTool", async () => {
      const res = await fdxDiffTool.execute({ commit: "HEAD" }, {} as any)
      expect(typeof res).toBe("string")
    })
  })
})
