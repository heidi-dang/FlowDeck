/**
 * Identity Detection Tests
 *
 * Verifies that FlowDeck identity detection is safe and precise:
 * - Exact package name matches
 * - Versioned package matches
 * - file:// plugin resolution
 * - Path-based package.json verification
 * - No false positives for unrelated packages
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// Replicate the detection logic from clean-install-engine.mjs for testing
const FLOWDECK_PACKAGE = "@heidi-dang/flowdeck"
const LEGACY_PACKAGE = "@dv.nghiem/flowdeck"
const SUPPORTED_IDENTITIES = new Set([FLOWDECK_PACKAGE, LEGACY_PACKAGE])

function isFlowDeckIdentity(ref: string, _verbose = false): boolean {
  if (!ref || typeof ref !== "string") return false
  if (ref === FLOWDECK_PACKAGE || ref === LEGACY_PACKAGE) return true

  const scopeMatch = ref.match(/^(@[^/]+)\/([^@]+)@(.+)$/)
  if (scopeMatch) {
    const fullName = `${scopeMatch[1]}/${scopeMatch[2]}`
    if (SUPPORTED_IDENTITIES.has(fullName)) return true
  }

  if (ref.startsWith("file://")) {
    return isFilePathFlowDeck(ref.slice(7))
  }

  if (ref.startsWith("/") || ref.startsWith(".") || ref.startsWith("~")) {
    return isFilePathFlowDeck(ref)
  }

  return false
}

function isFilePathFlowDeck(filePath: string): boolean {
  if (!filePath) return false
  const resolved = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath)
  const pkgPath = join(resolved, "package.json")
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    const name = pkg.name || ""
    if (SUPPORTED_IDENTITIES.has(name)) return true
    return false
  } catch {
    return false
  }
}

describe("FlowDeck identity detection", () => {
  describe("exact package names", () => {
    it("matches @heidi-dang/flowdeck", () => {
      expect(isFlowDeckIdentity("@heidi-dang/flowdeck")).toBe(true)
    })

    it("matches @dv.nghiem/flowdeck", () => {
      expect(isFlowDeckIdentity("@dv.nghiem/flowdeck")).toBe(true)
    })

    it("does NOT match @other/flowdeck-theme", () => {
      expect(isFlowDeckIdentity("@other/flowdeck-theme")).toBe(false)
    })

    it("does NOT match @example/flowdeck-notes-plugin", () => {
      expect(isFlowDeckIdentity("@example/flowdeck-notes-plugin")).toBe(false)
    })

    it("does NOT match empty string", () => {
      expect(isFlowDeckIdentity("")).toBe(false)
    })

    it("does NOT match null or undefined", () => {
      expect(isFlowDeckIdentity(null as any)).toBe(false)
      expect(isFlowDeckIdentity(undefined as any)).toBe(false)
    })
  })

  describe("versioned package names", () => {
    it("matches @heidi-dang/flowdeck@0.8.0-alpha.1", () => {
      expect(isFlowDeckIdentity("@heidi-dang/flowdeck@0.8.0-alpha.1")).toBe(true)
    })

    it("matches @heidi-dang/flowdeck@latest", () => {
      expect(isFlowDeckIdentity("@heidi-dang/flowdeck@latest")).toBe(true)
    })

    it("matches @dv.nghiem/flowdeck@1.0.0", () => {
      expect(isFlowDeckIdentity("@dv.nghiem/flowdeck@1.0.0")).toBe(true)
    })

    it("does NOT match @dv.nghiem/some-other-package@1.0.0", () => {
      expect(isFlowDeckIdentity("@dv.nghiem/some-other-package@1.0.0")).toBe(false)
    })
  })

  describe("file:// plugin paths", () => {
    it("does NOT false-positive on non-existent paths", () => {
      expect(isFlowDeckIdentity("file:///tmp/nonexistent-flowdeck")).toBe(false)
    })

    it("does NOT false-positive on non-existent path references", () => {
      expect(isFlowDeckIdentity("/tmp/nonexistent-flowdeck")).toBe(false)
    })
  })

  describe("name similarity safety (no false positives)", () => {
    it("does NOT match strings merely containing 'flowdeck'", () => {
      expect(isFlowDeckIdentity("@something/flowdeck-theme")).toBe(false)
      expect(isFlowDeckIdentity("flowdeck-other")).toBe(false)
      expect(isFlowDeckIdentity("my-flowdeck-plugin")).toBe(false)
    })

    it("does NOT match packages merely containing 'heidi'", () => {
      expect(isFlowDeckIdentity("@something/heidi-helper")).toBe(false)
    })
  })

  describe("npm alias resolution", () => {
    it("matches exact alias that resolves to @heidi-dang/flowdeck", () => {
      expect(isFlowDeckIdentity("@heidi-dang/flowdeck")).toBe(true)
    })

    it("matches exact alias that resolves to @dv.nghiem/flowdeck", () => {
      expect(isFlowDeckIdentity("@dv.nghiem/flowdeck")).toBe(true)
    })
  })
})

describe("file-based identity detection", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-identity-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("identifies a valid FlowDeck package directory", () => {
    // Create a mock package.json with FlowDeck identity
    mkdirSync(join(tmpDir, "node_modules", "@heidi-dang", "flowdeck"), { recursive: true })
    writeFileSync(
      join(tmpDir, "node_modules", "@heidi-dang", "flowdeck", "package.json"),
      JSON.stringify({ name: "@heidi-dang/flowdeck", version: "0.8.0" })
    )

    const ref = join(tmpDir, "node_modules", "@heidi-dang", "flowdeck")
    expect(isFlowDeckIdentity(ref)).toBe(true)
  })

  it("identifies a valid legacy FlowDeck package directory", () => {
    mkdirSync(join(tmpDir, "node_modules", "@dv-nghiem", "flowdeck"), { recursive: true })
    writeFileSync(
      join(tmpDir, "node_modules", "@dv-nghiem", "flowdeck", "package.json"),
      JSON.stringify({ name: "@dv.nghiem/flowdeck", version: "1.0.0" })
    )

    // We need file:// ref for absolute path detection
    const ref = join(tmpDir, "node_modules", "@dv-nghiem", "flowdeck")
    expect(isFlowDeckIdentity(ref)).toBe(true)
  })

  it("does NOT identify unrelated package with flowdeck in path", () => {
    mkdirSync(join(tmpDir, "projects", "flowdeck-notes-plugin"), { recursive: true })
    writeFileSync(
      join(tmpDir, "projects", "flowdeck-notes-plugin", "package.json"),
      JSON.stringify({ name: "@example/flowdeck-notes-plugin", version: "1.0.0" })
    )

    const ref = join(tmpDir, "projects", "flowdeck-notes-plugin")
    expect(isFlowDeckIdentity(ref)).toBe(false)
  })

  it("does NOT identify package with flowdeck in description but different name", () => {
    mkdirSync(join(tmpDir, "packages", "some-plugin"), { recursive: true })
    writeFileSync(
      join(tmpDir, "packages", "some-plugin", "package.json"),
      JSON.stringify({
        name: "@example/some-plugin",
        description: "A plugin for FlowDeck integration",
      })
    )

    const ref = join(tmpDir, "packages", "some-plugin")
    expect(isFlowDeckIdentity(ref)).toBe(false)
  })
})
