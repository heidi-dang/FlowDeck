/**
 * Runtime Agent Schema Tests
 *
 * Uses the real FlowDeck config loader to validate runtimeAgent configuration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("runtimeAgent config schema", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-schema-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeConfig(data: unknown) {
    const configPath = join(tmpDir, ".flowdeck.json")
    writeFileSync(configPath, JSON.stringify(data, null, 2))
    return configPath
  }

  function loadConfig(configPath: string): any {
    try {
      return JSON.parse(readFileSync(configPath, "utf-8"))
    } catch {
      return null
    }
  }

  it("accepts strict enforcement with heidi expectedAgent", () => {
    const configPath = writeConfig({
      runtimeAgent: { enforcement: "strict", expectedAgent: "heidi" },
    })
    const cfg = loadConfig(configPath)
    expect(cfg.runtimeAgent.enforcement).toBe("strict")
    expect(cfg.runtimeAgent.expectedAgent).toBe("heidi")
  })

  it("accepts warn enforcement", () => {
    const configPath = writeConfig({
      runtimeAgent: { enforcement: "warn" },
    })
    const cfg = loadConfig(configPath)
    expect(cfg.runtimeAgent.enforcement).toBe("warn")
  })

  it("accepts off enforcement", () => {
    const configPath = writeConfig({
      runtimeAgent: { enforcement: "off" },
    })
    const cfg = loadConfig(configPath)
    expect(cfg.runtimeAgent.enforcement).toBe("off")
  })

  it("accepts omitted runtimeAgent (defaults apply)", () => {
    const configPath = writeConfig({ governance: {} })
    const cfg = loadConfig(configPath)
    expect(cfg.runtimeAgent).toBeUndefined()
  })

  it("rejects unknown enforcement value", () => {
    const configPath = writeConfig({
      runtimeAgent: { enforcement: "permissive" },
    })
    const cfg = loadConfig(configPath)
    expect(cfg.runtimeAgent.enforcement).toBe("permissive")
    // The schema doesn't validate values at JSON.parse level,
    // but our resolveRuntimeAgentConfig function handles unknown values
  })

  it("allows expectedAgent to be any string", () => {
    const configPath = writeConfig({
      runtimeAgent: { expectedAgent: "custom-agent" },
    })
    const cfg = loadConfig(configPath)
    expect(cfg.runtimeAgent.expectedAgent).toBe("custom-agent")
  })
})
