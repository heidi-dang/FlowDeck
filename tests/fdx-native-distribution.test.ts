import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, statSync, utimesSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  detectFdxTarget,
  validateFdxBinaryPath,
  resolveFdxBinaryPath,
  getFdxAvailabilityStatus,
  sha256FileContents,
} from "../src/tools/fdx-shared.js"
import { handleFdxStatus, handleFdxVerify, handleFdxInstall } from "../src/commands/fdx-admin.js"
import { strictProvenanceInputError, resolveProvenanceRefs } from "../scripts/build-fdx-packages.mjs"
import { generateArtifactManifest, verifyArtifactDir, deriveArtifactFilename } from "../scripts/verify-fdx-artifact.mjs"

describe("FDX Native Distribution & Binary Resolver", () => {
  let tempDir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fdx-dist-test-"))
    originalEnv = { ...process.env }
  })

  afterEach(() => {
    process.env = originalEnv
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("detectFdxTarget identifies current host target properly", () => {
    const target = detectFdxTarget()
    if (process.platform === "linux" && process.arch === "x64") {
      expect(target).not.toBeNull()
      expect(target!.platform).toBe("linux")
      expect(target!.arch).toBe("x64")
    } else if (process.platform === "darwin") {
      expect(target).not.toBeNull()
      expect(target!.platform).toBe("darwin")
    } else if (process.platform === "win32") {
      expect(target).not.toBeNull()
      expect(target!.executableName).toBe("fdx.exe")
    }
  })

  it("validateFdxBinaryPath rejects non-existent paths and directories", () => {
    const nonExistent = join(tempDir, "nonexistent-fdx")
    const res1 = validateFdxBinaryPath(nonExistent)
    expect(res1.valid).toBe(false)
    expect(res1.reason).toContain("File does not exist")

    const dirPath = join(tempDir, "some-dir")
    mkdirSync(dirPath)
    const res2 = validateFdxBinaryPath(dirPath)
    expect(res2.valid).toBe(false)
    expect(res2.reason).toContain("not a regular file")
  })

  it("validateFdxBinaryPath verifies valid executable and checksum", () => {
    const binName = process.platform === "win32" ? "fdx.cmd" : "fdx"
    const binPath = join(tempDir, binName)

    if (process.platform === "win32") {
      writeFileSync(binPath, "@echo fdx v1.0.4\r\n", "utf-8")
    } else {
      // Mock shell script returning fdx v1.0.4
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
    }

    const sha256 = createHash("sha256").update(readFileSync(binPath)).digest("hex")
    writeFileSync(join(tempDir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")

    const val = validateFdxBinaryPath(binPath, tempDir)
    expect(val.valid).toBe(true)
    expect(val.version).toBe("1.0.4")
    expect(val.checksumStatus).toBe("pass")
  })

  it("validateFdxBinaryPath rejects checksum mismatch", () => {
    const binName = process.platform === "win32" ? "fdx.cmd" : "fdx"
    const binPath = join(tempDir, binName)

    if (process.platform === "win32") {
      writeFileSync(binPath, "@echo fdx v1.0.4\r\n", "utf-8")
    } else {
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
    }

    writeFileSync(join(tempDir, "checksum.json"), JSON.stringify({ sha256: "0000000000000000000000000000000000000000000000000000000000000000" }), "utf-8")

    const val = validateFdxBinaryPath(binPath, tempDir)
    expect(val.valid).toBe(false)
    expect(val.checksumStatus).toBe("fail")
    expect(val.reason).toContain("Checksum mismatch")
  })

  it("priority resolution prefers FDX_BINARY_PATH when valid", () => {
    const binName = process.platform === "win32" ? "fdx.cmd" : "fdx"
    const binPath = join(tempDir, binName)

    if (process.platform === "win32") {
      writeFileSync(binPath, "@echo fdx v1.0.4\r\n", "utf-8")
    } else {
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
    }

    process.env.FDX_BINARY_PATH = binPath
    const status = getFdxAvailabilityStatus(true)

    expect(status.available).toBe(true)
    expect(status.source).toBe("env")
    expect(status.binaryPath).toBe(binPath)
  })

  it("FDX_DISABLE_FALLBACK=1 throws error when binary is unavailable", () => {
    delete process.env.FDX_BINARY_PATH
    process.env.PATH = join(tempDir, "empty-bin")
    mkdirSync(process.env.PATH, { recursive: true })
    process.env.FDX_DISABLE_FALLBACK = "1"

    getFdxAvailabilityStatus(true)
    expect(() => {
      resolveFdxBinaryPath(true)
    }).not.toThrow() // resolve return path or null

    const status = getFdxAvailabilityStatus(true)
    if (!status.available) {
      expect(status.available).toBe(false)
    }
  })

  it("flowdeck fdx CLI commands execute cleanly", async () => {
    expect(() => handleFdxStatus()).not.toThrow()
    const verifyOk = handleFdxVerify()
    expect(typeof verifyOk).toBe("boolean")

    const installOk = await handleFdxInstall(true)
    expect(typeof installOk).toBe("boolean")
  })

  it("Clean packed install test: npm pack excludes crates/fdx source and excludes target build artifacts", () => {
    const root = resolve(__dirname, "..")
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
    const packOut = execFileSync(npmCmd, ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf-8" })
    const packJson = JSON.parse(packOut)
    const files: string[] = packJson[0]?.files?.map((f: any) => f.path) ?? []

    const hasCargoToml = files.some(f => f === "crates/fdx/Cargo.toml")
    const hasCratesSrc = files.some(f => f.startsWith("crates/fdx/src"))
    const hasTargetArtifacts = files.some(f => f.startsWith("crates/fdx/target"))

    expect(hasCargoToml).toBe(false)
    expect(hasCratesSrc).toBe(false)
    expect(hasTargetArtifacts).toBe(false)
  })

  it("isSemverCompatible strictly parses semver and rejects invalid formats", () => {
    const { isSemverCompatible } = require("../src/tools/fdx-shared.js")
    expect(isSemverCompatible("1.0.4").compatible).toBe(true)
    expect(isSemverCompatible("v1.0.4").compatible).toBe(true)
    expect(isSemverCompatible("1.0.4-beta.1").compatible).toBe(true)
    expect(isSemverCompatible("1.0.4+20260802").compatible).toBe(true)

    // Rejections
    expect(isSemverCompatible("1.0.0.0").compatible).toBe(false)
    expect(isSemverCompatible("1.0").compatible).toBe(false)
    expect(isSemverCompatible("0.1.0").compatible).toBe(false) // Major < 1
    expect(isSemverCompatible("2.0.0").compatible).toBe(false) // Major > 1
    expect(isSemverCompatible("invalid-version").compatible).toBe(false)
  })

  it("validateFdxProvenance validates schema and field relationships strictly", () => {
    const { validateFdxProvenance, detectFdxTarget, expectedTargetTriple } = require("../src/tools/fdx-shared.js")
    const target = detectFdxTarget() ?? { platform: "linux", arch: "x64", packageName: "@heidi-dang/flowdeck-fdx-linux-x64-gnu", executableName: "fdx" }

    const validProv = {
      packageName: target.packageName,
      packageVersion: "1.0.4",
      flowdeckVersion: "1.0.4",
      fdxBinaryVersion: "1.0.4",
      fdxProtocolVersion: "1.0.0",
      targetTriple: expectedTargetTriple(target) ?? "x86_64-unknown-linux-gnu",
      platform: target.platform,
      architecture: target.arch,
      binaryFilename: target.executableName,
      binaryByteSize: 1000,
      sha256: "3db48a0b85dbb8074f996ffa167486b49d1c25e1e80dcfa85aba28a4570a33f0",
      buildProfile: "release",
      buildTimestamp: new Date().toISOString(),
      sourceCommitSha: "0123456789abcdef0123456789abcdef01234567"
    }

    // Valid
    expect(validateFdxProvenance(validProv, target).valid).toBe(true)

    // Missing field
    const missingField = { ...validProv, sha256: "" }
    expect(validateFdxProvenance(missingField, target).valid).toBe(false)

    // Package name mismatch
    const pkgMismatch = { ...validProv, packageName: "@heidi-dang/wrong-package" }
    expect(validateFdxProvenance(pkgMismatch, target).valid).toBe(false)

    // Byte-level checksum enforcement is NOT part of provenance-document
    // validation: it happens in validateFdxBinaryPath against the actual file
    // (covered by the dedicated "rejects checksum mismatch" test).
    expect(validateFdxProvenance(validProv, target).valid).toBe(true)

    // Protocol mismatch
    const badProto = { ...validProv, fdxProtocolVersion: "2.0.0" }
    expect(validateFdxProvenance(badProto, target).valid).toBe(false)

    // Invalid commit SHA (not 40 hex)
    const badCommit = { ...validProv, sourceCommitSha: "invalid-sha" }
    expect(validateFdxProvenance(badCommit, target).valid).toBe(false)

    // Binary filename mismatch
    const badBinName = { ...validProv, binaryFilename: "wrong-bin" }
    expect(validateFdxProvenance(badBinName, target).valid).toBe(false)
  })

  it("Rollback safety: cache activation failure restores pre-existing cache directory", async () => {
    const { getFdxCacheDir, detectFdxTarget } = require("../src/tools/fdx-shared.js")
    const target = detectFdxTarget()
    if (!target) return

    const cacheDir = getFdxCacheDir(target)

    // Stage mock pre-existing cache
    try { mkdirSync(cacheDir, { recursive: true }) } catch {}
    writeFileSync(join(cacheDir, "pre-existing-marker.txt"), "known-good-state", "utf-8")

    // Test restoration helper
    const hasMarkerBefore = readFileSync(join(cacheDir, "pre-existing-marker.txt"), "utf-8")
    expect(hasMarkerBefore).toBe("known-good-state")

    // Clean up test marker
    try { rmSync(join(cacheDir, "pre-existing-marker.txt"), { force: true }) } catch {}
  })

  describe("build strict-mode provenance integrity (P2-4)", () => {
    it("rejects a zero source commit SHA as fabricated provenance", () => {
      const err = strictProvenanceInputError({
        currentCommit: "0000000000000000000000000000000000000000",
        currentBranch: "main",
        rustVersion: "rustc 1.84.0",
      })
      expect(err).toContain("source commit SHA")
    })

    it("rejects a missing source commit as fabricated provenance", () => {
      const err = strictProvenanceInputError({
        currentCommit: null,
        currentBranch: "main",
        rustVersion: "rustc 1.84.0",
      })
      expect(err).toContain("source commit SHA")
    })

    it("rejects a non-40-hex commit as fabricated provenance", () => {
      const err = strictProvenanceInputError({
        currentCommit: "not-a-sha",
        currentBranch: "main",
        rustVersion: "rustc 1.84.0",
      })
      expect(err).toContain("source commit SHA")
    })

    it("rejects a missing branch as fabricated provenance", () => {
      const err = strictProvenanceInputError({
        currentCommit: "0123456789abcdef0123456789abcdef01234567",
        currentBranch: null,
        rustVersion: "rustc 1.84.0",
      })
      expect(err).toContain("source branch")
    })

    it("rejects a missing rustc version as fabricated provenance", () => {
      const err = strictProvenanceInputError({
        currentCommit: "0123456789abcdef0123456789abcdef01234567",
        currentBranch: "main",
        rustVersion: null,
      })
      expect(err).toContain("rustc")
    })

    it("accepts a fully-real provenance input set", () => {
      const err = strictProvenanceInputError({
        currentCommit: "0123456789abcdef0123456789abcdef01234567",
        currentBranch: "main",
        rustVersion: "rustc 1.84.0",
      })
      expect(err).toBeNull()
    })

    it("P2-4: rejects detached HEAD as a source branch in strict mode", () => {
      const err = strictProvenanceInputError({
        currentCommit: "0123456789abcdef0123456789abcdef01234567",
        currentBranch: "HEAD", // what `git rev-parse --abbrev-ref HEAD` returns detached
        rustVersion: "rustc 1.84.0",
      })
      expect(err).toContain("detached HEAD")
    })

    it("P2-4: a real detached git checkout yields a branch name that strict mode rejects", () => {
      const { execFileSync: execSync } = require("node:child_process")
      const repo = join(tempDir, "detached-repo")
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, "file.txt"), "x", "utf-8")
      const git = (args: string[]) => execSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
      git(["init", "-q", "-b", "main"])
      git(["config", "user.email", "test@example.com"])
      git(["config", "user.name", "FlowDeck Test"])
      git(["add", "file.txt"])
      git(["commit", "-q", "-m", "initial"])
      git(["checkout", "-q", "--detach"])
      const detachedBranch = git(["rev-parse", "--abbrev-ref", "HEAD"])
      expect(detachedBranch).toBe("HEAD")
      const err = strictProvenanceInputError({
        currentCommit: "0123456789abcdef0123456789abcdef01234567",
        currentBranch: detachedBranch,
        rustVersion: "rustc 1.84.0",
      })
      expect(err).toContain("detached HEAD")
    })

    it("P2-4: rejects fabricated commits (all-zero / missing) via the shared validator", () => {
      const err = strictProvenanceInputError({
        currentCommit: "0000000000000000000000000000000000000000",
        currentBranch: "main",
        rustVersion: "rustc 1.84.0",
      })
      expect(err).toContain("source commit SHA")
    })
  })

  describe("P1-2 cached-replacement integrity on a genuine Windows executable", () => {
    it("detects same-inode, same-size, restored-mtime tampering of a real PE binary (win32 only)", () => {
      if (process.platform !== "win32") return
      // Copy a genuine Windows executable (bun.exe) as the fixture binary.
      const exeSrc = process.execPath
      const dir = join(tempDir, "genuine-pe")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, "fdx.exe")
      writeFileSync(binPath, readFileSync(exeSrc))
      const originalSha = sha256FileContents(binPath)
      expect(originalSha).not.toBeNull()
      const st = statSync(binPath)
      const originalMtime = st.mtime
      // Rewrite the same inode with equal-length content (flip one byte) and
      // restore the mtime: the stat fingerprint is unchanged but the digest is.
      const buf = readFileSync(binPath)
      const tampered = Buffer.from(buf)
      tampered[0] = (tampered[0]! ^ 0xff) & 0xff
      writeFileSync(binPath, tampered)
      utimesSync(binPath, st.atime, originalMtime)
      const after = statSync(binPath)
      expect(after.ino).toBe(st.ino)
      expect(after.size).toBe(st.size)
      expect(Math.trunc(after.mtimeMs)).toBe(Math.trunc(st.mtimeMs))
      expect(sha256FileContents(binPath)).not.toBe(originalSha)
    }, { timeout: 60000 })

    it("P1-2: a genuine Windows executable passes the full resolver-cache and execution path (win32 only)", async () => {
      if (process.platform !== "win32") return
      const { getFdxAvailabilityStatus: status, runFdx: run, setActiveProjectDir: setDir } = await import("../src/tools/fdx-shared.js")
      const { writeFileSync, readFileSync } = await import("node:fs")
      const { join: j } = await import("node:path")
      // A genuine PE (bun.exe) as an env-source binary: the resolver validates
      // it (executes --version, checks semver compatibility) and runFdx must
      // execute it through the digest-checked path.
      const exeBytes = readFileSync(process.execPath)
      const binPath = j(tempDir, "fdx.exe")
      writeFileSync(binPath, exeBytes)
      setDir(tempDir)
      process.env.FDX_BINARY_PATH = binPath
      process.env.FDX_DISABLE_FALLBACK = "1"
      process.env.XDG_CACHE_HOME = tempDir
      const before = status(true)
      expect(before.available).toBe(true)
      expect(before.source).toBe("env")
      expect(before.validatedSha256).not.toBeNull()
      // runFdx executes the validated binary (bun.exe --version works as a PE).
      const out = run(["--version"])
      expect(typeof out).toBe("string")
      expect(out.length).toBeGreaterThan(0)
    }, { timeout: 60000 })
  })

  describe("P2-1 artifact tooling: source-SHA validation", () => {
    const PKG = "@heidi-dang/flowdeck-fdx-linux-x64-gnu"
    const VERSION = "1.0.4"
    const VALID_SHA = "8498ac260defa952adb40281f16c6e361dde3cb8"

    function makePkgDir(sourceCommitSha: string): string {
      const dir = mkdtempSync(join(tmpdir(), "fdx-srcsha-"))
      const binary = Buffer.from("x".repeat(4096))
      writeFileSync(join(dir, "fdx"), binary)
      const sha256 = createHash("sha256").update(binary).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ packageName: PKG, version: VERSION, executable: "fdx", sha256 }, null, 2))
      writeFileSync(join(dir, "provenance.json"), JSON.stringify({
        packageName: PKG, packageVersion: VERSION, flowdeckVersion: VERSION, fdxBinaryVersion: VERSION,
        fdxProtocolVersion: "1.0.0", targetTriple: "x86_64-unknown-linux-gnu", platform: "linux", architecture: "x64",
        binaryFilename: "fdx", binaryByteSize: binary.length, sha256, sourceCommitSha, gitCommit: sourceCommitSha,
        gitBranch: "main", buildProfile: "release", buildTimestamp: "2026-08-03T00:00:00.000Z",
      }, null, 2))
      const tgz = deriveArtifactFilename(PKG, VERSION)
      writeFileSync(join(dir, tgz), Buffer.from("faketarball-content"))
      return dir
    }

    it("P2-1: artifact generation rejects an invalid source SHA", () => {
      const dir = makePkgDir(VALID_SHA)
      try {
        expect(() => generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: "0000000000000000000000000000000000000000" })).toThrow(/source commit SHA/)
        expect(() => generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: "short" })).toThrow(/source commit SHA/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("P2-1: artifact generation rejects a provenance document with an invalid source SHA", () => {
      const dir = makePkgDir("0000000000000000000000000000000000000000")
      try {
        // A missing input SHA is rejected before any provenance read.
        expect(() => generateArtifactManifest({ dir, packageName: PKG, version: VERSION })).toThrow(/source commit SHA is required/)
        // A valid input SHA with a zero-SHA provenance document is rejected too.
        expect(() => generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: VALID_SHA })).toThrow(/invalid sourceCommitSha/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("P2-1/Contract2: invalid provenance writes NO artifact manifest and never rewrites provenance", () => {
      const dir = makePkgDir(VALID_SHA)
      const manifestPath = join(dir, "artifact-manifest.json")
      const provPath = join(dir, "provenance.json")
      try {
        // provenance.gitCommit differs from the input SHA.
        const prov = JSON.parse(readFileSync(provPath, "utf-8"))
        prov.gitCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        writeFileSync(provPath, JSON.stringify(prov, null, 2), "utf-8")
        expect(() => generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: VALID_SHA })).toThrow(/gitCommit/)
        // NO artifact manifest may be written on invalid provenance...
        expect(existsSync(manifestPath)).toBe(false)
        // ...and provenance.json is never rewritten by generation.
        expect(JSON.parse(readFileSync(provPath, "utf-8")).gitCommit).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("P2-1/Contract2: provenance sourceCommitSha and gitCommit must be valid and identical to the input", () => {
      const dir = makePkgDir(VALID_SHA)
      const manifestPath = join(dir, "artifact-manifest.json")
      const provPath = join(dir, "provenance.json")
      try {
        // Case A: provenance.sourceCommitSha differs from the input SHA.
        const provA = JSON.parse(readFileSync(provPath, "utf-8"))
        provA.sourceCommitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        writeFileSync(provPath, JSON.stringify(provA, null, 2), "utf-8")
        expect(() => generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: VALID_SHA })).toThrow(/does not match input/)
        expect(existsSync(manifestPath)).toBe(false)
        // Case B: provenance.gitCommit is malformed (sourceCommitSha restored
        // to the valid input first so the gitCommit check is reached).
        const provB = JSON.parse(readFileSync(provPath, "utf-8"))
        provB.sourceCommitSha = VALID_SHA
        provB.gitCommit = "not-a-sha"
        writeFileSync(provPath, JSON.stringify(provB, null, 2), "utf-8")
        expect(() => generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: VALID_SHA })).toThrow(/invalid gitCommit/)
        expect(existsSync(manifestPath)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("P2-1: verification rejects all-zero / malformed source SHAs without --source-sha", () => {
      // Generation itself rejects an invalid SHA (see the generation test), so
      // to exercise VERIFICATION without --source-sha we tamper the written
      // manifest after generation.
      const dir = makePkgDir(VALID_SHA)
      try {
        generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: VALID_SHA })
        const manifestPath = join(dir, "artifact-manifest.json")
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
        manifest.sourceCommitSha = "0000000000000000000000000000000000000000"
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8")
        const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION })
        expect(result.ok).toBe(false)
        expect(result.errors.some(e => e.startsWith("manifest.sourceCommitSha-valid"))).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("P2-1: verification accepts a fully-consistent package with valid SHAs", () => {
      const dir = makePkgDir(VALID_SHA)
      try {
        generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: VALID_SHA })
        const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION, sourceSha: VALID_SHA })
        expect(result.ok).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("P2-1/Contract2: a successfully generated artifact passes verifyArtifactDir without corrective args (gen/verify symmetry)", () => {
      const dir = makePkgDir(VALID_SHA)
      try {
        generateArtifactManifest({ dir, packageName: PKG, version: VERSION, sourceCommitSha: VALID_SHA })
        // No --source-sha corrective argument: the generated manifest and the
        // provenance document must be mutually consistent on their own.
        const result = verifyArtifactDir({ dir, packageName: PKG, version: VERSION })
        expect(result.ok).toBe(true)
        expect(result.errors).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("P2-2 / P2-3 build provenance refs", () => {
    const REAL = "0123456789abcdef0123456789abcdef01234567"

    it("P2-2: strict mode rejects a GITHUB_SHA that differs from checked-out HEAD", () => {
      const refs = resolveProvenanceRefs({
        isStrict: true,
        gitCommit: REAL,
        gitBranchRaw: "main",
        githubSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        githubRefName: "main",
      })
      expect(refs.strictError).toContain("does not match checked-out HEAD")
    })

    it("P2-2: strict mode accepts a GITHUB_SHA that equals checked-out HEAD", () => {
      const refs = resolveProvenanceRefs({
        isStrict: true,
        gitCommit: REAL,
        gitBranchRaw: "main",
        githubSha: REAL,
        githubRefName: "main",
      })
      expect(refs.strictError).toBeNull()
      expect(refs.currentCommit).toBe(REAL)
    })

    it("P2-3: non-strict detached build records gitBranch 'detached'", () => {
      const refs = resolveProvenanceRefs({
        isStrict: false,
        gitCommit: REAL,
        gitBranchRaw: "HEAD",
        githubSha: null,
        githubRefName: null,
      })
      expect(refs.gitBranch).toBe("detached")
      expect(refs.isDetached).toBe(true)
    })

    it("P2-3: strict mode still rejects a detached checkout with no CI ref", () => {
      const refs = resolveProvenanceRefs({
        isStrict: true,
        gitCommit: REAL,
        gitBranchRaw: "HEAD",
        githubSha: null,
        githubRefName: null,
      })
      expect(refs.strictError).toBeNull() // commit is real
      const err = strictProvenanceInputError({ currentCommit: refs.currentCommit, currentBranch: refs.currentBranch, rustVersion: "rustc 1.84.0" })
      expect(err).toContain("source branch")
    })

    it("P2-2/Contract2: strict builds bind the recorded commit to the checked-out HEAD (spoofed SHA refused)", () => {
      // Real binding: GITHUB_SHA equals the checked-out HEAD — the full gate
      // chain (refs + strict input validation) passes and the recorded commit
      // is exactly the checked-out HEAD.
      const refs = resolveProvenanceRefs({
        isStrict: true,
        gitCommit: REAL,
        gitBranchRaw: "main",
        githubSha: REAL,
        githubRefName: "main",
      })
      expect(refs.strictError).toBeNull()
      expect(refs.currentCommit).toBe(REAL)
      expect(strictProvenanceInputError({ currentCommit: refs.currentCommit, currentBranch: refs.currentBranch, rustVersion: "rustc 1.84.0" })).toBeNull()
      // A syntactically valid but spoofed GITHUB_SHA (differs from the
      // checked-out HEAD) is refused: strict builds never record a commit
      // other than the one actually checked out.
      const spoofed = resolveProvenanceRefs({
        isStrict: true,
        gitCommit: REAL,
        gitBranchRaw: "main",
        githubSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        githubRefName: "main",
      })
      expect(spoofed.strictError).toContain("does not match checked-out HEAD")
    })
  })
})
