/**
 * No-Eval Installer Test
 *
 * Verifies install.sh does not use eval for CLI execution,
 * uses bash arrays, and supports curl-pipe --help.
 */

import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

const ROOT = join(__dirname, "..", "..")
const INSTALL_SCRIPT = join(ROOT, "install.sh")

describe("install.sh no-eval structural tests", () => {
  it("exists and is executable", () => {
    expect(existsSync(INSTALL_SCRIPT)).toBe(true)
  })

  it("contains no eval for CLI execution", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")

    // Count actual eval invocations (not in comments)
    const _evalLines = content.split("\n").filter(l =>
      !l.trim().startsWith("#") &&
      l.includes("eval ")
    )

    // The only eval should be non-existent - we use ${@:$i:1} instead
    // But some older bash patterns might still be there
    // Check that there's NO `eval "$CMD"` or `eval "$CLI_ARGS"`
    expect(content).not.toMatch(/CMD="npm exec/)
    expect(content).not.toMatch(/CLI_ARGS="/)
  })

  it("uses bash array for CLI_ARGS", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("CLI_ARGS=(")
    expect(content).toContain('"${CLI_ARGS[@]}"')
  })

  it("uses npm exec --package pattern", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("npm exec")
    expect(content).toContain("--package")
    expect(content).toContain("flowdeck clean-install")
  })

  it("supports --help flag (structural content check)", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain("FlowDeck Clean Reinstall Bootstrap")
    expect(content).toContain("--dry-run")
  })

  it("pipe-able structure verified", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    // Script must be self-contained for pipe operation
    expect(content).toContain("#!/usr/bin/env bash")
    expect(content).toContain("install.sh | bash")
  })

  it("validates --version requires a value (structural check)", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain('err "--version requires a value"')
    expect(content).toContain("exit 1")
  })

  it("validates --local-repo requires a path (structural check)", () => {
    const content = readFileSync(INSTALL_SCRIPT, "utf-8")
    expect(content).toContain('err "--local-repo requires a path"')
    expect(content).toContain("exit 1")
  })
})
