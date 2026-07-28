#!/usr/bin/env node
/**
 * scripts/build-entry.mjs — Repository-rooted build entrypoint
 *
 * Resolves the repository root from its own location, never from the
 * caller's current working directory. Detects Windows UNC paths like
 * \\wsl.localhost\... and delegates to native WSL when necessary.
 *
 * Usage:
 *   node scripts/build-entry.mjs
 */

import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

const ENTRY_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(ENTRY_DIR, "..")

/**
 * Detect whether `path` is a Windows WSL UNC path.
 * Recognises \\wsl.localhost\... and \\wsl$\...
 */
function isWslUncPath(path) {
  if (typeof path !== "string") return false
  const normalized = path.replace(/\//g, "\\")
  return (
    normalized.startsWith("\\\\wsl.localhost\\") ||
    normalized.startsWith("\\\\wsl$\\")
  )
}

/**
 * Parse a WSL UNC path into { distro, linuxPath }.
 * Example: \\wsl.localhost\Ubuntu\home\user\project
 *          → { distro: "Ubuntu", linuxPath: "/home/user/project" }
 * Returns null if parsing fails.
 */
function parseWslUncPath(path) {
  if (!isWslUncPath(path)) return null
  const normalized = path.replace(/\//g, "\\")
  // Strip leading \\
  const withoutPrefix = normalized.replace(/^\\\\wsl\.localhost\\|^\\\\wsl\$\\/, "")
  const separatorIndex = withoutPrefix.indexOf("\\")
  if (separatorIndex <= 0) return null
  const distro = withoutPrefix.slice(0, separatorIndex)
  const windowsPath = withoutPrefix.slice(separatorIndex + 1)
  // Convert to Linux path
  const linuxPath = "/" + windowsPath.replace(/\\/g, "/")
  return { distro, linuxPath }
}

function runBuild(directory) {
  const result = spawnSync(process.execPath, [
    resolve(ENTRY_DIR, "build.mjs"),
  ], {
    cwd: directory,
    encoding: "utf-8",
    stdio: ["inherit", "inherit", "inherit"],
    timeout: 120_000,
  })
  if (result.error) {
    console.error(`Build process error: ${result.error.message}`)
    process.exit(result.status === 127 ? 2 : result.status ?? 2)
  }
  process.exit(result.status ?? 0)
}

function main() {
  const repoRoot = REPO_ROOT

  // Prevent recursion when WSL delegation calls back into this script
  if (process.env.FLOWDECK_NATIVE_BUILD === "1") {
    console.error(
      "Error: FLOWDECK_NATIVE_BUILD=1 detected — build delegation cycle.\n" +
      "The WSL-native build was invoked while already inside a native WSL build.\n" +
      "Check that the WSL distribution does not mount the Windows repo path\n" +
      "and that FLOWDECK_NATIVE_BUILD is not set in the WSL environment.",
    )
    process.exit(2)
  }

  // Detect WSL UNC path and delegate to WSL
  if (isWslUncPath(repoRoot)) {
    const parsed = parseWslUncPath(repoRoot)
    if (!parsed) {
      console.error(
        `Error: Cannot parse WSL UNC path "${repoRoot}".\n` +
        `Expected format: \\\\wsl.localhost\\<distro>\\<path>\n` +
        `Remediation: Access this repository through WSL directly\n` +
        `  wsl --cd /path/to/repo\n` +
        `  cd /path/to/repo && node scripts/build-entry.mjs`,
      )
      process.exit(2)
    }

    const { distro, linuxPath } = parsed

    // Delegate to wsl.exe
    const wslArgs = [
      "--distribution", distro,
      "--cd", linuxPath,
      "bash", "-c",
      `FLOWDECK_NATIVE_BUILD=1 ${process.execPath} scripts/build.mjs`,
    ]

    const result = spawnSync("wsl.exe", wslArgs, {
      encoding: "utf-8",
      stdio: ["inherit", "inherit", "inherit"],
      timeout: 120_000,
    })

    if (result.error) {
      console.error(`WSL delegation failed: ${result.error.message}`)
      process.exit(2)
    }

    process.exit(result.status ?? 0)
  }

  // Normal path: run build directly
  runBuild(repoRoot)
}


export { isWslUncPath, parseWslUncPath }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
