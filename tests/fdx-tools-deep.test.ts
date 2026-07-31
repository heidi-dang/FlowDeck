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

  it("nativeSearchFallback matches exact parity for edge cases and generated corpus", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "fdx-search-parity-"))
    try {
      writeFileSync(join(tempDir, "meta.txt"), "Line with [regex].*+?^${}()|\\\\ special chars\nAnother line")
      writeFileSync(join(tempDir, "unicode.txt"), "Greeting: 你好世界 🚀\nMiXeD cAsE STriNG")
      writeFileSync(join(tempDir, "multi.txt"), "First line\nSecond line")
      const largeContent = Array.from({ length: 500 }, (_, i) => `Row ${i}: value-${i}`).join("\n")
      writeFileSync(join(tempDir, "large.txt"), largeContent)
      writeFileSync(join(tempDir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]))

      const baselineSearch = (query: string, searchPath: string): string => {
        const root = join(searchPath)
        const lowerQuery = query.toLowerCase()
        const results: string[] = []
        const walk = (dir: string) => {
          for (const item of require("fs").readdirSync(dir)) {
            const full = join(dir, item)
            const st = require("fs").statSync(full)
            if (st.isDirectory()) walk(full)
            else if (st.isFile()) {
              try {
                const text = require("fs").readFileSync(full, "utf-8")
                const lines = text.split("\n")
                lines.forEach((line: string, idx: number) => {
                  if (line.toLowerCase().includes(lowerQuery)) {
                    results.push(`${full}:${idx + 1}:${line.trim()}`)
                  }
                })
              } catch {}
            }
          }
        }
        walk(root)
        if (results.length === 0) return `[FDX Native Fallback] No matches found for "${query}"`
        return `[FDX Native Fallback: ${results.length} matches]\n${results.join("\n")}`
      }

      const testQueries = [
        "[regex].*+?^${}()|\\\\",
        "MiXeD cAsE",
        "你好世界 🚀",
        "value-250",
        "Row 98",
        "nonexistent_query_xyz",
      ]

      for (const q of testQueries) {
        const optimized = nativeSearchFallback(q, tempDir)
        const expected = baselineSearch(q, tempDir)
        expect(optimized).toBe(expected)
      }
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
