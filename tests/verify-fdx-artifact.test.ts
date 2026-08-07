/**
 * Canonical FDX artifact tooling tests: exact archive naming, single-line
 * Node-generated SRI, artifact-manifest generation, and fail-closed
 * cross-manifest verification shared by the build, publish, and local
 * packaging paths.
 */

import { describe, it, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import {
  computeSri,
  isSingleLineSri,
  deriveArtifactFilename,
  generateArtifactManifest,
  verifyArtifactDir,
} from "../scripts/verify-fdx-artifact.mjs"

const PKG = "@heidi-dang/flowdeck-fdx-linux-x64-gnu"
const VERSION = "1.0.4"

function makePackageDir({ tgzName, version = VERSION }: { tgzName?: string; version?: string } = {}): {
  dir: string
  binary: Buffer
  binarySha256: string
  tgzBuf: Buffer
  tgz: string
} {
  const dir = mkdtempSync(join(tmpdir(), "fdx-artifact-"))
  const binary = Buffer.from("x".repeat(4096))
  writeFileSync(join(dir, "fdx"), binary)
  const binarySha256 = createHash("sha256").update(binary).digest("hex")

  writeFileSync(join(dir, "checksum.json"), JSON.stringify({
    packageName: PKG,
    version,
    executable: "fdx",
    sha256: binarySha256,
    builtAt: "2026-08-03T00:00:00.000Z",
  }, null, 2))

  writeFileSync(join(dir, "provenance.json"), JSON.stringify({
    packageName: PKG,
    packageVersion: version,
    flowdeckVersion: version,
    fdxBinaryVersion: version,
    fdxProtocolVersion: "1.0.0",
    targetTriple: "x86_64-unknown-linux-gnu",
    platform: "linux",
    architecture: "x64",
    binaryFilename: "fdx",
    binaryByteSize: binary.length,
    sha256: binarySha256,
    sourceCommitSha: "8498ac260defa952adb40281f16c6e361dde3cb8",
    gitCommit: "8498ac260defa952adb40281f16c6e361dde3cb8",
    gitBranch: "main",
    buildProfile: "release",
    buildTimestamp: "2026-08-03T00:00:00.000Z",
  }, null, 2))

  const tgzBuf = Buffer.from("faketarball-content")
  const tgz = tgzName ?? `${PKG.replace("@", "").replace("/", "-")}-${version}.tgz`
  writeFileSync(join(dir, tgz), tgzBuf)
  return { dir, binary, binarySha256, tgzBuf, tgz }
}

describe("verify-fdx-artifact: archive naming", () => {
  it("derives the exact npm pack filename for a scoped package", () => {
    expect(deriveArtifactFilename(PKG, VERSION)).toBe("heidi-dang-flowdeck-fdx-linux-x64-gnu-1.0.4.tgz")
    expect(deriveArtifactFilename("@heidi-dang/flowdeck-fdx-darwin-arm64", "1.0.4")).toBe("heidi-dang-flowdeck-fdx-darwin-arm64-1.0.4.tgz")
  })

  it("rejects invalid package names and versions", () => {
    expect(() => deriveArtifactFilename("flowdeck-fdx-linux-x64-gnu", VERSION)).toThrow()
    expect(() => deriveArtifactFilename(PKG, "")).toThrow()
  })
})

describe("verify-fdx-artifact: canonical SRI", () => {
  it("computes a single-line sha512- SRI from bytes", () => {
    const buf = Buffer.from("hello fdx")
    const sri = computeSri(buf)
    expect(sri.startsWith("sha512-")).toBe(true)
    expect(/\s/.test(sri)).toBe(false)
    expect(sri).toBe(`sha512-${createHash("sha512").update(buf).digest("base64")}`)
  })

  it("is deterministic across calls (identical output on every OS)", () => {
    const buf = Buffer.from("deterministic bytes")
    expect(computeSri(buf)).toBe(computeSri(buf))
  })

  it("validates single-line SRI and rejects wrapped or malformed values", () => {
    const good = computeSri(Buffer.from("abc"))
    expect(isSingleLineSri(good)).toBe(true)
    // openssl base64 (without -A) wraps at 64 columns — multi-line is invalid
    const wrapped = `${good.slice(0, 64)}\n${good.slice(64)}`
    expect(isSingleLineSri(wrapped)).toBe(false)
    expect(isSingleLineSri("sha1-abc")).toBe(false)
    expect(isSingleLineSri("sha512-abc def")).toBe(false)
    expect(isSingleLineSri("sha512-!!!")).toBe(false)
  })
})

describe("verify-fdx-artifact: artifact-manifest generation", () => {
  it("writes a manifest with exact archive identity and cross-hashes", () => {
    const { dir, binarySha256, tgzBuf } = makePackageDir()
    const manifest = generateArtifactManifest({
      dir,
      packageName: PKG,
      version: VERSION,
      sourceCommitSha: "8498ac260defa952adb40281f16c6e361dde3cb8",
    })
    expect(manifest.artifactFilename).toBe("heidi-dang-flowdeck-fdx-linux-x64-gnu-1.0.4.tgz")
    expect(manifest.artifactSha256).toBe(createHash("sha256").update(tgzBuf).digest("hex"))
    expect(manifest.npmIntegrity).toBe(computeSri(tgzBuf))
    expect(isSingleLineSri(manifest.npmIntegrity)).toBe(true)
    expect(manifest.binarySha256).toBe(binarySha256)
    expect(manifest.packageVersion).toBe(VERSION)
    rmSync(dir, { recursive: true, force: true })
  })

  it("fails when the directory does not contain exactly one correctly-named archive", () => {
    const wrong = makePackageDir({ tgzName: "wrong-name-1.0.4.tgz" })
    expect(() => generateArtifactManifest({ dir: wrong.dir, packageName: PKG, version: VERSION })).toThrow(/name mismatch/)
    rmSync(wrong.dir, { recursive: true, force: true })

    const two = makePackageDir()
    writeFileSync(join(two.dir, "extra-1.0.4.tgz"), Buffer.from("extra"))
    expect(() => generateArtifactManifest({ dir: two.dir, packageName: PKG, version: VERSION })).toThrow(/exactly one/)
    rmSync(two.dir, { recursive: true, force: true })
  })
})

describe("verify-fdx-artifact: cross-manifest verification", () => {
  it("passes a fully consistent package directory", () => {
    const { dir } = makePackageDir()
    generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: "8498ac260defa952adb40281f16c6e361dde3cb8" })
    const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION, sourceSha: "8498ac260defa952adb40281f16c6e361dde3cb8" })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it("fails when the binary was tampered with (checksum/provenance/manifest mismatch)", () => {
    const { dir } = makePackageDir()
    generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: "8498ac260defa952adb40281f16c6e361dde3cb8" })
    // Tamper AFTER manifest generation so the hashes no longer match the file.
    writeFileSync(join(dir, "fdx"), Buffer.from("tampered-binary"))
    const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.startsWith("binary-sha256-consistency"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("fails on release-version drift in any manifest", () => {
    const { dir } = makePackageDir({ version: "9.9.9" })
    // Manifest carries the package's own (stale) version; verification targets
    // the canonical release version 1.0.4 -> drift must fail closed.
    generateArtifactManifest({ dir, packageName: PKG, version: "9.9.9", sourceCommitSha: "8498ac260defa952adb40281f16c6e361dde3cb8" })
    const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.startsWith("checksum.version"))).toBe(true)
    expect(result.errors.some(e => e.startsWith("provenance.packageVersion"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("fails when a required manifest is missing", () => {
    const { dir } = makePackageDir()
    rmSync(join(dir, "checksum.json"))
    const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.startsWith("checksum-present"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("fails when the artifact source SHA does not match the release source SHA", () => {
    const { dir } = makePackageDir()
    // Generation requires a provenance-consistent input SHA; the verify-time
    // mismatch is exercised by tampering the written manifest afterwards.
    generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: "8498ac260defa952adb40281f16c6e361dde3cb8" })
    const manifestPath = join(dir, "artifact-manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
    manifest.sourceCommitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8")
    const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION, sourceSha: "8498ac260defa952adb40281f16c6e361dde3cb8" })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.startsWith("manifest.sourceCommitSha"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects a directory with more than one archive", () => {
    const { dir } = makePackageDir()
    writeFileSync(join(dir, "extra-1.0.4.tgz"), Buffer.from("extra"))
    const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION })
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.startsWith("archive-count"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("fails closed with a non-zero exit when invoked via CLI", () => {
    const { dir } = makePackageDir()
    generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: "8498ac260defa952adb40281f16c6e361dde3cb8" })
    writeFileSync(join(dir, "fdx"), Buffer.from("tampered-binary"))
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const res = spawnSync(process.execPath, ["scripts/verify-fdx-artifact.mjs", "verify", "--dir", dir, "--package-name", PKG, "--version", VERSION], { cwd: join(import.meta.dir, "..") })
    expect(res.status).not.toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })
})
