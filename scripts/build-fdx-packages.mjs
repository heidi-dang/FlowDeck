#!/usr/bin/env node
/**
 * Helper script to build local FDX native binary, compute SHA-256,
 * and populate package distribution directory.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, "..")

function detectTargetName() {
  const platform = process.platform
  const arch = process.arch
  if (platform === "linux" && arch === "x64") return "flowdeck-fdx-linux-x64-gnu"
  if (platform === "linux" && arch === "arm64") return "flowdeck-fdx-linux-arm64-gnu"
  if (platform === "darwin" && arch === "x64") return "flowdeck-fdx-darwin-x64"
  if (platform === "darwin" && arch === "arm64") return "flowdeck-fdx-darwin-arm64"
  if (platform === "win32" && arch === "x64") return "flowdeck-fdx-win32-x64"
  return null
}

function main() {
  const targetDirName = detectTargetName()
  if (!targetDirName) {
    console.log(`[build-fdx-packages] Target platform ${process.platform}/${process.arch} not configured for automatic packaging.`)
    return
  }

  const execName = process.platform === "win32" ? "fdx.exe" : "fdx"
  const cargoTargetBin = join(PKG_ROOT, "target", "release", execName)
  const destDir = join(PKG_ROOT, "packages", targetDirName)

  console.log(`[build-fdx-packages] Target package directory: ${destDir}`)

  if (!existsSync(cargoTargetBin)) {
    console.log(`[build-fdx-packages] Compiling Rust FDX crate...`)
    try {
      execFileSync("cargo", ["build", "--manifest-path", join(PKG_ROOT, "crates", "fdx", "Cargo.toml"), "--release"], {
        cwd: PKG_ROOT,
        stdio: "inherit",
      })
    } catch {
      console.log(`[build-fdx-packages] Rust compilation skipped or cargo unavailable.`)
      return
    }
  }

  if (!existsSync(cargoTargetBin)) {
    console.log(`[build-fdx-packages] Compiled binary not found at ${cargoTargetBin}`)
    return
  }

  mkdirSync(destDir, { recursive: true })
  const destBin = join(destDir, execName)
  copyFileSync(cargoTargetBin, destBin)

  // Calculate SHA-256
  const buf = readFileSync(destBin)
  const sha256 = createHash("sha256").update(buf).digest("hex")

  const manifest = {
    packageName: `@heidi-dang/${targetDirName}`,
    executable: execName,
    sha256,
    builtAt: new Date().toISOString(),
  }

  writeFileSync(join(destDir, "checksum.json"), JSON.stringify(manifest, null, 2), "utf-8")

  // Copy License
  if (existsSync(join(PKG_ROOT, "LICENSE"))) {
    copyFileSync(join(PKG_ROOT, "LICENSE"), join(destDir, "LICENSE"))
  }

  console.log(`[build-fdx-packages] Successfully populated ${destDir}`)
  console.log(`  Binary:   ${destBin}`)
  console.log(`  SHA-256:  ${sha256}`)
}

main()
