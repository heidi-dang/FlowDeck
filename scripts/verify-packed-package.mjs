#!/usr/bin/env node
// scripts/verify-packed-package.mjs
//
// Verifies that the npm pack tarball exports correctly in both ESM and CJS.
// Run after `npm pack` to validate before publishing.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, mkdtempSync, rmSync, copyFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const ROOT = resolve(import.meta.dirname, "..")
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
  console.log(`\nVerifying packed package: ${pkg.name}@${pkg.version}\n`)

  // 1. Create the tarball
  console.log("1. Creating tarball...")
  const packOutput = execFileSync("npm", ["pack", "--json"], { cwd: ROOT, encoding: "utf-8" })
  const packResult = JSON.parse(packOutput)
  const tarball = join(ROOT, packResult[0].filename)
  assert(existsSync(tarball), `Tarball created: ${packResult[0].filename}`)

  // 2. Install in isolated directory
  console.log("\n2. Installing in isolated directory...")
  tmpDir = mkdtempSync(join(tmpdir(), "flowdeck-verify-packed-"))
  execFileSync("npm", ["init", "-y"], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  execFileSync("npm", ["install", tarball], { cwd: tmpDir, encoding: "utf-8", stdio: "pipe" })
  const installedPkgPath = join(tmpDir, "node_modules", "@heidi-dang", "flowdeck")

  // 3. Verify ESM import
  console.log("\n3. Testing ESM import...")
  try {
    const esmScript = `
      import mod from "@heidi-dang/flowdeck";
      console.log(JSON.stringify({ id: mod.id, serverType: typeof mod.server, keys: Object.keys(mod) }));
    `
    const result = execFileSync("node", ["--input-type=module", "-e", esmScript], {
      cwd: tmpDir, encoding: "utf-8"
    })
    const parsed = JSON.parse(result.trim())
    assert(parsed.id === "@heidi-dang/flowdeck", `ESM id = ${parsed.id}`)
    assert(parsed.serverType === "function", `ESM server type = ${parsed.serverType}`)
  } catch (e) {
    assert(false, `ESM import failed: ${e.message}`)
  }

  // 4. Verify CJS require
  console.log("\n4. Testing CJS require...")
  try {
    const cjsScript = `
      const mod = require("@heidi-dang/flowdeck");
      console.log(JSON.stringify({ id: mod.id, serverType: typeof mod.server, defaultId: mod.default?.id }));
    `
    const result = execFileSync("node", ["-e", cjsScript], {
      cwd: tmpDir, encoding: "utf-8"
    })
    const parsed = JSON.parse(result.trim())
    assert(parsed.id === "@heidi-dang/flowdeck", `CJS id = ${parsed.id}`)
    assert(parsed.serverType === "function", `CJS server type = ${parsed.serverType}`)
    assert(parsed.defaultId === "@heidi-dang/flowdeck", `CJS default.id = ${parsed.defaultId}`)
  } catch (e) {
    assert(false, `CJS require failed: ${e.message}`)
  }

  // 5. Verify named exports
  console.log("\n5. Testing named exports...")
  try {
    const namedScript = `
      import { AGENT_NAMES, createAgent, validateDelegationDepth } from "@heidi-dang/flowdeck";
      console.log(JSON.stringify({
        agentCount: AGENT_NAMES.length,
        hasHeidi: AGENT_NAMES.includes("heidi"),
        hasCreateAgent: typeof createAgent === "function",
        hasValidate: typeof validateDelegationDepth === "function"
      }));
    `
    const result = execFileSync("node", ["--input-type=module", "-e", namedScript], {
      cwd: tmpDir, encoding: "utf-8"
    })
    const parsed = JSON.parse(result.trim())
    assert(parsed.agentCount >= 10, `Agent count = ${parsed.agentCount}`)
    assert(parsed.hasHeidi === true, "Heidi in AGENT_NAMES")
    assert(parsed.hasCreateAgent === true, "createAgent is function")
    assert(parsed.hasValidate === true, "validateDelegationDepth is function")
  } catch (e) {
    assert(false, `Named exports test failed: ${e.message}`)
  }

  // Cleanup
  console.log("\n6. Cleaning up...")
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  try { rmSync(tarball, { force: true }) } catch {}

  console.log(`\n${exitCode === 0 ? "ALL PASSED" : "SOME FAILED"}`)
  process.exit(exitCode)
}

main().catch(e => {
  console.error(e)
  if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
