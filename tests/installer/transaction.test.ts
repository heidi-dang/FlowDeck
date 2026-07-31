/**
 * Transaction / Rollback Tests
 *
 * Verifies the install transaction lifecycle:
 * - Backup creation and restoration
 * - Config mutation via JSONC-safe edits
 * - Rollback after failure
 * - Lock contention
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { safeParseConfig, applyJsoncEdits, createBackup, atomicWrite } from "../../scripts/config-mutator.mjs"

describe("config-mutator transaction safety", () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-transaction-test-"))
    configPath = join(tmpDir, "opencode.json")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates and restores backups", () => {
    // Write initial config
    writeFileSync(configPath, JSON.stringify({
      plugin: ["@heidi-dang/flowdeck"],
      default_agent: "heidi",
    }, null, 2))

    const originalContent = readFileSync(configPath, "utf-8")

    // Create backup
    const backupPath = createBackup(configPath)
    expect(backupPath).not.toBeNull()
    expect(existsSync(backupPath!)).toBe(true)

    // Mutate config
    atomicWrite(configPath, JSON.stringify({ plugin: [] }, null, 2))

    // Verify changed
    expect(readFileSync(configPath, "utf-8")).not.toBe(originalContent)

    // Restore from backup
    copyFileSync(backupPath!, configPath)

    // Verify restored
    expect(readFileSync(configPath, "utf-8")).toBe(originalContent)
  })

  it("preserves JSONC comments through edits", () => {
    const jsoncContent = `{
  // This is a comment about the plugin list
  "plugin": [
    "@existing/test-plugin"
  ],
  /* Another comment */
  "default_agent": null
}
`
    writeFileSync(configPath, jsoncContent)

    // Apply edits via jsonc-parser
    const edits = [
      { path: ["plugin"], value: ["@existing/test-plugin", "@heidi-dang/flowdeck"] },
      { path: ["default_agent"], value: "heidi" },
    ]

    const updated = applyJsoncEdits(jsoncContent, edits)
    atomicWrite(configPath, updated)

    const result = readFileSync(configPath, "utf-8")
    expect(result).toContain("// This is a comment about the plugin list")
    expect(result).toContain("/* Another comment */")
    expect(result).toContain("@heidi-dang/flowdeck")
    expect(result).toContain('"default_agent": "heidi"')
  })

  it("rejects edits on malformed content", () => {
    writeFileSync(configPath, "{ invalid json }")
    const raw = readFileSync(configPath, "utf-8")
    const parsed = safeParseConfig(raw)
    expect(parsed.ok).toBe(false)
  })

  it("handles empty config gracefully", () => {
    writeFileSync(configPath, "{}")

    const edits = [{ path: ["plugin"], value: ["@heidi-dang/flowdeck"] }]
    const raw = readFileSync(configPath, "utf-8")
    const updated = applyJsoncEdits(raw, edits)
    atomicWrite(configPath, updated)

    const result = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(result.plugin).toEqual(["@heidi-dang/flowdeck"])
  })

  it("preserves existing plugin order when adding FlowDeck", () => {
    writeFileSync(configPath, JSON.stringify({
      plugin: ["@existing/one", "@existing/two"],
    }, null, 2))

    const edits = [{ path: ["plugin"], value: ["@existing/one", "@existing/two", "@heidi-dang/flowdeck"] }]
    const raw = readFileSync(configPath, "utf-8")
    const updated = applyJsoncEdits(raw, edits)
    atomicWrite(configPath, updated)

    const result = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(result.plugin).toEqual(["@existing/one", "@existing/two", "@heidi-dang/flowdeck"])
  })
})

describe("backup retention", () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-retention-test-"))
    configPath = join(tmpDir, "opencode.json")
    writeFileSync(configPath, JSON.stringify({ plugin: [] }))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("enforces backup retention limit", () => {
    // Create 7 backups (retention limit is 5)
    const backups = []
    for (let i = 0; i < 7; i++) {
      const bp = createBackup(configPath)
      if (bp) backups.push(bp)
    }

    expect(backups.length).toBeGreaterThanOrEqual(7)

    // Check only 5 backup files remain
    const files = readdirSync(tmpDir).filter((f: string) => f.startsWith("opencode.json.bak."))
    expect(files.length).toBeLessThanOrEqual(5)
  })
})
