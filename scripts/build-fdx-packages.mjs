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

/** Safely run a command and return trimmed stdout, or null on failure. */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch {
    return null
  }
}

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

  // Calculate SHA-256 and byte size
  const buf = readFileSync(destBin)
  const sha256 = createHash("sha256").update(buf).digest("hex")

  const checksumManifest = {
    packageName: `@heidi-dang/${targetDirName}`,
    version: "1.0.4",
    executable: execName,
    sha256,
    builtAt: new Date().toISOString(),
  }
  writeFileSync(join(destDir, "checksum.json"), JSON.stringify(checksumManifest, null, 2), "utf-8")

  const provenanceManifest = {
    packageName: `@heidi-dang/${targetDirName}`,
    packageVersion: "1.0.4",
    flowdeckVersion: "1.0.4",
    fdxBinaryVersion: "1.0.4",
    fdxProtocolVersion: "1.0.0",
    targetTriple: process.platform === "win32" ? "x86_64-pc-windows-msvc" : `${process.arch}-unknown-${process.platform}-gnu`,
    platform: process.platform,
    architecture: process.arch,
    binaryFilename: execName,
    binaryByteSize: buf.length,
    sha256,
    buildProfile: "release",
    buildTimestamp: new Date().toISOString(),
    gitCommit: tryExec("git", ["rev-parse", "HEAD"]) || "0000000000000000000000000000000000000000",
    sourceCommitSha: tryExec("git", ["rev-parse", "HEAD"]) || "0000000000000000000000000000000000000000",
    gitBranch: tryExec("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    ciRunId: process.env.GITHUB_RUN_ID ?? null,
    ciRunUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    builderPlatform: `${process.platform}/${process.arch}`,
    rustVersion: tryExec("rustc", ["--version"]),
  }
  writeFileSync(join(destDir, "provenance.json"), JSON.stringify(provenanceManifest, null, 2), "utf-8")

  // Copy License & README
  if (existsSync(join(PKG_ROOT, "LICENSE"))) {
    copyFileSync(join(PKG_ROOT, "LICENSE"), join(destDir, "LICENSE"))
  }
  if (!existsSync(join(destDir, "README.md"))) {
    writeFileSync(join(destDir, "README.md"), `# @heidi-dang/${targetDirName}\n\nPrebuilt native FDX executable binary for FlowDeck.\n`, "utf-8")
  }

  // Pack target package into .tgz artifact
  let tgzName = null
  try {
    tgzName = execFileSync("npm", ["pack"], { cwd: destDir, encoding: "utf-8" }).trim().split("\n").pop()
  } catch {}

  console.log(`[build-fdx-packages] Successfully populated ${destDir}`)
  console.log(`  Binary:     ${destBin}`)
  console.log(`  SHA-256:    ${sha256}`)
  console.log(`  Size:       ${buf.length} bytes`)
  if (tgzName) console.log(`  Tarball:    ${join(destDir, tgzName)}`)
}

main()
