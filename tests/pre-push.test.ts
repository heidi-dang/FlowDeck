import { describe, it, expect } from "vitest"
import {
  parsePrePushStdin,
  detectRustChangesFromRefs,
  detectRustChanges,
  getChangedFiles,
  routeFastChecks,
  isEscalationRequired,
  getFullModeSteps,
} from "../scripts/pre-push.mjs"

describe("Pre-Push Gate & Rust Change Detection Unit Tests (tests/pre-push.test.ts)", () => {
  // ── parsePrePushStdin ────────────────────────────────────────────────────────

  describe("parsePrePushStdin", () => {
    it("returns empty array for absent or empty stdin input", () => {
      expect(parsePrePushStdin(undefined)).toEqual([])
      expect(parsePrePushStdin("")).toEqual([])
      expect(parsePrePushStdin("   \n")).toEqual([])
    })

    it("parses valid single pre-push ref line", () => {
      const stdin =
        "refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n"
      const res = parsePrePushStdin(stdin)
      expect(res).toHaveLength(1)
      expect(res[0]).toEqual({
        localRef: "refs/heads/main",
        localSha: "1111111111111111111111111111111111111111",
        remoteRef: "refs/heads/main",
        remoteSha: "2222222222222222222222222222222222222222",
      })
    })

    it("parses multiple pre-push ref lines", () => {
      const stdin = `
refs/heads/feature-a AAA AAA refs/heads/feature-a BBB
refs/heads/feature-b CCC CCC refs/heads/feature-b DDD
`
      const res = parsePrePushStdin(stdin)
      expect(res).toHaveLength(2)
      expect(res[0].localRef).toBe("refs/heads/feature-a")
      expect(res[1].localRef).toBe("refs/heads/feature-b")
    })

    it("fails closed on malformed stdin ref line with fewer than 4 tokens", () => {
      const malformed = "refs/heads/main 111 222\n"
      expect(() => parsePrePushStdin(malformed)).toThrow(/Malformed pre-push stdin ref line/)
    })
  })

  // ── detectRustChangesFromRefs ────────────────────────────────────────────────

  describe("detectRustChangesFromRefs", () => {
    it("returns null when no ref entries are provided", () => {
      expect(detectRustChangesFromRefs([])).toBeNull()
      expect(detectRustChangesFromRefs(null as any)).toBeNull()
    })

    it("detects existing branch without Rust changes", () => {
      // remoteSha is non-zero → existing branch path → calls git diff only
      const mockExec = (cmd: string) => {
        if (cmd.includes("git diff --name-only")) return "scripts/check-coverage.mjs\npackage.json\n"
        // No other commands should be reached on existing-branch path
        throw new Error(`Unexpected git command in test: ${cmd}`)
      }
      const entries = [{ localRef: "ref", localSha: "222", remoteRef: "ref", remoteSha: "111" }]
      const res = detectRustChangesFromRefs(entries, ".", mockExec)
      expect(res).toBe(false)
    })

    it("detects existing branch with Rust change via ref comparison", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git diff --name-only"))
          return "crates/fdx/src/main.rs\nscripts/check-coverage.mjs\n"
        throw new Error(`Unexpected git command in test: ${cmd}`)
      }
      const entries = [{ localRef: "ref", localSha: "222", remoteRef: "ref", remoteSha: "111" }]
      const res = detectRustChangesFromRefs(entries, ".", mockExec)
      expect(res).toBe(true)
    })

    it("handles new branch (all zero remote SHA) without Rust changes", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("rev-parse --abbrev-ref @{upstream}")) return "origin/main"
        if (cmd.includes("merge-base")) return "000"
        if (cmd.includes("git diff --name-only")) return "src/index.ts\n"
        throw new Error(`Unexpected git command in test: ${cmd}`)
      }
      const zeroSha = "0000000000000000000000000000000000000000"
      const entries = [{ localRef: "ref", localSha: "111", remoteRef: "ref", remoteSha: zeroSha }]
      const res = detectRustChangesFromRefs(entries, ".", mockExec)
      expect(res).toBe(false)
    })

    it("handles new branch (all zero remote SHA) with Rust changes", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("rev-parse --abbrev-ref @{upstream}")) return "origin/main"
        if (cmd.includes("merge-base")) return "000"
        if (cmd.includes("git diff --name-only")) return "crates/fdx/Cargo.toml\n"
        throw new Error(`Unexpected git command in test: ${cmd}`)
      }
      const zeroSha = "0000000000000000000000000000000000000000"
      const entries = [{ localRef: "ref", localSha: "111", remoteRef: "ref", remoteSha: zeroSha }]
      const res = detectRustChangesFromRefs(entries, ".", mockExec)
      expect(res).toBe(true)
    })

    it("detects Rust changes across multiple pushed refs when one ref contains Rust changes", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes('"111"')) return "scripts/check-coverage.mjs\n"
        if (cmd.includes('"333"')) return "crates/fdx/src/lib.rs\n"
        throw new Error(`Unexpected git command in test: ${cmd}`)
      }
      const entries = [
        { localRef: "ref1", localSha: "111", remoteRef: "ref1", remoteSha: "100" },
        { localRef: "ref2", localSha: "333", remoteRef: "ref2", remoteSha: "300" },
      ]
      const res = detectRustChangesFromRefs(entries, ".", mockExec)
      expect(res).toBe(true)
    })
  })

  // ── detectRustChanges Fail-Closed Policy ─────────────────────────────────────

  describe("detectRustChanges Fail-Closed Policy", () => {
    it("returns true on git error (fail-closed)", () => {
      const mockExec = () => {
        throw new Error("Git command failed")
      }
      const res = detectRustChanges("", "/nonexistent_path", mockExec)
      expect(res).toBe(true)
    })

    it("returns true on malformed stdin ref input (fail-closed)", () => {
      // "refs/heads/main 111 222" has 3 tokens → parsePrePushStdin throws → catch → true
      const mockExec = () => {
        throw new Error("Should not reach git commands")
      }
      const res = detectRustChanges("refs/heads/main 111 222", ".", mockExec)
      expect(res).toBe(true)
    })

    it("returns false when upstream comparison proves no Rust changes", () => {
      // Mock covers every branch detectRustChanges may take (no stdin → working tree → upstream)
      const mockExec = (cmd: string) => {
        if (cmd.includes("git status --porcelain")) return " M scripts/check-coverage.mjs\n"
        if (cmd.includes("rev-parse --abbrev-ref @{upstream}")) return "origin/fix-branch"
        if (cmd.includes("git merge-base")) return "aabbcc"
        if (cmd.includes("git diff --name-only")) return "scripts/pre-push.mjs\n"
        throw new Error(`Unexpected git command in test: ${cmd}`)
      }
      const res = detectRustChanges("", ".", mockExec)
      expect(res).toBe(false)
    })

    it("returns true when working tree has modified Rust file", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git status --porcelain")) return " M crates/fdx/src/main.rs\n"
        throw new Error(`Unexpected git command in test: ${cmd}`)
      }
      const res = detectRustChanges("", ".", mockExec)
      expect(res).toBe(true)
    })

    it("returns true when working tree has staged Rust file", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git status --porcelain")) return "M  crates/fdx/Cargo.toml\n"
        throw new Error(`Unexpected git command in test: ${cmd}`)
      }
      const res = detectRustChanges("", ".", mockExec)
      expect(res).toBe(true)
    })

    it("returns true (fail-closed) when upstream is unavailable and origin/HEAD is unavailable", () => {
      let callCount = 0
      const mockExec = (cmd: string) => {
        callCount++
        if (cmd.includes("git status --porcelain")) return ""
        // All git comparison commands fail → should fall through to fail-closed true
        throw new Error("git unavailable")
      }
      const res = detectRustChanges("", ".", mockExec)
      expect(res).toBe(true)
      expect(callCount).toBeGreaterThan(0)
    })
  })

  // ── getChangedFiles ──────────────────────────────────────────────────────────

  describe("getChangedFiles", () => {
    it("returns empty array when stdin and git status are both empty", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git status --porcelain")) return ""
        throw new Error(`Unexpected git command: ${cmd}`)
      }
      const res = getChangedFiles("", ".", mockExec)
      expect(res).toEqual([])
    })

    it("extracts changed files from existing-branch stdin refs", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git diff --name-only")) return "src/index.ts\nscripts/pre-push.mjs\n"
        throw new Error(`Unexpected git command: ${cmd}`)
      }
      const stdin = "refs/heads/fix refs/heads/fix abc123 refs/heads/fix 000999\n"
      const res = getChangedFiles(stdin, ".", mockExec)
      expect(res).toContain("src/index.ts")
      expect(res).toContain("scripts/pre-push.mjs")
    })

    it("falls back to git status when stdin is empty", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git status --porcelain")) return " M src/tools/shell.ts\n M docs/README.md\n"
        throw new Error(`Unexpected git command: ${cmd}`)
      }
      const res = getChangedFiles("", ".", mockExec)
      expect(res).toContain("src/tools/shell.ts")
      expect(res).toContain("docs/README.md")
    })

    it("deduplicates files when multiple refs change the same file", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git diff --name-only")) return "src/index.ts\n"
        throw new Error(`Unexpected git command: ${cmd}`)
      }
      const stdin =
        "refs/heads/a refs/heads/a aaa111 refs/heads/a bbb222\n" +
        "refs/heads/b refs/heads/b ccc333 refs/heads/b ddd444\n"
      const res = getChangedFiles(stdin, ".", mockExec)
      const unique = [...new Set(res)]
      expect(unique).toHaveLength(res.length)
    })
  })

  // ── isEscalationRequired ──────────────────────────────────────────────────────

  describe("isEscalationRequired", () => {
    it("returns false for empty or non-array input", () => {
      expect(isEscalationRequired([])).toBe(false)
      expect(isEscalationRequired(null as any)).toBe(false)
    })

    it("returns false for normal source file changes", () => {
      expect(isEscalationRequired(["src/tools/shell.ts", "src/index.ts", "scripts/pre-push.mjs"])).toBe(
        false
      )
    })

    it("escalates when package.json changes", () => {
      expect(isEscalationRequired(["src/index.ts", "package.json"])).toBe(true)
    })

    it("escalates when package-lock.json changes", () => {
      expect(isEscalationRequired(["package-lock.json"])).toBe(true)
    })

    it("escalates when bun.lock changes", () => {
      expect(isEscalationRequired(["bun.lock"])).toBe(true)
    })

    it("escalates when any tsconfig changes", () => {
      expect(isEscalationRequired(["tsconfig.json"])).toBe(true)
      expect(isEscalationRequired(["tsconfig.build.json"])).toBe(true)
      expect(isEscalationRequired(["tsconfig.prepush.json"])).toBe(true)
    })

    it("escalates when vitest config changes", () => {
      expect(isEscalationRequired(["vitest.config.ts"])).toBe(true)
      expect(isEscalationRequired(["vitest.config.js"])).toBe(true)
    })

    it("escalates when GitHub Actions workflow changes", () => {
      expect(isEscalationRequired([".github/workflows/ci.yml"])).toBe(true)
    })

    it("escalates when shared test utilities change", () => {
      expect(isEscalationRequired(["tests/lib/helpers.ts"])).toBe(true)
      expect(isEscalationRequired(["tests/integration/smoke.test.ts"])).toBe(true)
    })
  })

  // ── routeFastChecks ───────────────────────────────────────────────────────────

  describe("routeFastChecks", () => {
    it("returns empty results for null/empty input", () => {
      expect(routeFastChecks(null as any)).toEqual({ testPaths: [], extraCmds: [] })
      expect(routeFastChecks([])).toEqual({ testPaths: [], extraCmds: [] })
    })

    it("maps src/tools/ changes to tests/tools/", () => {
      const { testPaths } = routeFastChecks(["src/tools/shell.ts", "src/tools/bash.ts"])
      expect(testPaths).toContain("tests/tools/")
      expect(testPaths).toHaveLength(1) // deduped
    })

    it("maps src/hooks/ changes to tests/hooks/", () => {
      const { testPaths } = routeFastChecks(["src/hooks/pre-tool.ts"])
      expect(testPaths).toContain("tests/hooks/")
    })

    it("maps src/services/ changes to tests/services/", () => {
      const { testPaths } = routeFastChecks(["src/services/session.ts"])
      expect(testPaths).toContain("tests/services/")
    })

    it("maps src/config/ changes to tests/config/", () => {
      const { testPaths } = routeFastChecks(["src/config/schema.ts"])
      expect(testPaths).toContain("tests/config/")
    })

    it("maps src/index.ts to tests/index.test.ts", () => {
      const { testPaths } = routeFastChecks(["src/index.ts"])
      expect(testPaths).toContain("tests/index.test.ts")
    })

    it("maps scripts/check-coverage.mjs to tests/check-coverage.test.ts", () => {
      const { testPaths } = routeFastChecks(["scripts/check-coverage.mjs"])
      expect(testPaths).toContain("tests/check-coverage.test.ts")
    })

    it("maps scripts/pre-push.mjs to tests/pre-push.test.ts", () => {
      const { testPaths } = routeFastChecks(["scripts/pre-push.mjs"])
      expect(testPaths).toContain("tests/pre-push.test.ts")
    })

    it("produces multiple test paths for changes spanning multiple src/ directories", () => {
      const { testPaths } = routeFastChecks(["src/tools/x.ts", "src/hooks/y.ts", "src/config/z.ts"])
      expect(testPaths).toContain("tests/tools/")
      expect(testPaths).toContain("tests/hooks/")
      expect(testPaths).toContain("tests/config/")
    })

    it("adds npm run validate:skills when src/skills/ files change", () => {
      const { extraCmds } = routeFastChecks(["src/skills/planner/SKILL.md"])
      expect(extraCmds).toContain("npm run validate:skills")
    })

    it("adds npm run validate:docs when docs/ files change", () => {
      const { extraCmds } = routeFastChecks(["docs/api.md"])
      expect(extraCmds).toContain("npm run validate:docs")
    })

    it("adds cargo fmt check and cargo check when crates/fdx/ files change", () => {
      const { extraCmds } = routeFastChecks(["crates/fdx/src/main.rs"])
      expect(extraCmds.some((c) => c.includes("cargo fmt"))).toBe(true)
      expect(extraCmds.some((c) => c.includes("cargo check"))).toBe(true)
    })

    it("produces no test paths or extra cmds for unknown file paths", () => {
      const { testPaths, extraCmds } = routeFastChecks([".gitignore", "README.md", "LICENSE"])
      expect(testPaths).toHaveLength(0)
      expect(extraCmds).toHaveLength(0)
    })
  })

  // ── getFullModeSteps ─────────────────────────────────────────────────────────

  describe("getFullModeSteps & Rust Command Assembly", () => {
    it("returns 9 standard steps when no Rust changes detected", () => {
      const steps = getFullModeSteps(false, false)
      expect(steps).toHaveLength(9)
      expect(steps.some((s) => s.name.startsWith("Rust"))).toBe(false)
      // Coverage must be in full mode
      expect(steps.some((s) => s.name === "Coverage")).toBe(true)
    })

    it("adds all four Rust commands when Rust changes are detected and Cargo is available", () => {
      const steps = getFullModeSteps(true, true)
      expect(steps).toHaveLength(13)
      const rustSteps = steps.filter((s) => s.name.startsWith("Rust"))
      expect(rustSteps).toHaveLength(4)
      expect(rustSteps[0].name).toBe("Rust Formatting")
      expect(rustSteps[0].cmd).toContain("cargo fmt")
      expect(rustSteps[1].name).toBe("Rust Clippy")
      expect(rustSteps[1].cmd).toContain("cargo clippy")
      expect(rustSteps[2].name).toBe("Rust Tests")
      expect(rustSteps[2].cmd).toContain("cargo test")
      expect(rustSteps[3].name).toBe("Rust Build")
      expect(rustSteps[3].cmd).toContain("cargo build")
    })

    it("fails closed (throws Error) when Rust changes are detected but Cargo is not installed", () => {
      expect(() => getFullModeSteps(true, false)).toThrow(/Cargo is not installed on PATH. Push blocked/)
    })
  })
})
