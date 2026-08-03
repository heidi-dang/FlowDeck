#!/usr/bin/env node
/**
 * Shared FDX release artifact tooling.
 *
 * Single source of truth for:
 *   - npm archive filename derivation (exact, never discovered by glob)
 *   - canonical single-line `sha512-` SRI computation (Node-generated so every
 *     OS produces identical output)
 *   - artifact-manifest.json generation
 *   - cross-manifest artifact verification (checksum.json, provenance.json,
 *     artifact-manifest.json, and the actual files)
 *
 * Used by the build workflow (.github/workflows/build-fdx-binaries.yml), the
 * publish workflow (.github/workflows/publish.yml), and the local packaging
 * script (scripts/build-fdx-packages.mjs) so the artifact math never drifts.
 *
 * CLI:
 *   node scripts/verify-fdx-artifact.mjs generate --dir <dir> \
 *       --package-name <@scope/name> --version <v> [--source-sha <sha>] [--built-at <iso>]
 *   node scripts/verify-fdx-artifact.mjs verify --dir <dir> \
 *       --package-name <@scope/name> --version <v> [--source-sha <sha>]
 *
 * Both modes exit non-zero (fail-closed) on any mismatch.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function computeSha256(buf) {
  return createHash("sha256").update(buf).digest("hex")
}

export function computeSri(buf) {
  return `sha512-${createHash("sha512").update(buf).digest("base64")}`
}

/** A valid SRI is a single line: `sha512-` followed by unwrapped base64. */
export function isSingleLineSri(sri) {
  if (typeof sri !== "string" || !sri.startsWith("sha512-")) return false
  const b64 = sri.slice("sha512-".length)
  if (/\s/.test(b64)) return false
  return /^[A-Za-z0-9+/=]+$/.test(b64)
}

/**
 * Exact npm pack archive filename for a scoped package at a version.
 * npm pack converts `@scope/name` to `scope-name-<version>.tgz`.
 */
export function deriveArtifactFilename(packageName, version) {
  if (typeof packageName !== "string" || !packageName.startsWith("@") || !packageName.includes("/")) {
    throw new Error(`Invalid scoped package name: ${JSON.stringify(packageName)}`)
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`Invalid package version: ${JSON.stringify(version)}`)
  }
  const unscoped = packageName.replace(/^@/, "").replace(/\//, "-")
  return `${unscoped}-${version}.tgz`
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf-8"))
}

export function findTgzFiles(dir) {
  return readdirSync(dir).filter(name => name.endsWith(".tgz"))
}

function fail(message) {
  console.error(`[verify-fdx-artifact] FAIL: ${message}`)
  process.exit(1)
}

/**
 * Generate artifact-manifest.json for a fully populated package directory
 * (binary + checksum.json + provenance.json + exactly one npm archive).
 * Returns the manifest object.
 *
 * @param {{ dir: string, packageName: string, version: string, sourceCommitSha?: string, builtAt?: string }} options
 */
