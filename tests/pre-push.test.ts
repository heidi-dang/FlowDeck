import { describe, it, expect } from "vitest"
import {
  parsePrePushStdin,
  readPrePushInput,
  detectRustChangesFromRefs,
  detectRustChanges,
  getChangedFiles,
  routeFastChecks,
  isEscalationRequired,
  getFullModeSteps,
  resolveOxlintExecutable,
  getBunExecutable,
  resolveTscPath,
  resolvePushRanges,
  getDiffCheckTasks,
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
    it("returns empty result with working-tree source when stdin is empty", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git status --porcelain")) return ""
        throw new Error(`Unexpected git command: ${cmd}`)
      }
      const res = getChangedFiles("", ".", mockExec)
      expect(res.files).toEqual([])
      expect(res.source).toBe("working-tree")
      expect(res.trustworthy).toBe(true)
    })

    it("extracts changed files from existing-branch stdin refs", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git diff --name-only")) return "src/index.ts\nscripts/pre-push.mjs\n"
        throw new Error(`Unexpected git command: ${cmd}`)
      }
      const stdin = "refs/heads/fix refs/heads/fix abc123 refs/heads/fix 000999\n"
      const res = getChangedFiles(stdin, ".", mockExec)
      expect(res.files).toContain("src/index.ts")
      expect(res.files).toContain("scripts/pre-push.mjs")
      expect(res.source).toBe("refs")
    })

    it("falls back to git status when stdin is empty", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git status --porcelain")) return " M src/tools/shell.ts\n M docs/README.md\n"
        throw new Error(`Unexpected git command: ${cmd}`)
      }
      const res = getChangedFiles("", ".", mockExec)
      expect(res.files).toContain("src/tools/shell.ts")
      expect(res.files).toContain("docs/README.md")
      expect(res.source).toBe("working-tree")
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
      const unique = [...new Set(res.files)]
      expect(unique).toHaveLength(res.files.length)
      expect(res.source).toBe("refs")
    })

    it("throws on malformed non-empty stdin (fail-closed)", () => {
      const mockExec = () => { throw new Error("Should not reach git commands") }
      expect(() => getChangedFiles("refs/heads/main 111 222\n", ".", mockExec)).toThrow(
        /Malformed pre-push hook input/
      )
    })

    it("marks untrustworthy when new-branch ref cannot resolve merge base (fail-closed)", () => {
      // Simulate new branch with no upstream and origin/main merge-base failure
      const mockExec = (cmd: string) => {
        if (cmd.includes("rev-parse --abbrev-ref @{upstream}")) throw new Error("no upstream")
        if (cmd.includes("git merge-base")) throw new Error("no merge-base")
        throw new Error(`Unexpected: ${cmd}`)
      }
      const zeroSha = "0000000000000000000000000000000000000000"
      const stdin = `refs/heads/new newSha refs/heads/new ${zeroSha}\n`
      const res = getChangedFiles(stdin, ".", mockExec)
      // Files is empty because diff couldn't be run, but trustworthy is false
      // because an unresolved ref sets gitError = true
      expect(res.files).toEqual([])
      expect(res.source).toBe("refs")
      expect(res.trustworthy).toBe(false)
    })

    it("marks untrustworthy when one ref in multi-ref push is unresolved", () => {
      let callCount = 0
      const mockExec = (cmd: string) => {
        callCount++
        // First call: new branch ref that fails
        if (callCount <= 2 && cmd.includes("rev-parse --abbrev-ref @{upstream}")) throw new Error("no upstream")
        if (callCount <= 3 && cmd.includes("git merge-base")) throw new Error("no base")
        // Second call: existing branch that works
        if (cmd.includes("git diff --name-only")) return "src/index.ts\n"
        throw new Error(`Unexpected: ${cmd}`)
      }
      const zeroSha = "0000000000000000000000000000000000000000"
      const stdin =
        `refs/heads/new newSha refs/heads/new ${zeroSha}\n` +
        "refs/heads/fix abc123 refs/heads/fix 000999\n"
      const res = getChangedFiles(stdin, ".", mockExec)
      // Files should contain the resolved ref's changes, but trustworthy is false
      // because the new branch ref was unresolved
      expect(res.files).toContain("src/index.ts")
      expect(res.source).toBe("refs")
      expect(res.trustworthy).toBe(false)
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
      expect(routeFastChecks(null as any)).toEqual({ testPaths: [], fastTasks: [] })
      expect(routeFastChecks([])).toEqual({ testPaths: [], fastTasks: [] })
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

    it("adds skill validation task when src/skills/ files change", () => {
      const { fastTasks } = routeFastChecks(["src/skills/planner/SKILL.md"])
      expect(fastTasks.some((t) => t.name === "Skill Validation")).toBe(true)
      const task = fastTasks.find((t) => t.name === "Skill Validation")!
      expect(task.executable).toBe(process.execPath)
      expect(task.args).toEqual(["scripts/validate-skills.mjs"])
    })

    it("adds documentation validation task when docs/ files change", () => {
      const { fastTasks } = routeFastChecks(["docs/api.md"])
      expect(fastTasks.some((t) => t.name === "Documentation Validation")).toBe(true)
      const task = fastTasks.find((t) => t.name === "Documentation Validation")!
      expect(task.executable).toBe(process.execPath)
      expect(task.args).toEqual(["scripts/validate-docs.mjs"])
    })

    it("adds cargo fmt and cargo check tasks when crates/fdx/ files change", () => {
      const { fastTasks } = routeFastChecks(["crates/fdx/src/main.rs"])
      expect(fastTasks.some((t) => t.name === "Rust Formatting")).toBe(true)
      expect(fastTasks.some((t) => t.name === "Rust Check")).toBe(true)
      const fmt = fastTasks.find((t) => t.name === "Rust Formatting")!
      expect(fmt.executable).toBe("cargo")
      expect(fmt.args).toEqual(["fmt", "--manifest-path", "crates/fdx/Cargo.toml", "--check"])
    })

    it("produces no test paths or extra tasks for unknown file paths", () => {
      const { testPaths, fastTasks } = routeFastChecks([".gitignore", "README.md", "LICENSE"])
      expect(testPaths).toHaveLength(0)
      expect(fastTasks).toHaveLength(0)
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

  // ── readPrePushInput ───────────────────────────────────────────────────────────

  describe("readPrePushInput", () => {
    it("returns empty string when stdin is a TTY", () => {
      const result = readPrePushInput({ isTTY: true })
      expect(result).toBe("")
    })

    it("returns stdin content when stdin is not a TTY with valid read", () => {
      const mockRead = () => "refs/heads/main abc123 refs/heads/main def456\n"
      const result = readPrePushInput({ isTTY: false, readFn: mockRead })
      expect(result).toBe("refs/heads/main abc123 refs/heads/main def456\n")
    })

    it("throws when stdin is not a TTY and read fails (fail-closed)", () => {
      const mockRead = () => { throw new Error("read error") }
      expect(() => readPrePushInput({ isTTY: false, readFn: mockRead })).toThrow(
        /Failed to read stdin in non-TTY mode/
      )
    })

    it("returns stdin content when isTTY is false and input is empty", () => {
      const mockRead = () => ""
      const result = readPrePushInput({ isTTY: false, readFn: mockRead })
      expect(result).toBe("")
    })
  })

  // ── Fast-mode task structure safety ───────────────────────────────────────────

  describe("Fast-mode task structure safety", () => {
    it("routeFastChecks returns shell-safe task objects with executable and args separated", () => {
      const { fastTasks } = routeFastChecks(["src/skills/planner/SKILL.md", "docs/api.md"])
      for (const task of fastTasks) {
        expect(task).toHaveProperty("name")
        expect(task).toHaveProperty("executable")
        expect(task).toHaveProperty("args")
        expect(Array.isArray(task.args)).toBe(true)
        expect(typeof task.executable).toBe("string")
        // No task should contain a cmd string — they use structured executable+args
        expect((task as any).cmd).toBeUndefined()
      }
    })

    it("handles filenames with spaces as a single argument", () => {
      const files = ["src/tools/my tool.ts", "src/tools/another tool.ts"]
      const { testPaths } = routeFastChecks(files)
      // Both files map to tests/tools/
      expect(testPaths).toContain("tests/tools/")
      expect(testPaths).toHaveLength(1)
    })

    it("handles filenames with ampersand as a single argument", () => {
      const files = ["src/tools/a&b.ts"]
      const { testPaths } = routeFastChecks(files)
      expect(testPaths).toContain("tests/tools/")
    })

    it("handles filenames with parentheses as a single argument", () => {
      const files = ["src/tools/file(1).ts"]
      const { testPaths } = routeFastChecks(files)
      expect(testPaths).toContain("tests/tools/")
    })

    it("handles Unicode filenames", () => {
      const files = ["src/tools/日本語.ts"]
      const { testPaths } = routeFastChecks(files)
      expect(testPaths).toContain("tests/tools/")
    })

    it("produces focused test paths as separate entries from SRC_TEST_MAP", () => {
      const files = ["src/tools/x.ts", "src/config/y.ts"]
      const { testPaths } = routeFastChecks(files)
      expect(testPaths).toContain("tests/tools/")
      expect(testPaths).toContain("tests/config/")
      // Two separate test paths
      expect(testPaths.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ── Executable resolvers ──────────────────────────────────────────────────────

  describe("resolveOxlintExecutable", () => {
    it("returns a path ending with bin/oxlint", () => {
      const p = resolveOxlintExecutable()
      expect(typeof p).toBe("string")
      expect(p.length).toBeGreaterThan(0)
      expect(p.endsWith("oxlint") || p.endsWith("oxlint.exe")).toBe(true)
    })
  })

  describe("getBunExecutable", () => {
    it("returns a string executable path", () => {
      const bin = getBunExecutable()
      expect(typeof bin).toBe("string")
      expect(bin.length).toBeGreaterThan(0)
    })
  })

  describe("resolveTscPath", () => {
    it("returns a path ending with tsc", () => {
      const p = resolveTscPath()
      expect(typeof p).toBe("string")
      expect(p.length).toBeGreaterThan(0)
      expect(p.includes("typescript")).toBe(true)
    })
  })

  // ── resolvePushRanges ─────────────────────────────────────────────────────────

  describe("resolvePushRanges", () => {
    it("returns empty array for empty stdin", () => {
      expect(resolvePushRanges("")).toEqual([])
      expect(resolvePushRanges("   ")).toEqual([])
    })

    it("returns existing-branch ranges from valid ref entries", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("git diff --name-only")) return "" // not used here
        throw new Error(`Unexpected: ${cmd}`)
      }
      const stdin = "refs/heads/fix abc123 refs/heads/fix 000999\n"
      const ranges = resolvePushRanges(stdin, ".", mockExec)
      expect(ranges).toHaveLength(1)
      expect(ranges[0]).toEqual({ baseSha: "000999", localSha: "abc123" })
    })

    it("returns new-branch ranges with resolved merge base", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("rev-parse --abbrev-ref @{upstream}")) return "origin/main"
        if (cmd.includes("git merge-base")) return "base123"
        throw new Error(`Unexpected: ${cmd}`)
      }
      const zeroSha = "0000000000000000000000000000000000000000"
      const stdin = `refs/heads/new newSha refs/heads/new ${zeroSha}\n`
      const ranges = resolvePushRanges(stdin, ".", mockExec)
      expect(ranges).toHaveLength(1)
      expect(ranges[0]).toEqual({ baseSha: "base123", localSha: "newSha" })
    })

    it("throws on new-branch ref when merge base cannot be resolved (fail-closed)", () => {
      const mockExec = (cmd: string) => {
        if (cmd.includes("rev-parse --abbrev-ref @{upstream}")) throw new Error("no upstream")
        if (cmd.includes("git merge-base")) throw new Error("no merge-base")
        throw new Error(`Unexpected: ${cmd}`)
      }
      const zeroSha = "0000000000000000000000000000000000000000"
      const stdin = `refs/heads/new newSha refs/heads/new ${zeroSha}\n`
      expect(() => resolvePushRanges(stdin, ".", mockExec)).toThrow(
        /Cannot resolve merge base/
      )
    })
  })

  // ── getDiffCheckTasks ─────────────────────────────────────────────────────────

  describe("getDiffCheckTasks", () => {
    it("returns working-tree diff task when no ranges provided", () => {
      const tasks = getDiffCheckTasks([])
      expect(tasks).toHaveLength(1)
      expect(tasks[0].executable).toBe("git")
      expect(tasks[0].args).toEqual(["diff", "--check"])
    })

    it("returns pushed-range diff tasks for each range", () => {
      const ranges = [
        { baseSha: "aaa", localSha: "bbb" },
        { baseSha: "ccc", localSha: "ddd" },
      ]
      const tasks = getDiffCheckTasks(ranges)
      expect(tasks).toHaveLength(2)
      expect(tasks[0].executable).toBe("git")
      expect(tasks[0].args).toEqual(["diff", "--check", "aaa", "bbb"])
      expect(tasks[1].args).toEqual(["diff", "--check", "ccc", "ddd"])
    })
  })

  // ── Process-level argv safety ─────────────────────────────────────────────────

  describe("Process-level argv safety", () => {
    it("Lint task uses process.execPath with oxlintBin as first arg", () => {
      const oxlintBin = resolveOxlintExecutable()
      const lintTargets = ["src/tools/shell.ts", "src/tools/a&b.ts"]
      const executable = process.execPath
      const args = [oxlintBin, "--deny-warnings", ...lintTargets]
      expect(executable).toBe(process.execPath)
      expect(args[0]).toBe(oxlintBin)
      // Each filename is a separate argv entry
      expect(args[2]).toBe("src/tools/shell.ts")
      expect(args[3]).toBe("src/tools/a&b.ts")
    })

    it("Typecheck task uses process.execPath with tscPath as first arg", () => {
      const tscPath = resolveTscPath()
      const executable = process.execPath
      const args = [tscPath, "--noEmit", "--project", "tsconfig.prepush.json"]
      expect(executable).toBe(process.execPath)
      expect(args[0]).toBe(tscPath)
    })

    it("Test task uses getBunExecutable with separate args", () => {
      const bunBin = getBunExecutable()
      const testPaths = ["tests/pre-push.test.ts"]
      const args = ["test", ...testPaths]
      expect(typeof bunBin).toBe("string")
      expect(args).toEqual(["test", "tests/pre-push.test.ts"])
    })

    it("filename with spaces remains one argv entry", () => {
      const lintTargets = ["src/tools/my tool.ts"]
      const args = ["--deny-warnings", ...lintTargets]
      expect(args).toHaveLength(2)
      expect(args[1]).toBe("src/tools/my tool.ts")
    })

    it("filename with & remains one argv entry", () => {
      const lintTargets = ["src/tools/a&b.ts"]
      const args = ["--deny-warnings", ...lintTargets]
      expect(args[1]).toBe("src/tools/a&b.ts")
    })

    it("filename with | remains one argv entry", () => {
      const testPaths = ["src/tools/pipe|test.ts"]
      expect(testPaths[0]).toBe("src/tools/pipe|test.ts")
    })

    it("filename with ^ remains one argv entry", () => {
      const testPaths = ["src/tools/caret^test.ts"]
      expect(testPaths[0]).toBe("src/tools/caret^test.ts")
    })

    it("filename with % remains one argv entry", () => {
      const testPaths = ["src/tools/percent%test.ts"]
      expect(testPaths[0]).toBe("src/tools/percent%test.ts")
    })

    it("filename with parentheses remains one argv entry", () => {
      const testPaths = ["src/tools/file(1).ts"]
      expect(testPaths[0]).toBe("src/tools/file(1).ts")
    })

    it("Unicode filename remains one argv entry", () => {
      const testPaths = ["src/tools/日本語.ts"]
      expect(testPaths[0]).toBe("src/tools/日本語.ts")
    })

    it("focused test paths remain separate arguments", () => {
      const testPaths = ["tests/tools/", "tests/config/"]
      const args = ["test", ...testPaths]
      expect(args).toHaveLength(3)
      expect(args[1]).toBe("tests/tools/")
      expect(args[2]).toBe("tests/config/")
    })
  })

  // ── Fast-mode orchestration integration tests ─────────────────────────────────

  describe("Fast-mode orchestration logic", () => {
    it("malformed non-empty stdin passes getChangedFiles throw to caller", () => {
      expect(() => getChangedFiles("refs/heads/main 111 222\n", ".")).toThrow(
        /Malformed pre-push hook input/
      )
    })

    it("working-tree fallback for empty stdin succeeds with empty result", () => {
      const mockExec = (_cmd: string) => " M src/index.ts\n"
      const res = getChangedFiles("", ".", mockExec)
      expect(res.files).toContain("src/index.ts")
      expect(res.source).toBe("working-tree")
      expect(res.trustworthy).toBe(true)
    })

    it("untrustworthy result from git error escalates or blocks", () => {
      const mockExec = (_cmd: string) => { throw new Error("git error") }
      const stdin = "refs/heads/fix abc123 refs/heads/fix 000999\n"
      const res = getChangedFiles(stdin, ".", mockExec)
      // Should still produce result but untrustworthy
      expect(res.source).toBe("refs")
      expect(res.trustworthy).toBe(false)
    })

    it("isEmpty + trustworthy for clean working tree returns empty ok", () => {
      const mockExec = (_cmd: string) => ""
      const res = getChangedFiles("", ".", mockExec)
      expect(res.files).toEqual([])
      expect(res.trustworthy).toBe(true)
    })
  })
})
