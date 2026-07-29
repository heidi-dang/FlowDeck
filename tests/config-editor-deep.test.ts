import { describe, it, expect } from "bun:test"
import {
  safeParseJson,
  safeReadConfig,
  createBackup,
  getMaxBackups,
  safeUpdateConfig,
  safeUpdateConfigJsonc,
  isJsoncContent
} from "../src/services/config-editor"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Config Editor Deep Unit Tests", () => {
  it("isJsoncContent detects comments", () => {
    expect(isJsoncContent('{\n  // comment\n  "key": "value"\n}')).toBe(true)
    expect(isJsoncContent('{"key": "value"}')).toBe(false)
  })

  it("safeParseJson handles JSON and JSONC with trailing commas", () => {
    const validJsonc = `{\n  // comment\n  "key": "value",\n}`
    const parsed = safeParseJson(validJsonc)
    expect(parsed.ok).toBe(true)
    expect(parsed.isJsonc).toBe(true)
    expect(parsed.data).toEqual({ key: "value" })

    const malformed = `{"key": }`
    const malformedParsed = safeParseJson(malformed)
    expect(malformedParsed.ok).toBe(false)
    expect(malformedParsed.error).toContain("Parse error")
  })

  it("safeReadConfig reads config file safely", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cfg-read-"))
    try {
      const filePath = join(tempDir, "config.json")
      writeFileSync(filePath, JSON.stringify({ version: "1.0.0" }))

      const res = safeReadConfig(filePath)
      expect(res.ok).toBe(true)
      expect(res.data).toEqual({ version: "1.0.0" })

      const missing = safeReadConfig(join(tempDir, "missing.json"))
      expect(missing.ok).toBe(false)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("createBackup creates backups and enforces backup retention", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cfg-bak-"))
    try {
      const filePath = join(tempDir, "config.json")
      writeFileSync(filePath, JSON.stringify({ version: "1.0.0" }))

      const bak1 = createBackup(filePath)
      expect(bak1).toBeDefined()
      expect(existsSync(bak1!)).toBe(true)
      expect(getMaxBackups()).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("safeUpdateConfigJsonc updates JSONC file while preserving comments", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cfg-upd-"))
    try {
      const filePath = join(tempDir, "config.jsonc")
      const initialContent = `{\n  // User setting\n  "theme": "dark"\n}`
      writeFileSync(filePath, initialContent)

      const result = safeUpdateConfigJsonc(filePath, [
        { path: ["theme"], value: "light" },
        { path: ["fontSize"], value: 14 }
      ])
      expect(result.ok).toBe(true)

      const updated = safeReadConfig(filePath)
      expect(updated.data).toEqual({ theme: "light", fontSize: 14 })
      expect(updated.rawContent).toContain("// User setting")
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("safeUpdateConfig updates JSON file using callback", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "cfg-cb-"))
    try {
      const filePath = join(tempDir, "config.json")
      writeFileSync(filePath, JSON.stringify({ version: "1.0.0" }))

      const result = safeUpdateConfig(filePath, (current: any) => ({
        ...current,
        version: "1.1.0"
      }))
      expect(result.ok).toBe(true)

      const updated = safeReadConfig(filePath)
      expect(updated.data).toEqual({ version: "1.1.0" })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
