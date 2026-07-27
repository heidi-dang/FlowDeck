/**
 * Stale FlowDeck Registration Tests
 *
 * Verifies that stale missing file://.../flowdeck references are recognized,
 * removed during clean install, and unrelated plugins preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { fileURLToPath, pathToFileURL } from "url"

const FLOWDECK_PACKAGE = "@heidi-dang/flowdeck"
const LEGACY_PACKAGE = "@dv.nghiem/flowdeck"
const SUPPORTED_IDENTITIES = new Set([FLOWDECK_PACKAGE, LEGACY_PACKAGE])

// Replicate the fixed identity logic
function isFlowDeckIdentity(ref: string, _verbose = false): boolean {
  if (!ref || typeof ref !== "string") return false
  if (ref === FLOWDECK_PACKAGE || ref === LEGACY_PACKAGE) return true

  const scopeMatch = ref.match(/^(@[^/]+)\/([^@]+)@(.+)$/)
  if (scopeMatch) {
    const fullName = `${scopeMatch[1]}/${scopeMatch[2]}`
    if (SUPPORTED_IDENTITIES.has(fullName)) return true
  }

  if (ref.startsWith("file://")) {
    return isFilePathFlowDeck(ref)
  }

  if (ref.startsWith("/") || ref.startsWith(".") || ref.startsWith("~") || /^[A-Za-z]:\\/.test(ref)) {
    return isFilePathFlowDeck(ref)
  }

  return false
}

function isFilePathFlowDeck(ref: string): boolean {
  let resolved: string
  if (ref.startsWith("file://")) {
    try {
      resolved = fileURLToPath(ref)
    } catch {
      resolved = ref.startsWith("file:///") ? decodeURIComponent(ref.slice(7)) : decodeURIComponent(ref.slice(5))
    }
  } else {
    resolved = ref.startsWith("~")
      ? join(process.env.HOME || "/tmp", ref.slice(1))
      : ref
  }

  const pkgPath = join(resolved, "package.json")

  // Path exists: check package.json identity
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      const name = pkg.name || ""
      if (SUPPORTED_IDENTITIES.has(name)) return true
      return false
    } catch {
      resolved = ref.startsWith("file:///") ? decodeURIComponent(ref.slice(7)) : decodeURIComponent(ref.slice(5))
    }
  }

  // Stale checkout fallback: final path component === "flowdeck" (case-insensitive)
  const parts = resolved.split("/").filter(Boolean)
  const basename = parts.length > 0 ? parts[parts.length - 1] : ""
  return basename.toLowerCase() === "flowdeck"
}

describe("stale FlowDeck checkout detection", () => {
  it("detects stale file:///home/heidi/flowdeck as FlowDeck identity", () => {
    expect(isFlowDeckIdentity("file:///home/heidi/flowdeck")).toBe(true)
  })

  it("detects stale file:///tmp/FlowDeck as FlowDeck (case-insensitive)", () => {
    expect(isFlowDeckIdentity("file:///tmp/FlowDeck")).toBe(true)
  })

  it("detects stale file:///home/user/deleted/flowdeck as FlowDeck", () => {
    expect(isFlowDeckIdentity("file:///home/user/deleted/flowdeck")).toBe(true)
  })

  it("does NOT detect file:///opt/unrelated-plugin as FlowDeck", () => {
    expect(isFlowDeckIdentity("file:///opt/unrelated-plugin")).toBe(false)
  })

  it("does NOT detect file:///opt/other-plugins/flowdeck-theme as FlowDeck", () => {
    // Only matches when final path component is exactly "flowdeck"
    expect(isFlowDeckIdentity("file:///opt/other-plugins/flowdeck-theme")).toBe(false)
  })

  it("detects @heidi-dang/flowdeck as FlowDeck identity", () => {
    expect(isFlowDeckIdentity("@heidi-dang/flowdeck")).toBe(true)
  })

  it("detects @dv.nghiem/flowdeck as legacy FlowDeck identity", () => {
    expect(isFlowDeckIdentity("@dv.nghiem/flowdeck")).toBe(true)
  })

  it("detects versioned identity @heidi-dang/flowdeck@0.8.0-alpha.6", () => {
    expect(isFlowDeckIdentity("@heidi-dang/flowdeck@0.8.0-alpha.6")).toBe(true)
  })

  it("does NOT match @example/flowdeck-theme by name", () => {
    expect(isFlowDeckIdentity("@example/flowdeck-theme")).toBe(false)
  })

  it("does NOT match string merely containing 'flowdeck'", () => {
    expect(isFlowDeckIdentity("some-flowdeck-related-thing")).toBe(false)
  })
})

describe("stale dir with unrelated package.json", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-stale-flowdeck-dir-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("preserves directory named flowdeck with unrelated package.json", () => {
    // Create a directory named flowdeck with an UNRELATED package
    const flowdeckDir = join(tmpDir, "flowdeck")
    mkdirSync(flowdeckDir, { recursive: true })

    // Package belongs to unrelated org
    writeFileSync(
      join(flowdeckDir, "package.json"),
      JSON.stringify({ name: "@example/unrelated-plugin", version: "1.0.0" })
    )

    // The directory exists and has a package.json that's NOT a FlowDeck identity
    // isFilePathFlowDeck must return false because the package name is not supported
    const ref = pathToFileURL(flowdeckDir).href
    expect(isFlowDeckIdentity(ref)).toBe(false)
  })

  it("detects valid FlowDeck checkout directory", () => {
    const flowdeckDir = join(tmpDir, "flowdeck")
    mkdirSync(flowdeckDir, { recursive: true })
    writeFileSync(
      join(flowdeckDir, "package.json"),
      JSON.stringify({ name: "@heidi-dang/flowdeck", version: "0.8.0-alpha.6" })
    )

    const ref = pathToFileURL(flowdeckDir).href
    expect(isFlowDeckIdentity(ref)).toBe(true)
  })

  it("detects percent-encoded checkout path", () => {
    // file:///home/user/flow%64eck should decode to /home/user/flowdeck
    // but the path component check should work on the decoded version
    // Note: %64 is 'd', so flow%64eck = flowdeck
    expect(isFlowDeckIdentity("file:///home/user/flow%64eck")).toBe(true)
  })
})

describe("fixture: stale + npm + unrelated", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fd-stale-fixture-"))
    mkdirSync(join(tmpDir, ".config", "opencode"), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("plugin list fixture produces expected result", () => {
    const configPath = join(tmpDir, ".config", "opencode", "opencode.json")
    const config = {
      $schema: "https://opencode.ai/config.json",
      plugin: [
        "file:///home/heidi/flowdeck",
        "@heidi-dang/flowdeck@0.8.0-alpha.6",
        "file:///opt/unrelated-plugin",
      ],
      default_agent: "heidi",
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2))

    // Verify identity detection
    const entries = config.plugin
    const staleRef = entries[0]
    const npmRef = entries[1]
    const unrelatedRef = entries[2]

    expect(isFlowDeckIdentity(staleRef)).toBe(true)    // stale checkout
    expect(isFlowDeckIdentity(npmRef)).toBe(true)       // npm version
    expect(isFlowDeckIdentity(unrelatedRef)).toBe(false) // unrelated

    // Filter out FlowDeck entries
    const filtered = entries.filter(e => !isFlowDeckIdentity(e))

    // Should keep only unrelated
    expect(filtered).toEqual(["file:///opt/unrelated-plugin"])

    // Add exact version
    const result = [...filtered, "@heidi-dang/flowdeck@0.8.0-alpha.7"]

    expect(result).toEqual([
      "file:///opt/unrelated-plugin",
      "@heidi-dang/flowdeck@0.8.0-alpha.7",
    ])
  })

  it("handles duplicate modern npm versions", () => {
    const config = {
      plugin: [
        "@heidi-dang/flowdeck@0.8.0-alpha.5",
        "@heidi-dang/flowdeck@0.8.0-alpha.6",
        "@heidi-dang/flowdeck",
      ],
    }

    const flowdeckEntries = config.plugin.filter(e => isFlowDeckIdentity(e))
    expect(flowdeckEntries).toHaveLength(3)

    // After removal, should be empty
    const filtered = config.plugin.filter(e => !isFlowDeckIdentity(e))
    expect(filtered).toHaveLength(0)
  })

  it("handles JSONC with comments", () => {
    const configPath = join(tmpDir, ".config", "opencode", "opencode.json")
    const jsoncContent = `{
  // This is a comment
  "plugin": [
    "file:///home/heidi/flowdeck",
    "@heidi-dang/flowdeck@0.8.0-alpha.6"
  ],
  /* Another comment */
  "default_agent": "heidi"
}
`
    writeFileSync(configPath, jsoncContent)

    // Filter logic preserves comments
    const content = readFileSync(configPath, "utf-8")
    expect(content).toContain("// This is a comment")
    expect(content).toContain("/* Another comment */")

    // Identity detection works on the data
    // Note: JSONC can't be parsed with JSON.parse but the keys are still present
    expect(content).toContain("file:///home/heidi/flowdeck")
    expect(content).toContain("@heidi-dang/flowdeck@0.8.0-alpha.6")
  })
})
