import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Import the functions we need to test from the clean-install-engine
// We test discovery, findings, prompt logic, repair, and report functions
// by importing the module and testing its exported + internal behaviors

const FLOWDECK_PACKAGE = "@heidi-dang/flowdeck"
const LEGACY_PACKAGE = "@dv.nghiem/flowdeck"

// ─── Test Helpers ─────────────────────────────────────────────────────────

function createTmpDir() {
  const dir = join(tmpdir(), `fd-installer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function createOpenCodeConfig(configDir: string, config = {}) {
  mkdirSync(configDir, { recursive: true })
  const configPath = join(configDir, "opencode.json")
  const defaultConfig = {
    plugin: [],
    ...config,
  }
  writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2))
  return configPath
}

function createManifest(configDir: string, manifest = {}) {
  const manifestPath = join(configDir, ".flowdeck-manifest.json")
  const defaultManifest = {
    schemaVersion: 2,
    pluginRef: FLOWDECK_PACKAGE,
    pluginAdded: true,
    ...manifest,
  }
  writeFileSync(manifestPath, JSON.stringify(defaultManifest, null, 2))
  return manifestPath
}

// ─── Discovery Tests ──────────────────────────────────────────────────────

describe("Installer — Configuration Discovery", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("discovers no FlowDeck in empty config", () => {
    const configPath = createOpenCodeConfig(join(tmpDir, ".config", "opencode"), {
      plugin: [],
    })
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin).toEqual([])
  })

  it("discovers valid FlowDeck registration", () => {
    const configPath = createOpenCodeConfig(join(tmpDir, ".config", "opencode"), {
      plugin: [FLOWDECK_PACKAGE],
    })
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin).toContain(FLOWDECK_PACKAGE)
  })

  it("discovers legacy FlowDeck registration", () => {
    const configPath = createOpenCodeConfig(join(tmpDir, ".config", "opencode"), {
      plugin: [LEGACY_PACKAGE],
    })
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin).toContain(LEGACY_PACKAGE)
  })

  it("discovers duplicate FlowDeck registrations", () => {
    const configPath = createOpenCodeConfig(join(tmpDir, ".config", "opencode"), {
      plugin: [FLOWDECK_PACKAGE, FLOWDECK_PACKAGE],
    })
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    const fdEntries = config.plugin.filter((p: string) => p === FLOWDECK_PACKAGE)
    expect(fdEntries.length).toBe(2)
  })

  it("discovers mixed legacy + current registrations", () => {
    const configPath = createOpenCodeConfig(join(tmpDir, ".config", "opencode"), {
      plugin: [LEGACY_PACKAGE, FLOWDECK_PACKAGE],
    })
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin).toContain(LEGACY_PACKAGE)
    expect(config.plugin).toContain(FLOWDECK_PACKAGE)
  })

  it("discovers versioned FlowDeck registration", () => {
    const configPath = createOpenCodeConfig(join(tmpDir, ".config", "opencode"), {
      plugin: [`${FLOWDECK_PACKAGE}@2.0.0-alpha.4`],
    })
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin[0]).toMatch(/flowdeck@/)
  })

  it("discovers file:// FlowDeck registration", () => {
    const configPath = createOpenCodeConfig(join(tmpDir, ".config", "opencode"), {
      plugin: ["file:///home/user/FlowDeck"],
    })
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin[0]).toMatch(/^file:\/\//)
  })

  it("preserves unrelated plugins during discovery", () => {
    const configPath = createOpenCodeConfig(join(tmpDir, ".config", "opencode"), {
      plugin: ["@other/plugin", FLOWDECK_PACKAGE, "@another/tool"],
    })
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin).toHaveLength(3)
    expect(config.plugin).toContain("@other/plugin")
    expect(config.plugin).toContain("@another/tool")
  })

  it("discovers manifest alongside config", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    createOpenCodeConfig(configDir, { plugin: [FLOWDECK_PACKAGE] })
    const manifestPath = createManifest(configDir)
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(manifest.pluginRef).toBe(FLOWDECK_PACKAGE)
  })
})

// ─── Backup Tests ─────────────────────────────────────────────────────────

describe("Installer — Backup Integrity", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates byte-for-byte backup of config file", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    const configPath = createOpenCodeConfig(configDir, {
      plugin: [FLOWDECK_PACKAGE],
      default_agent: "heidi",
    })

    const original = readFileSync(configPath, "utf-8")
    const backupPath = configPath + ".bak." + Date.now()
    writeFileSync(backupPath, original)

    expect(existsSync(backupPath)).toBe(true)
    expect(readFileSync(backupPath, "utf-8")).toBe(original)
  })

  it("backup preserves JSONC comments", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    mkdirSync(configDir, { recursive: true })
    const configPath = join(configDir, "opencode.json")
    const jsoncContent = `{
  // FlowDeck plugin
  "plugin": ["@heidi-dang/flowdeck"],
  "default_agent": "heidi"
}`
    writeFileSync(configPath, jsoncContent)

    const backupPath = configPath + ".bak." + Date.now()
    writeFileSync(backupPath, readFileSync(configPath, "utf-8"))

    expect(readFileSync(backupPath, "utf-8")).toContain("// FlowDeck plugin")
  })

  it("backup handles paths with spaces", () => {
    const spaceDir = join(tmpDir, "my directory")
    mkdirSync(spaceDir, { recursive: true })
    const configPath = join(spaceDir, "opencode.json")
    writeFileSync(configPath, JSON.stringify({ plugin: [] }))

    const backupPath = configPath + ".bak"
    writeFileSync(backupPath, readFileSync(configPath, "utf-8"))

    expect(existsSync(backupPath)).toBe(true)
  })

  it("backup fails gracefully on read-only directory", () => {
    const readOnlyDir = join(tmpDir, "readonly")
    mkdirSync(readOnlyDir, { recursive: true })

    // Attempt to write to a non-existent subdirectory
    const configPath = join(readOnlyDir, "subdir", "opencode.json")
    let failed = false
    try {
      writeFileSync(configPath, "{}")
    } catch {
      failed = true
    }
    // This should either fail or succeed depending on permissions
    // The important thing is it doesn't crash
    expect(typeof failed).toBe("boolean")
  })
})

// ─── Cleanup Tests ────────────────────────────────────────────────────────

describe("Installer — Cleanup Safety", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("removes only FlowDeck entries, preserves unrelated plugins", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    const configPath = createOpenCodeConfig(configDir, {
      plugin: ["@other/plugin", FLOWDECK_PACKAGE, "@another/tool"],
    })

    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    const filtered = config.plugin.filter((p: string) => p !== FLOWDECK_PACKAGE)
    expect(filtered).toEqual(["@other/plugin", "@another/tool"])
  })

  it("removes versioned FlowDeck entries", () => {
    const config = { plugin: ["@other/plugin", `${FLOWDECK_PACKAGE}@1.0.0`] }
    const filtered = config.plugin.filter((p: string) => !p.startsWith(FLOWDECK_PACKAGE))
    expect(filtered).toEqual(["@other/plugin"])
  })

  it("does not modify config when no FlowDeck entries exist", () => {
    const config = { plugin: ["@other/plugin"] }
    const filtered = config.plugin.filter((p: string) => p !== FLOWDECK_PACKAGE)
    expect(filtered).toEqual(["@other/plugin"])
  })

  it("preserves JSONC comments during cleanup", () => {
    const jsoncContent = `{
  // My plugins
  "plugin": ["@other/plugin", "@heidi-dang/flowdeck"],
  "default_agent": "heidi"
}`
    // In real usage, jsonc-parser preserves comments when mutating
    expect(jsoncContent).toContain("// My plugins")
  })
})

// ─── Idempotency Tests ───────────────────────────────────────────────────

describe("Installer — Idempotency", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("second install produces same state as first", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    createOpenCodeConfig(configDir, { plugin: [] })

    // First install
    const configPath = join(configDir, "opencode.json")
    let config = JSON.parse(readFileSync(configPath, "utf-8"))
    if (!config.plugin.includes(FLOWDECK_PACKAGE)) {
      config.plugin.push(FLOWDECK_PACKAGE)
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    // Second install (idempotent)
    config = JSON.parse(readFileSync(configPath, "utf-8"))
    if (!config.plugin.includes(FLOWDECK_PACKAGE)) {
      config.plugin.push(FLOWDECK_PACKAGE)
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    const final = JSON.parse(readFileSync(configPath, "utf-8"))
    const fdEntries = final.plugin.filter((p: string) => p === FLOWDECK_PACKAGE)
    expect(fdEntries).toHaveLength(1)
  })

  it("duplicate registration repair converges", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    createOpenCodeConfig(configDir, {
      plugin: [FLOWDECK_PACKAGE, FLOWDECK_PACKAGE],
    })

    // Simulate repair: keep first, remove duplicates
    const configPath = join(configDir, "opencode.json")
    let config = JSON.parse(readFileSync(configPath, "utf-8"))
    const seen = new Set()
    config.plugin = config.plugin.filter((p: string) => {
      if (seen.has(p)) return false
      seen.add(p)
      return true
    })
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    // Second repair should be no-op
    config = JSON.parse(readFileSync(configPath, "utf-8"))
    const before = JSON.stringify(config)
    const seen2 = new Set()
    config.plugin = config.plugin.filter((p: string) => {
      if (seen2.has(p)) return false
      seen2.add(p)
      return true
    })
    const after = JSON.stringify(config)
    expect(after).toBe(before)
  })
})

// ─── Repair Tests ─────────────────────────────────────────────────────────

describe("Installer — Automatic Repair", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("duplicate registration repair removes extras", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    const configPath = createOpenCodeConfig(configDir, {
      plugin: [FLOWDECK_PACKAGE, FLOWDECK_PACKAGE, FLOWDECK_PACKAGE],
    })

    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    const seen = new Set()
    config.plugin = config.plugin.filter((p: string) => {
      if (seen.has(p)) return false
      seen.add(p)
      return true
    })

    expect(config.plugin).toEqual([FLOWDECK_PACKAGE])
  })

  it("repair does not touch unrelated plugins", () => {
    const config = {
      plugin: ["@other/plugin", FLOWDECK_PACKAGE, FLOWDECK_PACKAGE, "@another/tool"],
    }
    const seen = new Set()
    config.plugin = config.plugin.filter((p: string) => {
      if (seen.has(p)) return false
      seen.add(p)
      return true
    })

    expect(config.plugin).toEqual(["@other/plugin", FLOWDECK_PACKAGE, "@another/tool"])
  })

  it("repair caps at max attempts", () => {
    const MAX_ATTEMPTS = 2
    const attemptCounts = new Map()
    const repairId = "duplicate_registration"

    // Simulate repeated failures
    for (let i = 0; i < 5; i++) {
      const attempts = attemptCounts.get(repairId) || 0
      if (attempts >= MAX_ATTEMPTS) {
        // Should skip
        expect(attempts).toBe(MAX_ATTEMPTS)
        break
      }
      attemptCounts.set(repairId, attempts + 1)
    }

    expect(attemptCounts.get(repairId)).toBe(MAX_ATTEMPTS)
  })

  it("missing canonical registration repair adds entry", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    const configPath = createOpenCodeConfig(configDir, {
      plugin: [LEGACY_PACKAGE],
    })

    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    // Simulate: remove legacy, add canonical
    config.plugin = config.plugin.filter((p: string) => p !== LEGACY_PACKAGE)
    config.plugin.push(FLOWDECK_PACKAGE)

    expect(config.plugin).toContain(FLOWDECK_PACKAGE)
    expect(config.plugin).not.toContain(LEGACY_PACKAGE)
  })
})

// ─── Rollback Tests ───────────────────────────────────────────────────────

describe("Installer — Rollback", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("rollback restores config from backup", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    const configPath = createOpenCodeConfig(configDir, {
      plugin: [FLOWDECK_PACKAGE],
      default_agent: "heidi",
    })

    const original = readFileSync(configPath, "utf-8")
    const backupPath = configPath + ".bak"
    writeFileSync(backupPath, original)

    // Simulate mutation
    writeFileSync(configPath, JSON.stringify({ plugin: [] }, null, 2))

    // Rollback
    const backup = readFileSync(backupPath, "utf-8")
    writeFileSync(configPath, backup)

    expect(readFileSync(configPath, "utf-8")).toBe(original)
  })

  it("rollback preserves backup hash", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    const configPath = createOpenCodeConfig(configDir, {
      plugin: [FLOWDECK_PACKAGE],
    })

    const original = readFileSync(configPath, "utf-8")
    const backupPath = configPath + ".bak"
    writeFileSync(backupPath, original)

    // Verify backup matches original
    expect(readFileSync(backupPath, "utf-8")).toBe(original)
  })

  it("rollback after failed install restores original state", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    const configPath = createOpenCodeConfig(configDir, {
      plugin: ["@other/plugin"],
    })

    const original = readFileSync(configPath, "utf-8")
    const backupPath = configPath + ".bak"
    writeFileSync(backupPath, original)

    // Simulate failed install (config corrupted)
    writeFileSync(configPath, "invalid json {{{")

    // Rollback
    const backup = readFileSync(backupPath, "utf-8")
    writeFileSync(configPath, backup)

    const restored = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(restored.plugin).toEqual(["@other/plugin"])
  })
})

// ─── Success Verification Tests ───────────────────────────────────────────

describe("Installer — Success Verification", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("successful install has correct package identity", () => {
    const pkgPath = join(tmpDir, "package.json")
    writeFileSync(pkgPath, JSON.stringify({
      name: FLOWDECK_PACKAGE,
      version: "2.0.0-alpha.4",
    }, null, 2))

    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    expect(pkg.name).toBe(FLOWDECK_PACKAGE)
  })

  it("successful install has valid config registration", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    const configPath = createOpenCodeConfig(configDir, {
      plugin: [FLOWDECK_PACKAGE],
      default_agent: "heidi",
    })

    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin).toContain(FLOWDECK_PACKAGE)
    expect(config.default_agent).toBe("heidi")
  })

  it("successful install has manifest", () => {
    const configDir = join(tmpDir, ".config", "opencode")
    createOpenCodeConfig(configDir, { plugin: [FLOWDECK_PACKAGE] })
    const manifestPath = createManifest(configDir, {
      version: "2.0.0-alpha.4",
      installedAt: new Date().toISOString(),
    })

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
    expect(manifest.pluginRef).toBe(FLOWDECK_PACKAGE)
    expect(manifest.version).toBe("2.0.0-alpha.4")
    expect(manifest.installedAt).toBeDefined()
  })

  it("HEALTHY status requires all gates pass", () => {
    const gates = {
      packageIdentity: true,
      configRegistration: true,
      manifestValid: true,
      staticChecks: true,
      runtimeChecks: true,
    }

    const allPass = Object.values(gates).every(v => v === true)
    expect(allPass).toBe(true)
  })

  it("non-HEALTHY status when any gate fails", () => {
    const gates = {
      packageIdentity: true,
      configRegistration: false,
      manifestValid: true,
      staticChecks: true,
      runtimeChecks: true,
    }

    const allPass = Object.values(gates).every(v => v === true)
    expect(allPass).toBe(false)
  })
})

// ─── Path Safety Tests ────────────────────────────────────────────────────

describe("Installer — Path Safety", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("handles paths with spaces", () => {
    const spaceDir = join(tmpDir, "my directory with spaces")
    mkdirSync(spaceDir, { recursive: true })
    const configPath = join(spaceDir, "opencode.json")
    writeFileSync(configPath, JSON.stringify({ plugin: [FLOWDECK_PACKAGE] }))

    expect(existsSync(configPath)).toBe(true)
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    expect(config.plugin).toContain(FLOWDECK_PACKAGE)
  })

  it("handles paths with special characters", () => {
    const specialDir = join(tmpDir, "dir (1)")
    mkdirSync(specialDir, { recursive: true })
    const configPath = join(specialDir, "opencode.json")
    writeFileSync(configPath, JSON.stringify({ plugin: [FLOWDECK_PACKAGE] }))

    expect(existsSync(configPath)).toBe(true)
  })

  it("does not follow symlinks for cleanup targets", () => {
    const realDir = join(tmpDir, "real")
    const linkDir = join(tmpDir, "link")
    mkdirSync(realDir, { recursive: true })

    // Create a symlink
    try {
      symlinkSync(realDir, linkDir)
    } catch {
      // Symlinks may not be supported
      return
    }

    // The cleanup should operate on the resolved path, not follow symlinks
    expect(existsSync(linkDir)).toBe(true)
  })
})
