#!/usr/bin/env node
/**
 * scripts/build.mjs — Internal build script
 *
 * Invoked by build-entry.mjs. Uses absolute paths resolved from REPO_ROOT,
 * so it works regardless of the caller's current working directory.
 * Uses argument-array execution via shell only on WSL.
 */

import { spawnSync } from "node:child_process"
import { existsSync, rmSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(ENTRY_DIR, "..")

const ON_WSL = process.platform !== "win32" && (() => {
  try { return readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft") }
  catch { return false }
})()

function cmdStr(program, args) {
  return [program, ...args].map(a => /[\s"]/.test(a) ? `"${a}"` : a).join(" ")
}

function run(program, args, { label = "" } = {}) {
  const useShell = ON_WSL
  const result = spawnSync(
    useShell ? "/bin/sh" : program,
    useShell ? ["-c", cmdStr(program, args)] : args,
    {
      cwd: REPO_ROOT,
      stdio: ["inherit", "inherit", "inherit"],
      timeout: 120_000,
      windowsHide: true,
    },
  )
  if (result.error) {
    console.error(`\n[build] ${label || program}: process error — ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`\n[build] ${label || program}: failed with exit code ${result.status}`)
    process.exit(result.status)
  }
}

function main() {
  const distDir = resolve(REPO_ROOT, "dist")
  const srcEntry = resolve(REPO_ROOT, "src/index.ts")
  const bhEntry = resolve(REPO_ROOT, "src/better-harness/index.ts")
  const distPlugin = resolve(REPO_ROOT, "dist")
  const distHarness = resolve(REPO_ROOT, "dist/better-harness")
  const tsconfig = resolve(REPO_ROOT, "tsconfig.build.json")
  const tscPath = resolve(REPO_ROOT, "node_modules", ".bin", "tsc")
  const tscCmd = existsSync(tscPath) ? tscPath : "npx tsc"

  console.log(`[build] Platform: ${ON_WSL ? "WSL" : process.platform}`)

  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true })

  // Step 1: Plugin bundle
  run("bun", [
    "build", srcEntry,
    "--outdir", distPlugin,
    "--target", "node",
    "--format", "esm",
    "--external", "@opencode-ai/plugin",
    "--external", "@opencode-ai/sdk",
    "--external", "jsonc-parser",
  ], { label: "bundle:plugin" })
  console.log("[build] Plugin bundle: OK")

  // Step 2: TypeScript declarations
  run(tscCmd, ["--emitDeclarationOnly", "--project", tsconfig], { label: "tsc:declarations" })
  console.log("[build] TypeScript declarations: OK")

  // Step 3: Better Harness bundle
  run("bun", [
    "build", bhEntry,
    "--outdir", distHarness,
    "--target", "node",
    "--format", "esm",
  ], { label: "bundle:harness" })
  console.log("[build] Better Harness bundle: OK")

  console.log("[build] Build complete.")
}

main()
