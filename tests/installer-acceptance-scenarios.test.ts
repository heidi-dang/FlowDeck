import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import {
  isFlowDeckCacheDir,
  verifyRuntimeIdentity,
  isFlowDeckIdentity,
  INSTALLER_STATES,
} from "../scripts/clean-install-engine.mjs"

import { createBackup } from "../scripts/config-mutator.mjs"
import { runPluginChecks } from "../src/doctor/checks/plugin"
import { recordRuntimeSelfReport } from "../src/services/runtime-identity"

describe("Installer Acceptance Scenarios (Phase L)", () => {
  let tempDir: string
  let originalXdgCache: string | undefined
  let originalXdgData: string | undefined

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fd-installer-acc-test-"))
    originalXdgCache = process.env.XDG_CACHE_HOME
    originalXdgData = process.env.XDG_DATA_HOME
    process.env.XDG_CACHE_HOME = join(tempDir, ".cache")
    process.env.XDG_DATA_HOME = join(tempDir, ".local", "share")
    mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true })
    mkdirSync(process.env.XDG_DATA_HOME, { recursive: true })
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

  describe("Scenario 1 — stale cached latest + RC config", () => {
    it("detects mismatch, cleans up stale cache, restarts, and reports RC.1 runtime identity", async () => {
      // Arrange
      const pluginDir = join(tempDir, "target-plugin")
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({
          name: "@heidi-dang/flowdeck",
          version: "2.0.0-rc.1",
          main: "./dist/index.js",
          type: "module",
        }),
        "utf-8"
      )
      mkdirSync(join(pluginDir, "dist"), { recursive: true })
      writeFileSync(join(pluginDir, "dist", "index.js"), "export default {}", "utf-8")

      // Create stale cached latest on disk in XDG_CACHE_HOME
      const staleCacheDir = join(process.env.XDG_CACHE_HOME!, "opencode", "packages", "@heidi-dang", "flowdeck@2.0.0-latest")
      mkdirSync(staleCacheDir, { recursive: true })
      writeFileSync(
        join(staleCacheDir, "package.json"),
        JSON.stringify({ name: "@heidi-dang/flowdeck", version: "2.0.0" }),
        "utf-8"
      )

      // Self-report initially pointing to stale version
      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "2.0.0-latest",
          moduleUrl: `file://${join(staleCacheDir, "index.js")}`,
          packageRoot: staleCacheDir,
          source: "npm-cache",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        pluginDir
      )

      // Act — Step 1: Detect mismatch before cleanup & restart
      const initialChecks = await runPluginChecks(pluginDir)
      const initialRuntimeCheck = initialChecks.find((c) => c.id === "plugin.runtime_identity")
      const initialVerifyResult = verifyRuntimeIdentity(pluginDir, "2.0.0-rc.1", pluginDir)

      expect(initialRuntimeCheck?.status).toBe("error")
      expect(initialVerifyResult.ok).toBe(false)
      expect(initialVerifyResult.status).toBe("RESTART_REQUIRED")

      // Act — Step 2: Cleanup stale cache entry
      expect(isFlowDeckCacheDir(staleCacheDir)).toBe(true)
      rmSync(staleCacheDir, { recursive: true, force: true })
      expect(existsSync(staleCacheDir)).toBe(false)

      // Act — Step 3: Simulate restart (record runtime self-report for actual RC.1 runtime)
      const rc1ModuleUrl = `file://${join(pluginDir, "dist", "index.js")}`
      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "2.0.0-rc.1",
          moduleUrl: rc1ModuleUrl,
          packageRoot: pluginDir,
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        pluginDir
      )

      // Act — Step 4: Verify after cleanup and restart
      const postRestartVerify = verifyRuntimeIdentity(pluginDir, "2.0.0-rc.1", pluginDir)
      const postRestartChecks = await runPluginChecks(pluginDir)
      const postRestartRuntimeCheck = postRestartChecks.find((c) => c.id === "plugin.runtime_identity")

      // Assert
      expect(postRestartVerify.ok).toBe(true)
      expect(postRestartVerify.status).toBe("RUNTIME_VERIFIED")
      expect(postRestartVerify.selfReport?.version).toBe("2.0.0-rc.1")

      expect(postRestartRuntimeCheck).toBeDefined()
      expect(postRestartRuntimeCheck?.status).toBe("pass")
      expect(postRestartRuntimeCheck?.detected).toContain("v2.0.0-rc.1")
    })
  })

  describe("Scenario 2 — config updated but process running old module", () => {
    it("transitions state to RESTART_REQUIRED then passes doctor check after simulated process reload", async () => {
      // Arrange
      const pluginDir = join(tempDir, "target-plugin")
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({
          name: "@heidi-dang/flowdeck",
          version: "2.0.0-rc.1",
          main: "./dist/index.js",
          type: "module",
        }),
        "utf-8"
      )
      mkdirSync(join(pluginDir, "dist"), { recursive: true })
      writeFileSync(join(pluginDir, "dist", "index.js"), "export default {}", "utf-8")

      // Record old module self-report (e.g. running 2.0.0-alpha.4)
      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "2.0.0-alpha.4",
          moduleUrl: "file:///old/location/dist/index.js",
          packageRoot: "/old/location",
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        pluginDir
      )

      // Act — Step 1: Verify identity when config is updated but process still runs old module
      const preReloadResult = verifyRuntimeIdentity(pluginDir, "2.0.0-rc.1", pluginDir)

      // Assert — Step 1
      expect(preReloadResult.ok).toBe(false)
      expect(preReloadResult.status).toBe(INSTALLER_STATES.RESTART_REQUIRED)
      expect(preReloadResult.modelStatus).toBe("CONFIG_CHANGED")
      expect(preReloadResult.reason).toContain("Loaded runtime identity")
      expect(preReloadResult.restartInstruction).toContain("OpenCode restart required")

      // Act — Step 2: Simulate process reload by updating self-report to RC.1
      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "2.0.0-rc.1",
          moduleUrl: `file://${join(pluginDir, "dist", "index.js")}`,
          packageRoot: pluginDir,
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        pluginDir
      )

      const postReloadResult = verifyRuntimeIdentity(pluginDir, "2.0.0-rc.1", pluginDir)
      const checks = await runPluginChecks(pluginDir)
      const runtimeCheck = checks.find((c) => c.id === "plugin.runtime_identity")

      // Assert — Step 2
      expect(postReloadResult.ok).toBe(true)
      expect(postReloadResult.status).toBe("RUNTIME_VERIFIED")
      expect(postReloadResult.selfReport?.version).toBe("2.0.0-rc.1")

      expect(runtimeCheck).toBeDefined()
      expect(runtimeCheck?.status).toBe("pass")
    })
  })

  describe("Scenario 3 — clean install", () => {
    it("verifies single registration, correct package, loaded runtime, and healthy doctor check", async () => {
      // Arrange
      const pluginDir = join(tempDir, "clean-plugin")
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(
        join(pluginDir, "package.json"),
        JSON.stringify({
          name: "@heidi-dang/flowdeck",
          version: "2.0.0-rc.1",
          main: "./dist/index.js",
          type: "module",
        }),
        "utf-8"
      )
      mkdirSync(join(pluginDir, "dist"), { recursive: true })
      writeFileSync(join(pluginDir, "dist", "index.js"), "export default {}", "utf-8")

      const configPath = join(tempDir, "opencode.json")
      const configData = {
        plugin: ["@heidi-dang/flowdeck"],
      }
      writeFileSync(configPath, JSON.stringify(configData, null, 2), "utf-8")

      // Record matching runtime self-report
      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "2.0.0-rc.1",
          moduleUrl: `file://${join(pluginDir, "dist", "index.js")}`,
          packageRoot: pluginDir,
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        pluginDir
      )

      // Act
      const configContent = JSON.parse(readFileSync(configPath, "utf-8"))
      const pluginRegistrations = configContent.plugin
      const isFlowDeck = isFlowDeckIdentity(pluginRegistrations[0])
      const verifyResult = verifyRuntimeIdentity(pluginDir, "2.0.0-rc.1", pluginDir)
      const checks = await runPluginChecks(pluginDir)

      // Assert
      expect(pluginRegistrations.length).toBe(1)
      expect(pluginRegistrations[0]).toBe("@heidi-dang/flowdeck")
      expect(isFlowDeck).toBe(true)

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.status).toBe("RUNTIME_VERIFIED")

      const identityCheck = checks.find((c) => c.id === "plugin.identity")
      const contractCheck = checks.find((c) => c.id === "plugin.contract")
      const bundleCheck = checks.find((c) => c.id === "plugin.bundle")
      const runtimeCheck = checks.find((c) => c.id === "plugin.runtime_identity")

      expect(identityCheck?.status).toBe("pass")
      expect(contractCheck?.status).toBe("pass")
      expect(bundleCheck?.status).toBe("pass")
      expect(runtimeCheck?.status).toBe("pass")
    })
  })

  describe("Scenario 4 — upgrade from v1 (@dv.nghiem/flowdeck)", () => {
    it("detects v1, performs backup and cleanup, installs RC.1, and verifies healthy doctor state after restart", async () => {
      // Arrange
      const configDir = join(tempDir, "config")
      mkdirSync(configDir, { recursive: true })
      const configFile = join(configDir, "opencode.json")

      // Config starts with legacy v1 package registration
      const legacyV1Ref = "@dv.nghiem/flowdeck"
      writeFileSync(configFile, JSON.stringify({ plugin: [legacyV1Ref] }, null, 2), "utf-8")

      // Create v1 cache directory
      const v1CacheDir = join(process.env.XDG_CACHE_HOME!, "opencode", "packages", "@dv.nghiem", "flowdeck@1.0.0")
      mkdirSync(v1CacheDir, { recursive: true })
      writeFileSync(
        join(v1CacheDir, "package.json"),
        JSON.stringify({ name: "@dv.nghiem/flowdeck", version: "1.0.0" }),
        "utf-8"
      )

      // Act — Step 1: Detect legacy v1 registration & cache
      expect(isFlowDeckIdentity(legacyV1Ref)).toBe(true)
      expect(isFlowDeckCacheDir(v1CacheDir)).toBe(true)

      // Act — Step 2: Backup config file before modification
      const backupPath = createBackup(configFile)
      expect(backupPath).not.toBeNull()
      expect(existsSync(backupPath!)).toBe(true)

      // Act — Step 3: Cleanup legacy v1 registration and cache
      rmSync(v1CacheDir, { recursive: true, force: true })
      expect(existsSync(v1CacheDir)).toBe(false)

      // Act — Step 4: Install RC.1 (update config & create target package directory)
      const rc1PluginDir = join(tempDir, "rc1-plugin")
      mkdirSync(rc1PluginDir, { recursive: true })
      writeFileSync(
        join(rc1PluginDir, "package.json"),
        JSON.stringify({
          name: "@heidi-dang/flowdeck",
          version: "2.0.0-rc.1",
          main: "./dist/index.js",
          type: "module",
        }),
        "utf-8"
      )
      mkdirSync(join(rc1PluginDir, "dist"), { recursive: true })
      writeFileSync(join(rc1PluginDir, "dist", "index.js"), "export default {}", "utf-8")

      writeFileSync(configFile, JSON.stringify({ plugin: ["@heidi-dang/flowdeck@2.0.0-rc.1"] }, null, 2), "utf-8")

      // Act — Step 5: Simulate restart (record runtime self-report for RC.1)
      recordRuntimeSelfReport(
        {
          packageName: "@heidi-dang/flowdeck",
          version: "2.0.0-rc.1",
          moduleUrl: `file://${join(rc1PluginDir, "dist", "index.js")}`,
          packageRoot: rc1PluginDir,
          source: "package",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        rc1PluginDir
      )

      // Act — Step 6: Verify final healthy state
      const updatedConfig = JSON.parse(readFileSync(configFile, "utf-8"))
      const verifyResult = verifyRuntimeIdentity(rc1PluginDir, "2.0.0-rc.1", rc1PluginDir)
      const checks = await runPluginChecks(rc1PluginDir)
      const runtimeCheck = checks.find((c) => c.id === "plugin.runtime_identity")

      // Assert
      expect(updatedConfig.plugin).toContain("@heidi-dang/flowdeck@2.0.0-rc.1")
      expect(updatedConfig.plugin).not.toContain(legacyV1Ref)

      expect(verifyResult.ok).toBe(true)
      expect(verifyResult.status).toBe("RUNTIME_VERIFIED")
      expect(verifyResult.selfReport?.packageName).toBe("@heidi-dang/flowdeck")
      expect(verifyResult.selfReport?.version).toBe("2.0.0-rc.1")

      expect(runtimeCheck).toBeDefined()
      expect(runtimeCheck?.status).toBe("pass")
    })
  })
})
