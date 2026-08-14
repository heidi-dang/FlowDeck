import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import {
  isFlowDeckCacheDir,
  discoverCacheLocations,
  verifyRuntimeIdentity,
  INSTALLER_STATES,
} from "../scripts/clean-install-engine.mjs"

import { runPluginChecks } from "../src/doctor/checks/plugin"
import { recordRuntimeSelfReport } from "../src/services/runtime-identity"

describe("Installer Cache Discovery & Doctor Runtime Identity", () => {
  let tempDir: string
  let originalXdgCache: string | undefined
  let originalXdgData: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fd-installer-cache-test-"))
    originalXdgCache = process.env.XDG_CACHE_HOME
    originalXdgData = process.env.XDG_DATA_HOME
    process.env.XDG_CACHE_HOME = join(tempDir, ".cache")
    process.env.XDG_DATA_HOME = join(tempDir, ".local", "share")
  })

  afterEach(() => {
    if (originalXdgCache === undefined) {
      delete process.env.XDG_CACHE_HOME
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCache
    }
    if (originalXdgData === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = originalXdgData
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe("Safe cache discovery & non-FlowDeck preservation", () => {
    it("should identify FlowDeck cache directories and reject unrelated package directories", () => {
      // Arrange
      const flowdeckCache = join(tempDir, ".cache", "opencode", "packages", "@heidi-dang", "flowdeck@2.0.0")
      mkdirSync(flowdeckCache, { recursive: true })
      writeFileSync(
        join(flowdeckCache, "package.json"),
        JSON.stringify({ name: "@heidi-dang/flowdeck", version: "2.0.0" }),
        "utf-8"
      )

      const legacyCache = join(tempDir, ".cache", "opencode", "packages", "@dv.nghiem", "flowdeck@1.0.0")
      mkdirSync(legacyCache, { recursive: true })
      writeFileSync(
        join(legacyCache, "package.json"),
        JSON.stringify({ name: "@dv.nghiem/flowdeck", version: "1.0.0" }),
        "utf-8"
      )

      const unrelatedCache = join(tempDir, ".cache", "opencode", "packages", "unrelated-plugin")
      mkdirSync(unrelatedCache, { recursive: true })
      writeFileSync(
        join(unrelatedCache, "package.json"),
        JSON.stringify({ name: "unrelated-plugin", version: "0.1.0" }),
        "utf-8"
      )

      // Act
      const isFlowDeck1 = isFlowDeckCacheDir(flowdeckCache)
      const isFlowDeck2 = isFlowDeckCacheDir(legacyCache)
      const isUnrelated = isFlowDeckCacheDir(unrelatedCache)
      const cacheLocations = discoverCacheLocations()

      // Assert
      expect(isFlowDeck1).toBe(true)
      expect(isFlowDeck2).toBe(true)
      expect(isUnrelated).toBe(false)

      expect(cacheLocations).toContain(flowdeckCache)
      expect(cacheLocations).toContain(legacyCache)
      expect(cacheLocations).not.toContain(unrelatedCache)
    })
  })

  describe("Doctor runtime identity check (plugin.runtime_identity)", () => {
    it("should return PASS when runtime self-report agrees with target package", async () => {
      // Arrange
      const pluginDir = join(tempDir, "target-plugin")
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@heidi-dang/flowdeck", version: "2.0.0-alpha.4", main: "./dist/index.js", type: "module" }),
        "utf-8"
      )
      mkdirSync(join(pluginDir, "dist"), { recursive: true })
      writeFileSync(join(pluginDir, "dist", "index.js"), "export default {}", "utf-8")

      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "2.0.0-alpha.4",
          moduleUrl: `file://${join(pluginDir, "dist", "index.js")}`,
          packageRoot: pluginDir,
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        pluginDir
      )

      // Act
      const checks = await runPluginChecks(pluginDir)
      const runtimeCheck = checks.find(c => c.id === "plugin.runtime_identity")

      // Assert
      expect(runtimeCheck).toBeDefined()
      expect(runtimeCheck?.status).toBe("pass")
    })

    it("should return WARN_NON_BLOCKING when harmless stale FlowDeck cache exists but runtime matches", async () => {
      // Arrange
      const pluginDir = join(tempDir, "target-plugin")
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@heidi-dang/flowdeck", version: "2.0.0-alpha.4", main: "./dist/index.js", type: "module" }),
        "utf-8"
      )
      mkdirSync(join(pluginDir, "dist"), { recursive: true })
      writeFileSync(join(pluginDir, "dist", "index.js"), "export default {}", "utf-8")

      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "2.0.0-alpha.4",
          moduleUrl: `file://${join(pluginDir, "dist", "index.js")}`,
          packageRoot: pluginDir,
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        pluginDir
      )

      // Create a stale FlowDeck cache entry
      const staleCache = join(tempDir, ".cache", "opencode", "packages", "flowdeck-old")
      mkdirSync(staleCache, { recursive: true })
      writeFileSync(
        join(staleCache, "package.json"),
        JSON.stringify({ name: "@heidi-dang/flowdeck", version: "1.0.0" }),
        "utf-8"
      )

      // Act
      const checks = await runPluginChecks(pluginDir)
      const runtimeCheck = checks.find(c => c.id === "plugin.runtime_identity")

      // Assert
      expect(runtimeCheck).toBeDefined()
      expect(runtimeCheck?.status).toBe("warning")
      expect(runtimeCheck?.autoFixAvailable).toBe(true)
    })

    it("should return FAIL_BLOCKING (FLOWDECK_RUNTIME_IDENTITY_MISMATCH) when loaded runtime differs from target", async () => {
      // Arrange
      const pluginDir = join(tempDir, "target-plugin")
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({ name: "@heidi-dang/flowdeck", version: "2.0.0-alpha.4", main: "./dist/index.js", type: "module" }),
        "utf-8"
      )

      // Record a self-report pointing to an OLD version
      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "1.0.0-legacy",
          moduleUrl: `file:///other/path/index.js`,
          packageRoot: "/other/path",
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        pluginDir
      )

      // Act
      const checks = await runPluginChecks(pluginDir)
      const runtimeCheck = checks.find(c => c.id === "plugin.runtime_identity")

      // Assert
      expect(runtimeCheck).toBeDefined()
      expect(runtimeCheck?.status).toBe("error")
      expect(runtimeCheck?.recommendation).toContain("FLOWDECK_RUNTIME_IDENTITY_MISMATCH")
      expect(runtimeCheck?.autoFixAvailable).toBe(true)
    })
  })

  describe("Installer RESTART_REQUIRED state handling", () => {
    it("should set status RESTART_REQUIRED when runtime self-report does not match target", () => {
      // Arrange
      const targetConfigDir = join(tempDir, "config-dir")
      mkdirSync(targetConfigDir, { recursive: true })

      // Self-report with old version
      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "1.0.0",
          moduleUrl: `file:///old/path/index.js`,
          packageRoot: "/old/path",
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        targetConfigDir
      )

      // Act
      const result = verifyRuntimeIdentity(targetConfigDir, "2.0.0-alpha.4", "/new/target/path")

      // Assert
      expect(result.ok).toBe(false)
      expect(result.status).toBe("RESTART_REQUIRED")
      expect(result.modelStatus).toBe("CONFIG_CHANGED")
      expect(result.restartInstruction).toContain("OpenCode restart required")
      expect(INSTALLER_STATES.RESTART_REQUIRED).toBe("RESTART_REQUIRED")
    })
  })
})
