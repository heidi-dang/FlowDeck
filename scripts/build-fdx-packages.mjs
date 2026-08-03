#!/usr/bin/env node
/**
 * Helper script to build local FDX native binary, compute SHA-256,
 * generate complete provenance, and populate package distribution directory.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { sourceCommitShaError } from "../src/tools/fdx-commit-sha.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(__dirname, "..")

function fail(message, cause) {
  console.error(`[build-fdx-packages] FAIL: ${message}`)
  if (cause instanceof Error) {
    console.error(cause.stack ?? cause.message)
  }
  process.exit(1)
}

/** Safely run a command and return trimmed stdout, or null on failure. */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch {
    return null
  }
}

function isMuslHost() {
  try {
    if (existsSync("/etc/alpine-release")) return true
    for (const loader of ["/lib/ld-musl-x86_64.so.1", "/lib/ld-musl-aarch64.so.1"]) {
      if (existsSync(loader)) return true
    }
    // Linux without a glibc version in the runtime report is musl-based.
    const report = process.report?.getReport?.()
    if (report && report.header && report.header.glibcVersionRuntime === undefined) return true
  } catch {}
  return false
}

/**
 * P2-4: strict-mode guard against fabricated provenance. Returns an error
 * message when any provenance input is fabricated (missing/zero source commit,
 * missing branch, missing rustc version), or null when all inputs are real.
 * Exported so the acceptance tests can exercise it without a full build.
 */
export function strictProvenanceInputError({ currentCommit, currentBranch, rustVersion }) {
  const commitError = sourceCommitShaError(currentCommit)
  if (commitError) {
    return `Strict build requires a real source commit SHA; ${commitError}. Set GITHUB_SHA or build inside a git checkout.`
  }
  if (!currentBranch) {
    return `Strict build requires a real source branch; none detected. Set GITHUB_REF_NAME or build inside a git checkout.`
  }
  // P2-4: a detached checkout reports the literal branch name "HEAD" via
  // `git rev-parse --abbrev-ref HEAD`. That is not a real source branch and
  // must never be recorded as one in provenance.
  if (currentBranch === "HEAD") {
    return `Strict build cannot record a detached HEAD as a source branch. Check out a real branch or provide a validated CI ref (GITHUB_REF_NAME).`
  }
  if (!rustVersion) {
    return `Strict build requires a real rustc version; 'rustc --version' failed.`
  }
  return null
}

function detectTargetName() {
  const platform = process.platform
  const arch = process.arch
  if (platform === "linux" && arch === "x64") return isMuslHost() ? "flowdeck-fdx-linux-x64-musl" : "flowdeck-fdx-linux-x64-gnu"
  if (platform === "linux" && arch === "arm64") return isMuslHost() ? "flowdeck-fdx-linux-arm64-musl" : "flowdeck-fdx-linux-arm64-gnu"
  if (platform === "darwin" && arch === "x64") return "flowdeck-fdx-darwin-x64"
  if (platform === "darwin" && arch === "arm64") return "flowdeck-fdx-darwin-arm64"
  if (platform === "win32" && arch === "x64") return "flowdeck-fdx-win32-x64"
  return null
}

/**
 * Canonical Rust target triples, matching the production CI build
 * (.github/workflows/build-fdx-binaries.yml). provenance.json must carry the
 * same triples the runtime's provenance contract enforces.
 */
const TARGET_TRIPLES = {
  "flowdeck-fdx-linux-x64-gnu": "x86_64-unknown-linux-gnu",
  "flowdeck-fdx-linux-arm64-gnu": "aarch64-unknown-linux-gnu",
  "flowdeck-fdx-linux-x64-musl": "x86_64-unknown-linux-musl",
  "flowdeck-fdx-linux-arm64-musl": "aarch64-unknown-linux-musl",
  "flowdeck-fdx-darwin-x64": "x86_64-apple-darwin",
  "flowdeck-fdx-darwin-arm64": "aarch64-apple-darwin",
  "flowdeck-fdx-win32-x64": "x86_64-pc-windows-msvc",
}

