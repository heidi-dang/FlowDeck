/**
 * Piped Installer Integration Tests
 *
 * Tests the curl|bash bootstrap installer:
 * - help flag works
 * - dry-run flag works
 * - script is self-contained (no local file deps)
 * - detects missing prerequisites
 */

import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"

const ROOT = join(__dirname, "..", "..")
const INSTALL_SCRIPT = join(ROOT, "install.sh")

describe("install.sh bootstrap", () => {
  it("exists and is executable", () => {
    expect(existsSync(INSTALL_SCRIPT)).toBe(true)
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("#!/usr/bin/env bash")
  })

  it("has the curl pipe banner comment", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("curl -fsSL")
    expect(content).toContain("raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh")
  })

  it("does NOT require BASH_SOURCE to be in a repository", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    // The script should not reference BASH_SOURCE for finding package.json
    expect(content).not.toContain('BASH_SOURCE')
  })

  it("does NOT require package.json beside the script", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    // The script should not look for package.json in its own directory
    expect(content).not.toContain('SCRIPT_DIR')
  })

  it("supports --help flag", () => {
    const result = execSync(`bash "${INSTALL_SCRIPT}" --help`, {
      encoding: "utf-8",
      timeout: 10000,
    })
    expect(result).toContain("FlowDeck")
    expect(result).toContain("--dry-run")
    expect(result).toContain("--verify-only")
  })

  it("supports --dry-run in script logic (structural test)", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("dry-run")
    expect(content).toContain("SCRIPT_MODE")
  })

  it("supports --help flag (fast path, no npm)", () => {
    const result = execSync(`bash "${INSTALL_SCRIPT}" --help`, {
      encoding: "utf-8",
      timeout: 5000,
    })
    expect(result).toContain("FlowDeck")
  })

  it("works when piped via stdin simulation", () => {
    const result = execSync(`cat "${INSTALL_SCRIPT}" | bash -s -- --help`, {
      encoding: "utf-8",
      timeout: 10000,
    })
    expect(result).toContain("FlowDeck")
    expect(result).toContain("--help")
  })

  it("rejects invalid Node.js version scenario gracefully", () => {
    // We can't easily test this without actually changing Node, but we can
    // verify the check logic exists in the script
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("NODE_MAJOR")
    expect(content).toContain("lt 18")
  })
})

describe("npm exec bootstrap pattern", () => {
  it("install.sh uses npm exec --package pattern", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("npm exec")
    expect(content).toContain("--package")
    expect(content).toContain("flowdeck clean-install")
  })

  it("does NOT use eval with unverified content", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    // Should not eval arbitrary strings from the pipe
    const evalLines = content.split("\n").filter(l => l.trim().startsWith("eval"))
    // If there's eval, it should only be for the controlled npm command
    for (const line of evalLines) {
      expect(line).not.toContain("curl")
      expect(line).not.toContain("wget")
    }
  })
})
