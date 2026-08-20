#!/usr/bin/env node
/**
 * scripts/verify-packed-smoke.mjs — Durable Package Tarball Verification
 *
 * 1. Creates an isolated temporary directory.
 * 2. Packages @heidi-dang/flowdeck via npm pack into the temp directory.
 * 3. Inspects tarball contents (verifies required dist, bin, docs, manifests).
 * 4. Installs the tarball into a clean, isolated project.
 * 5. Runs the installed CLI binary (--help).
 * 6. Verifies ESM import in the runtime without access to local source checkout.
 */

import { execFileSync, execSync } from "node:child_process"
import { mkdtempSync, rmSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const tempPackDir = mkdtempSync(join(tmpdir(), "flowdeck-pack-verify-"))
const tempInstallDir = mkdtempSync(join(tmpdir(), "flowdeck-install-verify-"))

try {
  const root = resolve(".")
  console.log("[Package Smoke] 1. Packaging tarball...")
  execFileSync("npm", ["pack", "--pack-destination", tempPackDir], { cwd: root, stdio: "pipe" })

  const files = readdirSync(tempPackDir).filter(f => f.endsWith(".tgz"))
  if (files.length === 0) throw new Error("No tarball produced by npm pack")
  const tarballPath = join(tempPackDir, files[0])
  console.log("[Package Smoke] 2. Inspecting tarball contents:", files[0])

  const tarList = execSync("tar -tf " + tarballPath, { encoding: "utf-8" })
  const requiredFiles = [
    "package/dist/index.js",
    "package/dist/better-harness/index.js",
    "package/dist/index.d.ts",
    "package/bin/flowdeck.js",
    "package/package.json",
  ]
  for (const req of requiredFiles) {
    if (!tarList.includes(req)) {
      throw new Error("Tarball missing required manifest file: " + req)
    }
  }

  console.log("[Package Smoke] 3. Installing tarball in isolated directory:", tempInstallDir)
  execSync("npm init -y", { cwd: tempInstallDir, stdio: "ignore" })
  execSync("npm install " + tarballPath, { cwd: tempInstallDir, stdio: "ignore" })

  console.log("[Package Smoke] 4. Verifying CLI binary execution...")
  const cliOutput = execSync("node ./node_modules/.bin/flowdeck --help", { cwd: tempInstallDir, encoding: "utf-8" })
  if (!cliOutput.includes("FlowDeck")) {
    throw new Error("CLI --help failed from installed package")
  }

  console.log("[Package Smoke] 5. Verifying ESM import in Bun...")
  const importScript = `
    const flowdeck = await import("@heidi-dang/flowdeck");
    if (!flowdeck.default?.id || flowdeck.default.id !== "@heidi-dang/flowdeck") {
      process.exit(1);
    }
  `
  execSync("bun -e '" + importScript.replace(/\n/g, " ") + "'", { cwd: tempInstallDir, stdio: "inherit" })

  console.log("[Package Smoke] ALL PACKAGED INTEGRITY CHECKS PASSED.")
} finally {
  try {
    rmSync(tempPackDir, { recursive: true, force: true })
    rmSync(tempInstallDir, { recursive: true, force: true })
  } catch {}
}