export function generateArtifactManifest({ dir, packageName, version, sourceCommitSha, builtAt }) {
  const expectedName = deriveArtifactFilename(packageName, version)
  const tgzFiles = findTgzFiles(dir)
  if (tgzFiles.length !== 1) {
    throw new Error(`expected exactly one archive (${expectedName}) in ${dir}, found: ${tgzFiles.join(", ")}`)
  }
  if (tgzFiles[0] !== expectedName) {
    throw new Error(`archive name mismatch: expected ${expectedName}, found ${tgzFiles[0]}`)
  }

  const provenancePath = join(dir, "provenance.json")
  if (!existsSync(provenancePath)) throw new Error(`provenance.json missing in ${dir}`)
  const provenance = readJson(provenancePath)
  const binaryFilename = provenance.binaryFilename
  if (typeof binaryFilename !== "string" || binaryFilename.length === 0) {
    throw new Error(`provenance.json is missing a valid binaryFilename in ${dir}`)
  }

  const binaryPath = join(dir, binaryFilename)
  if (!existsSync(binaryPath)) throw new Error(`binary ${binaryFilename} missing in ${dir}`)

  const tgzBuf = readFileSync(join(dir, expectedName))
  const binaryBuf = readFileSync(binaryPath)
  const provBuf = readFileSync(provenancePath)
  const now = builtAt ?? new Date().toISOString()

  const manifest = {
    packageName,
    packageVersion: version,
    target: packageName.replace("@heidi-dang/", ""),
    sourceCommitSha: sourceCommitSha ?? null,
    artifactFilename: expectedName,
    artifactSha256: computeSha256(tgzBuf),
    npmIntegrity: computeSri(tgzBuf),
    binarySha256: computeSha256(binaryBuf),
    provenanceSha256: computeSha256(provBuf),
    builtAt: now,
  }
  writeFileSync(join(dir, "artifact-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8")
  return manifest
}

/**
 * Cross-verify a package directory. All mismatches are collected and reported;
 * the process exits non-zero if any check fails (fail-closed).
 *
 * @param {{ dir: string, packageName: string, version: string, sourceSha?: string }} options
 */
export function verifyArtifactDir({ dir, packageName, version, sourceSha }) {
  const errors = []
  const report = (label, ok, detail) => {
    if (!ok) errors.push(`${label}: ${detail}`)
  }

  const expectedName = deriveArtifactFilename(packageName, version)
  const tgzFiles = findTgzFiles(dir)
  report("archive-count", tgzFiles.length === 1, `expected exactly one .tgz (${expectedName}), found ${tgzFiles.length}`)
  if (tgzFiles.length === 1) {
    report("archive-name", tgzFiles[0] === expectedName, `expected ${expectedName}, found ${tgzFiles[0]}`)
  }

  const manifestPath = join(dir, "artifact-manifest.json")
  const provenancePath = join(dir, "provenance.json")
  const checksumPath = join(dir, "checksum.json")
  for (const [label, file] of [["artifact-manifest", manifestPath], ["provenance", provenancePath], ["checksum", checksumPath]]) {
    report(`${label}-present`, existsSync(file), `${file} missing`)
  }
  if (!existsSync(manifestPath) || !existsSync(provenancePath) || !existsSync(checksumPath)) {
    for (const err of errors) console.error(`  - ${err}`)
    return { ok: false, errors }
  }

  let manifest, provenance, checksum
  try {
    manifest = readJson(manifestPath)
    provenance = readJson(provenancePath)
    checksum = readJson(checksumPath)
  } catch (e) {
    for (const err of errors) console.error(`  - ${err}`)
    return { ok: false, errors, parseError: e.message }
  }

  // Package identity
  for (const [label, value] of [["manifest.packageName", manifest.packageName], ["provenance.packageName", provenance.packageName], ["checksum.packageName", checksum.packageName]]) {
    report(label, value === packageName, `expected ${packageName}, got ${JSON.stringify(value)}`)
  }

  // Version alignment (release version must be identical everywhere)
  for (const [label, value] of [
    ["manifest.packageVersion", manifest.packageVersion],
    ["provenance.packageVersion", provenance.packageVersion],
    ["provenance.flowdeckVersion", provenance.flowdeckVersion],
    ["provenance.fdxBinaryVersion", provenance.fdxBinaryVersion],
    ["checksum.version", checksum.version],
  ]) {
    report(label, value === version, `expected ${version}, got ${JSON.stringify(value)}`)
  }

  // Archive identity
  const tgzPath = join(dir, expectedName)
  const tgzExists = existsSync(tgzPath)
  report("archive-present", tgzExists, `${expectedName} missing`)
  if (tgzExists) {
    const tgzBuf = readFileSync(tgzPath)
    report("manifest.artifactFilename", manifest.artifactFilename === expectedName, `expected ${expectedName}, got ${JSON.stringify(manifest.artifactFilename)}`)
    report("manifest.artifactSha256", manifest.artifactSha256 === computeSha256(tgzBuf), "does not match actual archive sha256")
    report("manifest.npmIntegrity", manifest.npmIntegrity === computeSri(tgzBuf), "does not match actual archive sha512")
    report("npmIntegrity-single-line", isSingleLineSri(manifest.npmIntegrity), JSON.stringify(manifest.npmIntegrity))
  }

  // Binary identity (provenance + checksum + manifest must all match the file)
  const binaryFilename = provenance.binaryFilename
  report("provenance.binaryFilename", typeof binaryFilename === "string" && binaryFilename.length > 0, JSON.stringify(binaryFilename))
  const binaryPath = typeof binaryFilename === "string" ? join(dir, binaryFilename) : null
  const binaryExists = binaryPath !== null && existsSync(binaryPath)
  report("binary-present", binaryExists, binaryFilename ? `${binaryFilename} missing` : "no binaryFilename")
  if (binaryExists) {
    const binaryBuf = readFileSync(binaryPath)
    const actualSha = computeSha256(binaryBuf)
    report("binary-sha256-consistency",
      actualSha === provenance.sha256 && actualSha === checksum.sha256 && actualSha === manifest.binarySha256,
      `file=${actualSha} provenance=${provenance.sha256} checksum=${checksum.sha256} manifest=${manifest.binarySha256}`)
    report("provenance.binaryByteSize", typeof provenance.binaryByteSize === "number" && provenance.binaryByteSize === binaryBuf.length,
      `expected ${binaryBuf.length}, got ${JSON.stringify(provenance.binaryByteSize)}`)
  }

  // Source SHA binding (when the expected release source SHA is known)
  if (sourceSha) {
    for (const [label, value] of [["manifest.sourceCommitSha", manifest.sourceCommitSha], ["provenance.sourceCommitSha", provenance.sourceCommitSha], ["provenance.gitCommit", provenance.gitCommit]]) {
      report(label, value === sourceSha, `expected ${sourceSha}, got ${JSON.stringify(value)}`)
    }
  }

  for (const err of errors) console.error(`  - ${err}`)
  return { ok: errors.length === 0, errors }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const value = argv[i + 1]
      args[key] = value
      i += 1
    }
  }
  return args
}

