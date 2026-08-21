import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { runConfigurationChecks } from "../../src/doctor/checks/configuration"
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("runConfigurationChecks", () => {
  const testDir = join(tmpdir(), "config-checks-test-" + Math.random().toString(36).slice(2))
  const configDir = join(testDir, "opencode-cfg")
  const origCfg = process.env.OPENCODE_CONFIG_DIR

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
    mkdirSync(testDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = configDir
  })

  afterEach(() => {
    process.env.OPENCODE_CONFIG_DIR = origCfg
    if (existsSync(testDir)) rmSync(testDir, { recursive: true })
  })

  it("handles missing files and missing config", async () => {
    const checks = await runConfigurationChecks(testDir)
    expect(checks.some(c => c.id === "config.package.json" && c.status === "error")).toBe(true)
    expect(checks.some(c => c.id === "config.opencode_user" && c.status === "info")).toBe(true)
  })

  it("handles legacy plugin registration", async () => {
    writeFileSync(join(testDir, "package.json"), "{}")
    writeFileSync(join(testDir, "tsconfig.json"), "{}")
    writeFileSync(join(testDir, "install.sh"), "#!/bin/bash")
    writeFileSync(join(testDir, "uninstall.sh"), "#!/bin/bash")

    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
      plugin: ["@dv.nghiem/flowdeck"]
    }))

    const checks = await runConfigurationChecks(testDir)
    expect(checks.some(c => c.id === "plugin.registration" && c.status === "error")).toBe(true)
  })

  it("handles valid current plugin registration and flowdeck project json", async () => {
    writeFileSync(join(testDir, "package.json"), "{}")
    writeFileSync(join(testDir, "tsconfig.json"), "{}")
    writeFileSync(join(testDir, "install.sh"), "#!/bin/bash")
    writeFileSync(join(testDir, "uninstall.sh"), "#!/bin/bash")
    writeFileSync(join(testDir, ".flowdeck.json"), JSON.stringify({ version: "1" }))

    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
      plugin: ["@heidi-dang/flowdeck@2.2.7"]
    }))

    const checks = await runConfigurationChecks(testDir)
    expect(checks.some(c => c.id === "plugin.registration" && c.status === "pass")).toBe(true)
    expect(checks.some(c => c.id === "config.flowdeck_project" && c.status === "pass")).toBe(true)
  })
})
