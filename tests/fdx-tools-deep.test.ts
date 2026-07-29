import { describe, it, expect } from "bun:test"
import {
  validateExecutable,
  validateGitPolicy,
  checkFdxAvailability,
  shouldDisableFallback,
  nativeReadFallback,
  nativeSearchFallback,
  nativeGitFallback,
  nativeLsFallback,
  nativeContextFallback,
  nativeDecisionsFallback,
  nativeOutlineFallback
} from "../src/tools/fdx-shared"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("FDX Tools & Shared Infrastructure Deep Unit Tests", () => {
  it("validateExecutable validates executable names against allowlist", () => {
    expect(validateExecutable("git")).toBe("git")
    expect(validateExecutable("node")).toBe("node")
    expect(() => validateExecutable("malicious_binary")).toThrow()
    expect(() => validateExecutable("node\0bad")).toThrow("NUL byte")
  })

  it("validateGitPolicy enforces read-only git commands", () => {
    expect(() => validateGitPolicy("status")).not.toThrow()
    expect(() => validateGitPolicy("log")).not.toThrow()
    expect(() => validateGitPolicy("commit")).toThrow("read-only")
    expect(() => validateGitPolicy("push")).toThrow("read-only")
  })

  it("checkFdxAvailability and shouldDisableFallback check system state", () => {
    const status = checkFdxAvailability()
    expect(typeof status).toBe("boolean")
    expect(typeof shouldDisableFallback()).toBe("boolean")
  })

  it("nativeReadFallback reads files safely", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fdx-read-"))
    try {
      const filePath = join(tempDir, "sample.txt")
      writeFileSync(filePath, "line 1\nline 2\nline 3\nline 4\nline 5\n")

      const res = nativeReadFallback(filePath)
      expect(res).toContain("line 1")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("nativeLsFallback lists directory contents", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fdx-ls-"))
    try {
      writeFileSync(join(tempDir, "file1.txt"), "hello")
      mkdirSync(join(tempDir, "subdir"))

      const res = nativeLsFallback(tempDir)
      expect(res).toContain("file1.txt")
      expect(res).toContain("subdir")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("nativeSearchFallback searches files in directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fdx-search-"))
    try {
      writeFileSync(join(tempDir, "test.txt"), "const secretKey = '12345'")

      const res = nativeSearchFallback("secretKey", tempDir)
      expect(res).toContain("test.txt")
      expect(res).toContain("secretKey")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("nativeGitFallback executes read-only git command", () => {
    const res = nativeGitFallback(["status", "--short"])
    expect(typeof res).toBe("string")
  })

  it("nativeContextFallback & nativeDecisionsFallback append topic notes", async () => {
    const ctxRes = await nativeContextFallback("append", "auth", "dev4", "execute", "Note about auth JWT")
    expect(ctxRes).toBeDefined()

    const decRes = await nativeDecisionsFallback("record", "auth", "Use RS256", "Security", "dev4")
    expect(decRes).toBeDefined()
  })

  it("nativeOutlineFallback extracts file structure", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fdx-out-"))
    try {
      const codeFile = join(tempDir, "index.ts")
      writeFileSync(codeFile, "export function hello() {}\nexport class App {}")

      const out = nativeOutlineFallback([codeFile])
      expect(out).toContain("hello")
      expect(out).toContain("App")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
