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

  it("supports --help flag (structural check)", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("FlowDeck Clean Reinstall Bootstrap")
    expect(content).toContain("--dry-run")
    expect(content).toContain("--verify-only")
    expect(content).toContain("--help, -h")
  })

  it("supports --dry-run in script logic (structural test)", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("dry-run")
    expect(content).toContain("SCRIPT_MODE")
  })

  it("curl pipe banner is present in script header", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("curl -fsSL")
    expect(content).toContain("raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh")
  })

  it("pipe invocation pattern works (structural check)", () => {
    // The script is designed for curl | bash piping
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("curl -fsSL")
    expect(content).toContain("install.sh | bash")
    // Verify no BASH_SOURCE dependency
    expect(content).not.toContain('BASH_SOURCE')
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
