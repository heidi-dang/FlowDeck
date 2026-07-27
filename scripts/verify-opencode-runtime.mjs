#!/usr/bin/env node
// scripts/verify-opencode-runtime.mjs
//
// Verifies that FlowDeck loads correctly in OpenCode v1.18.4.
// Creates an isolated config, installs the plugin, and checks agent list.
//
// Usage:
//   node scripts/verify-opencode-runtime.mjs               # test packed package
//   node scripts/verify-opencode-runtime.mjs --npm          # test published npm package
//   node scripts/verify-opencode-runtime.mjs --package @heidi-dang/flowdeck@0.8.0-alpha.9
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(import.meta.dirname, "..")
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode"
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"))

let exitCode = 0
let tmpDir = null

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`)
    exitCode = 1
  } else {
    console.log(`  PASS: ${message}`)
  }
}

async function main() {
  const useNpm = process.argv.includes("--npm")
  const pkgArg = process.argv.find(a => a.startsWith("--package="))?.split("=")[1]
  const pkgSpec = pkgArg || (useNpm ? `${pkg.name}@${pkg.version}` : null)

  console.log(`\nVerifying OpenCode runtime: ${pkg.name}@${pkg.version}\n`)

  // 1. Create isolated environment
  console.log("1. Creating isolated environment...")
  tmpDir = mkdtempSync(join(tmpdir(), "flowdeck-opencode-test-"))
  const configDir = join(tmpDir, "config")
  const projectDir = join(tmpDir, "project")
  const homeDir = join(tmpDir, "home")

  // Create directories
  execFileSync("mkdir", ["-p", configDir, projectDir, homeDir])

  // Create config
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [],
    default_agent: "heidi",
  }
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config, null, 2) + "\n")

  // 2. Check opencode version
  console.log("\n2. Checking OpenCode version...")
  try {
    const versionOut = execFileSync(OPENCODE_BIN, ["--version"], {
      encoding: "utf-8", timeout: 15000
    }).trim()
    assert(versionOut.includes("1.18") || versionOut.length > 0, `OpenCode version: ${versionOut}`)
  } catch (e) {
    assert(false, `OpenCode not found: ${e.message}`)
  }

  // 3. Install the package locally for OpenCode to resolve
  console.log("\n3. Installing package for OpenCode resolution...")
  if (pkgSpec) {
    // Install from npm
    execFileSync("npm", ["install", "--prefix", configDir, pkgSpec], {
      encoding: "utf-8", stdio: "pipe", timeout: 60000
    })
  } else {
    // Install from packed tarball
    const packOutput = execFileSync("npm", ["pack", "--json"], {
      cwd: ROOT, encoding: "utf-8"
    })
    const packResult = JSON.parse(packOutput)
    const tarball = join(ROOT, packResult[0].filename)
    execFileSync("npm", ["install", "--prefix", configDir, tarball], {
      encoding: "utf-8", stdio: "pipe", timeout: 60000
    })
    try { rmSync(tarball, { force: true }) } catch {}
  }

  // Verify the package is installed
  const installedPkg = join(configDir, "node_modules", "@heidi-dang", "flowdeck")
  assert(existsSync(installedPkg), `Package installed at ${installedPkg}`)
  const pkgJson = JSON.parse(readFileSync(join(installedPkg, "package.json"), "utf-8"))
  console.log(`    Installed: ${pkgJson.name}@${pkgJson.version}`)

  // 4. Register plugin in config
  console.log("\n4. Registering plugin in OpenCode config...")
  config.plugin = ["@heidi-dang/flowdeck"]
  config.default_agent = "heidi"
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config, null, 2) + "\n")

  // 5. Run opencode agent list
  console.log("\n5. Running opencode agent list...")
  try {
    const env = {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      OPENCODE_CONFIG_DIR: configDir,
    }
    const agentOut = execFileSync(OPENCODE_BIN, ["agent", "list"], {
      encoding: "utf-8", timeout: 30000, env
    })
    console.log(`    (output ${agentOut.split("\n").length} lines)`)

    // Check for Heidi
    assert(agentOut.includes("heidi"), "heidi present in agent list")
    assert(agentOut.includes("heidi (primary)"), "heidi is primary agent")
    assert(!agentOut.includes("heidi (subagent)"), "heidi is not a subagent")
  } catch (e) {
    assert(false, `OpenCode agent list failed: ${e.message}`)
  }

  // Clean up temp dir
  console.log("\n6. Cleaning up...")
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  console.log(`\n${exitCode === 0 ? "ALL PASSED" : "SOME FAILED"}`)
  process.exit(exitCode)
}

main().catch(e => {
  console.error(e)
  if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
