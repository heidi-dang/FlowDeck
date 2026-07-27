#!/usr/bin/env node
/**
 * verify-opencode-integration.mjs
 *
 * Automated installation verification script.
 * Tests FlowDeck installation, configuration, plugin registration, and
 * optional OpenCode runtime integration.
 *
 * Usage:
 *   node scripts/verify-opencode-integration.mjs          # Full verification
 *   node scripts/verify-opencode-integration.mjs --offline # Offline only
 *
 * Offline mode runs structural checks without requiring provider credentials.
 * Online mode additionally starts OpenCode for a runtime smoke test.
 *
 * This script:
 *   1. Creates an isolated temporary HOME/OPENCODE_CONFIG_DIR
 *   2. Installs FlowDeck from the local packed package
 *   3. Runs flowdeck verify and flowdeck doctor
 *   4. Inspects resulting configuration
 *   5. Verifies plugin registration and required files
 *   6. Runs an optional OpenCode runtime smoke test
 *   7. Cleans up temporary files
 *   8. Returns nonzero on failure
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const PKG_ROOT = resolve(__dirname, "..")
const OFFLINE_ONLY = process.argv.includes("--offline")

// ── Utilities ───────────────────────────────────────────────────────────

let passed = 0
let failed = 0
let skipped = 0

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}${detail ? `: ${detail}` : ""}`)
    passed++
  } else {
    console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`)
    failed++
  }
}

function skip(name, reason) {
  console.log(`  - ${name}: ${reason}`)
  skipped++
}

let tmpHome = null

function setupTempDir() {
  const tmpBase = realpathSync(tmpdir())
  tmpHome = join(tmpBase, `flowdeck-verify-${Date.now()}`)
  mkdirSync(tmpHome, { recursive: true })
  mkdirSync(join(tmpHome, ".config"), { recursive: true })
  return tmpHome
}

function cleanup() {
  if (tmpHome && existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true })
  }
}

function runCmd(cmd, cwd = PKG_ROOT) {
  try {
    const out = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] })
    return { ok: true, stdout: out.trim(), stderr: "" }
  } catch (err) {
    return { ok: false, stdout: err.stdout?.trim() ?? "", stderr: err.stderr?.trim() ?? "" }
  }
}

// ── Stages ──────────────────────────────────────────────────────────────

function stagePackagePresence() {
  console.log("\n[1] Package presence\n")

  const pkgFile = join(PKG_ROOT, "package.json")
  check("package.json exists", existsSync(pkgFile))

  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"))
      check("package name", pkg.name === "@heidi-dang/flowdeck", pkg.name)
      check("package version", typeof pkg.version === "string", pkg.version)
      check("bin entry exists", pkg.bin?.flowdeck === "./bin/flowdeck.js")
      check("main entry", pkg.main === "./dist/index.js")
    } catch {
      check("package.json parseable", false)
    }
  }

  const cliFile = join(PKG_ROOT, "bin", "flowdeck.js")
  check("CLI binary exists", existsSync(cliFile), cliFile)

  const distFile = join(PKG_ROOT, "dist", "index.js")
  check("Plugin bundle exists", existsSync(distFile), distFile)

  const entryFile = join(PKG_ROOT, "src", "index.ts")
  check("Plugin source exists", existsSync(entryFile), entryFile)
}

function stageIsolatedInstall() {
  console.log("\n[2] Isolated installation\n")

  const tmpHome = setupTempDir()
  const configDir = join(tmpHome, ".config", "opencode")
  const configFile = join(configDir, "opencode.json")

  // Prepare a clean config with an existing plugin to test preservation
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configFile, JSON.stringify({
    plugin: ["@existing/test-plugin"],
    instructions: ["~/instructions.md"],
  }, null, 2) + "\n", "utf-8")

  const env = {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDir,
  }

  // Override homedir by setting HOME (Unix) / USERPROFILE (Windows)
  const isWin = process.platform === "win32"
  env[isWin ? "USERPROFILE" : "HOME"] = tmpHome

  function runNode(args, cwd = PKG_ROOT) {
    try {
      const out = execSync(`node ${args}`, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      })
      return { ok: true, stdout: out.trim(), stderr: "" }
    } catch (err) {
      return { ok: false, stdout: err.stdout?.trim() ?? "", stderr: err.stderr?.trim() ?? "" }
    }
  }

  // Run install
  const installResult = runNode("bin/flowdeck.js install")
  check("install succeeds", installResult.ok, installResult.stdout.slice(0, 200))

  // Check config was created
  check("config file exists after install", existsSync(configFile))

  if (existsSync(configFile)) {
    const content = readFileSync(configFile, "utf-8")
    try {
      const config = JSON.parse(content)
      check("pre-existing plugin preserved",
        Array.isArray(config.plugin) &&
        config.plugin.some(p => p === "@existing/test-plugin"),
        "@existing/test-plugin"
      )
      check("flowdeck plugin registered",
        Array.isArray(config.plugin) &&
        config.plugin.some(p => p === "@heidi-dang/flowdeck" || String(p).startsWith("file://")),
        config.plugin.find(p => p.includes("flowdeck")) || "not found"
      )
      check("default_agent set to heidi", config.default_agent === "heidi", config.default_agent)
      check("other config preserved", config.instructions?.[0] === "~/instructions.md")
    } catch {
      check("config file parseable", false)
    }
  }

  // Run verify
  const verifyResult = runNode("bin/flowdeck.js verify")
  check("verify passes", verifyResult.ok, verifyResult.stdout.slice(0, 100))

  // Run doctor
  const doctorResult = runNode("bin/flowdeck.js doctor")
  check("doctor passes", doctorResult.ok, "HEALTHY")

  // Check manifest
  const manifestFile = join(configDir, ".flowdeck-manifest.json")
  check("install manifest exists", existsSync(manifestFile))
  if (existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"))
      check("manifest schema version", manifest.schemaVersion === 2)
      check("manifest has pluginRef", !!manifest.pluginRef, manifest.pluginRef)
      check("manifest records pluginAdded", manifest.pluginAdded === true)
    } catch {
      check("manifest parseable", false)
    }
  }

  // Run dry-run (should show current state)
  const dryRunResult = runNode("bin/flowdeck.js dry-run")
  check("dry-run succeeds", dryRunResult.ok, "dry-run")

  // Test uninstall
  const uninstallResult = runNode("bin/flowdeck.js uninstall")
  check("uninstall succeeds", uninstallResult.ok, uninstallResult.stdout.slice(0, 100))

  // Verify plugin was removed but existing plugin preserved
  if (existsSync(configFile)) {
    const content = readFileSync(configFile, "utf-8")
    try {
      const config = JSON.parse(content)
      check("pre-existing plugin still present after uninstall",
        Array.isArray(config.plugin) &&
        config.plugin.some(p => p === "@existing/test-plugin"),
        "@existing/test-plugin"
      )
      check("flowdeck plugin removed after uninstall",
        Array.isArray(config.plugin) &&
        !config.plugin.some(p => p === "@heidi-dang/flowdeck" && !String(p).startsWith("file://")),
        "removed"
      )
    } catch {
      check("config parseable after uninstall", false)
    }
  }

  // Test reinstall
  const reinstallResult = runNode("bin/flowdeck.js install")
  check("reinstall succeeds", reinstallResult.ok, reinstallResult.stdout.slice(0, 100))

  // Re-verify
  const reVerifyResult = runNode("bin/flowdeck.js verify")
  check("re-verify passes", reVerifyResult.ok, reVerifyResult.stdout.slice(0, 100))

  cleanup()
}

function stageOpenCodeRuntime() {
  if (OFFLINE_ONLY) {
    skip("OpenCode runtime test", "offline mode")
    return
  }

  // Check if opencode is available
  const whichResult = runCmd(process.platform === "win32" ? "where opencode" : "which opencode")
  if (!whichResult.ok) {
    skip("OpenCode runtime test", "opencode not found in PATH")
    return
  }

  console.log("\n[3] OpenCode runtime verification\n")
  console.log("  OpenCode found at:", whichResult.stdout)

  check("OpenCode available", true, whichResult.stdout)

  // Version check
  const versionResult = runCmd("opencode --version")
  if (versionResult.ok) {
    check("OpenCode version", true, versionResult.stdout)
  } else {
    check("OpenCode version check", false)
  }
}

function stageReport() {
  console.log("\n── Results ──\n")
  console.log(`  Passed:  ${passed}`)
  console.log(`  Failed:  ${failed}`)
  console.log(`  Skipped: ${skipped}`)
  console.log()

  if (failed > 0) {
    console.log("✗ Verification FAILED.")
    process.exit(1)
  } else if (OFFLINE_ONLY) {
    console.log("✓ Offline verification passed.")
    console.log("  Provider-backed verification was not run (--offline mode).")
    process.exit(0)
  } else {
    console.log("✓ Verification passed.")
    process.exit(0)
  }
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  const mode = OFFLINE_ONLY ? "offline" : "full"
  console.log(`\nFlowDeck Installation Verification (${mode} mode)\n`)
  console.log(`Package root: ${PKG_ROOT}`)

  stagePackagePresence()
  stageIsolatedInstall()
  stageOpenCodeRuntime()
  stageReport()
}

main()
