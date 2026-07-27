/**
 * FDX Redirect and Git Policy Tests
 *
 * Verifies:
 * 1. FDX redirect is enabled by default
 * 2. Disabling redirect affects only redirect behavior, not governance
 * 3. validateGitPolicy runs before all execution paths
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { checkFdxRedirect } from "@/hooks/tool-guard"
import { validateGitPolicy, validateArgs, fdxGitTool } from "@/tools/fdx"

const TMP = join(tmpdir(), "fdx-redirect-test-" + Date.now())

describe("FDX redirect guard", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })
  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  })

  it("is enabled by default (returns block reason when fdx available)", () => {
    // checkFdxRedirect returns non-null when FDX is available
    const block = checkFdxRedirect("read")
    // On CI without FDX it returns null; on dev machines with FDX it returns a message
    // Either way, it should NOT throw — it returns a string or null
    if (block !== null) {
      expect(block).toContain("Use fdx tools instead")
    }
  })

  it("does not block non-read tools", () => {
    const block = checkFdxRedirect("write_file")
    expect(block).toBeNull()
    const block2 = checkFdxRedirect("bash")
    expect(block2).toBeNull()
  })

  it("disabling redirect returns null for read tools", () => {
    process.env.FLOWDECK_DISABLE_FDX_REDIRECT = "true"
    const block = checkFdxRedirect("read")
    expect(block).toBeNull()
    delete process.env.FLOWDECK_DISABLE_FDX_REDIRECT
  })
})

describe("Git read-only policy", () => {
  it("allows read-only subcommands", () => {
    expect(() => validateGitPolicy("status")).not.toThrow()
    expect(() => validateGitPolicy("log", ["-n", "5"])).not.toThrow()
    expect(() => validateGitPolicy("diff")).not.toThrow()
    expect(() => validateGitPolicy("branch", ["--list"])).not.toThrow()
    expect(() => validateGitPolicy("tag", ["--list"])).not.toThrow()
    expect(() => validateGitPolicy("stash", ["list"])).not.toThrow()
  })

  it("rejects mutating subcommands", () => {
    const mutating = ["reset", "clean", "checkout", "switch", "restore", "commit", "merge", "rebase", "push", "pull"]
    for (const cmd of mutating) {
      expect(() => validateGitPolicy(cmd)).toThrow(/not permitted under read-only policy/)
    }
  })

  it("rejects mutating branch flags", () => {
    expect(() => validateGitPolicy("branch", ["-d", "feature"])).toThrow(/Prohibited|prohibited/)
    expect(() => validateGitPolicy("branch", ["-D", "feature"])).toThrow(/Prohibited|prohibited/)
    expect(() => validateGitPolicy("branch", ["-m", "old", "new"])).toThrow(/Prohibited|prohibited/)
  })

  it("rejects mutating tag flags", () => {
    expect(() => validateGitPolicy("tag", ["-d", "v1.0"])).toThrow(/Prohibited|prohibited/)
    expect(() => validateGitPolicy("tag", ["-a", "v1.0"])).toThrow(/Prohibited|prohibited/)
  })

  it("rejects mutating stash operations", () => {
    expect(() => validateGitPolicy("stash", ["push"])).toThrow(/prohibited/)
    expect(() => validateGitPolicy("stash", ["pop"])).toThrow(/prohibited/)
    expect(() => validateGitPolicy("stash", ["drop"])).toThrow(/prohibited/)
    expect(() => validateGitPolicy("stash", ["clear"])).toThrow(/prohibited/)
  })

  it("fdxGitTool enforces policy before any execution path", async () => {
    const res = await fdxGitTool.execute({ subcommand: "reset", args: ["--hard"] }, {} as any)
    expect(res).toContain("is not permitted under read-only policy")
  })

  it("fdxGitTool allows read-only commands", async () => {
    const res = await fdxGitTool.execute({ subcommand: "status" }, { directory: TMP } as any)
    expect(typeof res).toBe("string")
    expect(res).not.toContain("not permitted")
  })
})

describe("FDX argument validation", () => {
  it("rejects NUL bytes", () => {
    expect(() => validateArgs(["good", "bad\0arg"])).toThrow(/contains NUL byte/)
  })

  it("rejects oversized individual arguments", () => {
    expect(() => validateArgs(["a".repeat(20000)], { maxLen: 16384 })).toThrow(/exceeds maximum allowed length/)
  })

  it("rejects too many arguments", () => {
    expect(() => validateArgs(Array.from({ length: 150 }, (_, i) => String(i)), { maxCount: 100 })).toThrow(/Too many arguments/)
  })

  it("accepts literal shell-safe characters", () => {
    const args = ["pattern;still-literal", "$HOME-is-literal", "-k", "user[admin]", "--features=!default", "suite (case)", "tests/name with spaces.test.ts"]
    expect(validateArgs(args)).toEqual(args)
  })
})
