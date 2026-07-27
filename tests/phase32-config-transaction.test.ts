import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { safeUpdateConfig } from "@/services/config-editor"

const TMP = join(tmpdir(), "phase32-config-tx-" + Date.now())

describe("Phase 32 — Safe Configuration Transaction & Atomic Edits", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }) } catch {}
  })

  it("mutates target config file on disk and returns updated data", () => {
    const configPath = join(TMP, "config.json")
    writeFileSync(configPath, JSON.stringify({ mode: "off", level: 1 }), "utf-8")

    const res = safeUpdateConfig<Record<string, any>>(configPath, (curr) => ({
      ...curr,
      mode: "strict",
    }))

    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ mode: "strict", level: 1 })
    const updatedOnDisk = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(updatedOnDisk.mode).toBe("strict")
  })

  it("creates a backup file containing byte-perfect prior content before mutation", () => {
    const configPath = join(TMP, "config_backup.json")
    const originalContent = JSON.stringify({ version: "1.0.0", active: false }, null, 2)
    writeFileSync(configPath, originalContent, "utf-8")

    const res = safeUpdateConfig<Record<string, any>>(configPath, (curr) => ({
      ...curr,
      active: true,
    }))

    expect(res.ok).toBe(true)
    expect(res.backupPath).toBeDefined()
    expect(existsSync(res.backupPath!)).toBe(true)
    const backupContent = readFileSync(res.backupPath!, "utf-8")
    expect(backupContent).toBe(originalContent)
  })

  it("rejects updating malformed JSON config without touching disk or creating backup", () => {
    const configPath = join(TMP, "malformed.json")
    const malformedText = '{ mode: "strict", missingQuotes: true '
    writeFileSync(configPath, malformedText, "utf-8")

    const res = safeUpdateConfig(configPath, (curr) => ({ ...curr, mutated: true }))

    expect(res.ok).toBe(false)
    expect(res.error).toContain("Cannot update malformed configuration")
    expect(readFileSync(configPath, "utf-8")).toBe(malformedText)
  })

  it("cleans up temporary write files after successful atomic write", () => {
    const configPath = join(TMP, "clean_tmp.json")
    writeFileSync(configPath, JSON.stringify({ initial: true }), "utf-8")

    const res = safeUpdateConfig(configPath, (curr) => ({ ...curr, updated: true }))

    expect(res.ok).toBe(true)
    const files = readdirSync(TMP)
    const tmpFiles = files.filter((f) => f.startsWith(".tmp_"))
    expect(tmpFiles.length).toBe(0)
  })

  it("handles non-existent file creation gracefully", () => {
    const configPath = join(TMP, "new_config.json")

    const res = safeUpdateConfig<Record<string, any>>(configPath, () => ({
      created: true,
      timestamp: 12345,
    }))

    expect(res.ok).toBe(true)
    expect(existsSync(configPath)).toBe(true)
    const diskContent = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(diskContent).toEqual({ created: true, timestamp: 12345 })
  })

  it("handles serialization failure safely without mutating disk", () => {
    const configPath = join(TMP, "serial_fail.json")
    const initialContent = JSON.stringify({ valid: true })
    writeFileSync(configPath, initialContent, "utf-8")

    const circular: any = { name: "circular" }
    circular.self = circular

    const res = safeUpdateConfig(configPath, () => circular)

    expect(res.ok).toBe(false)
    expect(res.error).toContain("Failed to serialize")
    expect(readFileSync(configPath, "utf-8")).toBe(initialContent)
  })
})
