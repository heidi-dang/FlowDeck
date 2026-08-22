import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  nativeReadFallback,
  nativeSearchFallback,
  nativeLsFallback,
  nativeOutlineFallback,
  nativeImpactFallback,
  validateGitPolicy,
} from "../src/tools/fdx-shared"

describe("P0 Security: TypeScript FDX fallback repository jail containment", () => {
  let repoDir: string
  let outsideDir: string
  let outsideSecretFile: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "fdx-fallback-repo-"))
    outsideDir = mkdtempSync(join(tmpdir(), "fdx-fallback-outside-"))

    outsideSecretFile = join(outsideDir, "secret.txt")
    writeFileSync(outsideSecretFile, "FALLBACK_OUTSIDE_SECRET_DATA", "utf-8")

    const srcDir = join(repoDir, "src")
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, "index.ts"), "export function app() { return 'active'; }", "utf-8")
  })

  afterEach(() => {
    try { rmSync(repoDir, { recursive: true, force: true }) } catch {}
    try { rmSync(outsideDir, { recursive: true, force: true }) } catch {}
  })

  describe("nativeReadFallback", () => {
    it("reads valid file in repo", () => {
      const res = nativeReadFallback("src/index.ts", undefined, undefined, repoDir)
      expect(res).toContain("export function app")
    })

    it("rejects path traversal ../../", () => {
      const res = nativeReadFallback("../../outside.txt", undefined, undefined, repoDir)
      expect(res).toContain("[FDX Fallback] Read error:")
      expect(res).toMatch(/escapes repository jail|does not exist/)
    })

    it("rejects absolute path to outside secret", () => {
      const res = nativeReadFallback(outsideSecretFile, undefined, undefined, repoDir)
      expect(res).toContain("[FDX Fallback] Read error:")
      expect(res).toContain("escapes repository jail")
    })

    it("rejects symlink escape", () => {
      const symlinkPath = join(repoDir, "src", "symlink.ts")
      try {
        symlinkSync(outsideSecretFile, symlinkPath)
      } catch {
        return
      }
      const res = nativeReadFallback("src/symlink.ts", undefined, undefined, repoDir)
      expect(res).toContain("[FDX Fallback] Read error:")
      expect(res).toContain("escapes repository jail")
    })
  })

  describe("nativeSearchFallback", () => {
    it("searches valid repo directory", () => {
      const res = nativeSearchFallback("app", ".", repoDir)
      expect(res).toContain("export function app")
    })

    it("rejects search path escaping repo", () => {
      const res = nativeSearchFallback("app", "../../", repoDir)
      expect(res).toContain("[FDX Fallback] Search error:")
      expect(res).toContain("escapes repository jail")
    })
  })

  describe("nativeLsFallback", () => {
    it("lists files in repo directory", () => {
      const res = nativeLsFallback("src", repoDir)
      expect(res).toContain("index.ts")
    })

    it("rejects ls escaping repo", () => {
      const res = nativeLsFallback("../../", repoDir)
      expect(res).toContain("[FDX Fallback] Ls error:")
      expect(res).toContain("escapes repository jail")
    })
  })

  describe("nativeOutlineFallback", () => {
    it("generates outline for valid repo path", () => {
      const res = nativeOutlineFallback(["src/index.ts"], repoDir)
      expect(res).toContain("app")
    })

    it("rejects outline paths escaping repo", () => {
      const res = nativeOutlineFallback(["../../outside"], repoDir)
      expect(res).toContain("[FDX Fallback] Path not found:")
    })
  })

  describe("nativeImpactFallback", () => {
    it("rejects files escaping repo", async () => {
      const res = await nativeImpactFallback(["../../secret.txt"], ".", { cwd: repoDir })
      expect(res).toContain("Path escapes repository jail")
    })
  })

  describe("Git Policy Hardening", () => {
    it("rejects -c config overrides in one-token and two-token forms", () => {
      expect(() => validateGitPolicy("status", ["-c", "core.pager=cat"])).toThrow(/Prohibited config override/)
      expect(() => validateGitPolicy("log", ["-c=core.pager=cat"])).toThrow(/Prohibited config override/)
      expect(() => validateGitPolicy("log", ["-c", "diff.external=rm"])).toThrow(/Prohibited config override/)
      expect(() => validateGitPolicy("diff", ["--config-env", "VAR=VAL"])).toThrow(/Prohibited config override/)
      expect(() => validateGitPolicy("diff", ["--config", "core.pager=cat"])).toThrow(/Prohibited config override/)
    })

    it("rejects exec-path and dangerous flags", () => {
      expect(() => validateGitPolicy("status", ["--exec-path=/tmp"])).toThrow(/Blocked exec-path/)
      expect(() => validateGitPolicy("diff", ["--ext-diff"])).toThrow(/Mutating\/prohibited/)
      expect(() => validateGitPolicy("diff", ["--textconv"])).toThrow(/Mutating\/prohibited/)
      expect(() => validateGitPolicy("log", ["--paginate"])).toThrow(/Mutating\/prohibited/)
      expect(() => validateGitPolicy("log", ["--no-pager"])).toThrow(/Mutating\/prohibited/)
    })
  })
})