function main() {
  const isStrict = process.argv.includes("--strict") || process.env.CI === "true"
  const mainPkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"))
  const flowdeckVersion = mainPkg.version

  const targetDirName = detectTargetName()
  if (!targetDirName) {
    if (isStrict) {
      fail(`Target platform ${process.platform}/${process.arch} not supported for prebuilt native binaries.`)
    }
    console.log(`[build-fdx-packages] Target platform ${process.platform}/${process.arch} not configured for automatic packaging.`)
    return
  }

  // P2-4: the production distribution matrix ships six prebuilt targets; the
  // runtime trust contract (FDX_TARGET_TRIPLES / detectFdxTarget) has no
  // consumer for linux-arm64-musl. In strict mode, reject it explicitly
  // rather than emitting a package no runtime target can ever validate.
  if (targetDirName === "flowdeck-fdx-linux-arm64-musl") {
    if (isStrict) {
      fail(`Target flowdeck-fdx-linux-arm64-musl is not part of the production distribution matrix; cannot package in strict mode.`)
    }
    console.log(`[build-fdx-packages] Target flowdeck-fdx-linux-arm64-musl is not part of the production distribution matrix; skipping.`)
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
    } catch (e) {
      if (isStrict) fail("Rust compilation failed", e)
      console.log(`[build-fdx-packages] Rust compilation skipped or cargo unavailable.`)
      return
    }
  }

  if (!existsSync(cargoTargetBin)) {
    if (isStrict) fail(`Compiled binary not found at ${cargoTargetBin}`)
    console.log(`[build-fdx-packages] Compiled binary not found at ${cargoTargetBin}`)
    return
  }

  try {
    mkdirSync(destDir, { recursive: true })
    const destBin = join(destDir, execName)
    copyFileSync(cargoTargetBin, destBin)

    // Calculate SHA-256 and byte size
    const buf = readFileSync(destBin)
    const sha256 = createHash("sha256").update(buf).digest("hex")

    const checksumManifest = {
      packageName: `@heidi-dang/${targetDirName}`,
      version: flowdeckVersion,
      executable: execName,
      sha256,
      builtAt: new Date().toISOString(),
    }
    writeFileSync(join(destDir, "checksum.json"), JSON.stringify(checksumManifest, null, 2), "utf-8")

    const currentCommit = tryExec("git", ["rev-parse", "HEAD"]) || process.env.GITHUB_SHA || null
    const currentBranch = tryExec("git", ["rev-parse", "--abbrev-ref", "HEAD"]) || process.env.GITHUB_REF_NAME || null
    const rustVersion = tryExec("rustc", ["--version"]) || null

    // P2-4: never emit fabricated provenance. A zero/absent source commit, a
    // missing branch, a detached-HEAD branch, or a missing rustc version would
    // produce a provenance document that is not traceable to a real build —
    // unacceptable in strict (release/CI) mode, which must fail instead of
    // writing the artifact.
    if (isStrict) {
      const strictError = strictProvenanceInputError({ currentCommit, currentBranch, rustVersion })
      if (strictError) fail(strictError)
    }
    // Even outside strict mode, a detached HEAD must never be recorded as a
    // branch name in provenance: model it explicitly as a detached build.
    const gitBranch = currentBranch === "HEAD" ? "detached" : (currentBranch || "unknown")

    const provenanceManifest = {
      packageName: `@heidi-dang/${targetDirName}`,
      packageVersion: flowdeckVersion,
      flowdeckVersion: flowdeckVersion,
      fdxBinaryVersion: flowdeckVersion,
      fdxProtocolVersion: "1.0.0",
      targetTriple: TARGET_TRIPLES[targetDirName] || (process.platform === "win32" ? "x86_64-pc-windows-msvc" : `${process.arch}-unknown-${process.platform}-gnu`),
      platform: process.platform,
      architecture: process.arch,
      binaryFilename: execName,
      binaryByteSize: buf.length,
      sha256,
      sourceCommitSha: currentCommit || "0000000000000000000000000000000000000000",
      gitCommit: currentCommit || "0000000000000000000000000000000000000000",
      gitBranch,
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      ciRunId: process.env.GITHUB_RUN_ID ?? null,
      builderPlatform: `${process.platform}/${process.arch}`,
      rustVersion: rustVersion || "unknown",
      buildProfile: "release",
      buildTimestamp: new Date().toISOString(),
    }
    const provStr = JSON.stringify(provenanceManifest, null, 2)
    writeFileSync(join(destDir, "provenance.json"), provStr, "utf-8")

    // Copy License & README
    if (existsSync(join(PKG_ROOT, "LICENSE"))) {
      copyFileSync(join(PKG_ROOT, "LICENSE"), join(destDir, "LICENSE"))
    }
    if (!existsSync(join(destDir, "README.md"))) {
      writeFileSync(join(destDir, "README.md"), `# @heidi-dang/${targetDirName}\n\nPrebuilt native FDX executable binary for FlowDeck.\n`, "utf-8")
    }

    // Pack target package into .tgz artifact
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
    const npmOpts = { cwd: destDir, encoding: "utf-8", shell: process.platform === "win32" }
    const tgzName = execFileSync(npmCmd, ["pack"], npmOpts).trim().split("\n").pop()
    const tgzPath = join(destDir, tgzName)
    const tgzBuf = readFileSync(tgzPath)
    const tgzSha256 = createHash("sha256").update(tgzBuf).digest("hex")
    const tgzSri = `sha512-${createHash("sha512").update(tgzBuf).digest("base64")}`
    const provSha256 = createHash("sha256").update(Buffer.from(provStr)).digest("hex")

    const artifactManifest = {
      packageName: `@heidi-dang/${targetDirName}`,
      packageVersion: flowdeckVersion,
      target: targetDirName,
      sourceCommitSha: currentCommit,
      artifactFilename: tgzName,
      artifactSha256: tgzSha256,
      npmIntegrity: tgzSri,
      binarySha256: sha256,
      provenanceSha256: provSha256,
      builtAt: new Date().toISOString(),
    }
    writeFileSync(join(destDir, "artifact-manifest.json"), JSON.stringify(artifactManifest, null, 2), "utf-8")

    console.log(`[build-fdx-packages] Successfully populated ${destDir}`)
    console.log(`  Binary:     ${destBin}`)
    console.log(`  SHA-256:    ${sha256}`)
    console.log(`  Size:       ${buf.length} bytes`)
    console.log(`  Tarball:    ${tgzPath}`)
    console.log(`  Manifest:   ${join(destDir, "artifact-manifest.json")}`)
  } catch (err) {
    fail(`Failed to populate package ${targetDirName}`, err)
  }
}

// Only run the CLI when invoked directly as a script, so importing this
// module (e.g. from tests) does not build or exit the process.
const isEntrypoint = import.meta.main === true || (import.meta.filename && process.argv[1] && import.meta.filename === process.argv[1])
if (isEntrypoint) main()