function main() {
  const [mode, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  const required = ["dir", "package-name", "version"]
  for (const key of required) {
    if (!args[key]) fail(`missing required option --${key}`)
  }
  const dir = args.dir
  const packageName = args["package-name"]
  const version = args.version
  const sourceSha = args["source-sha"] ?? undefined

  if (mode === "generate") {
    try {
      const manifest = generateArtifactManifest({
        dir,
        packageName,
        version,
        sourceCommitSha: sourceSha,
        builtAt: args["built-at"],
      })
      console.log(`[verify-fdx-artifact] artifact-manifest.json written for ${packageName}@${version}`)
      console.log(`  archive:      ${manifest.artifactFilename}`)
      console.log(`  sha256:       ${manifest.artifactSha256}`)
      console.log(`  npmIntegrity: ${manifest.npmIntegrity}`)
      console.log(`  binarySha256: ${manifest.binarySha256}`)
    } catch (e) {
      fail(e.message)
    }
  } else if (mode === "verify") {
    const result = verifyArtifactDir({ dir, packageName, version, sourceSha })
    if (!result.ok) {
      console.error(`[verify-fdx-artifact] FAIL: ${packageName}@${version} failed ${result.errors.length} check(s)`)
      process.exit(1)
    }
    console.log(`[verify-fdx-artifact] OK: ${packageName}@${version} verified in ${dir}`)
  } else {
    fail(`unknown mode: ${JSON.stringify(mode)} (expected generate|verify)`)
  }
}

// Only run the CLI when invoked directly as a script, so importing this
// module (e.g. from tests or the build workflow) does not parse argv or exit.
const isEntrypoint = import.meta.main === true || (import.meta.filename && process.argv[1] && import.meta.filename === process.argv[1])
if (isEntrypoint) main()
