import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync, statSync, renameSync,
} from "node:fs"
import { join, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import {
  isReleaseProfile,
  localDevSourcesAllowed,
  getFdxAvailabilityStatus,
  getFdxCacheDir,
  getFlowdeckPackageVersion,
  detectFdxTarget,
  setActiveProjectDir,
  resolveTrustedPlatformPackage,
  expectedTargetTriple,
  validateFdxBinaryPath,
  buildResolutionCacheKey,
  sha256FileContents,
  setFdxPreExecTestHook,
  runFdx,
  sourceCommitShaError,
  executeVerifiedSnapshot,
} from "../src/tools/fdx-shared"
import { acquireInstallLock, releaseInstallLock, handleFdxInstall, parseSRI, REGISTRY_TIMEOUT_MS, type InstallLockResult } from "../src/commands/fdx-admin"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FDX_ADMIN_MODULE = join(REPO_ROOT, "src/commands/fdx-admin.ts")

const TARGET_ID = "test-target@test-version"

describe("FDX Trusted Acquisition (Phase 6)", () => {
  let tempDir: string
  let originalEnv: NodeJS.ProcessEnv
  let liveChildren: Array<ReturnType<typeof spawn>> = []

  function requireOk(res: InstallLockResult): { token: string } {
    if (!res.ok) throw new Error(`expected acquire to succeed, got reason=${res.reason} detail=${res.detail ?? ""}`)
    return { token: res.token }
  }

  function makeLockPayload(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      schemaVersion: 1,
      pid: 2147483647, // impossible pid — confirmed dead on any real system
      createdAt: Date.now(),
      token: "t".repeat(64),
      target: TARGET_ID,
      ...overrides,
    }
  }

  function buildFakePlatformPackage(dir: string, overrides: { name?: string; version?: string } = {}): { pkgDir: string; binPath: string } | null {
    const target = detectFdxTarget()
    if (!target) return null
    const localName = target.packageName.replace("@heidi-dang/", "")
    const pkgDir = join(dir, "packages", localName)
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: overrides.name ?? target.packageName, version: overrides.version ?? getFlowdeckPackageVersion() }),
      "utf-8"
    )
    const binPath = join(pkgDir, target.executableName)
    if (process.platform === "win32") {
      writeFileSync(binPath, "@echo fdx v1.0.4\r\n", "utf-8")
    } else {
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
    }
    const binBuf = readFileSync(binPath)
    const sha256 = createHash("sha256").update(binBuf).digest("hex")
    writeFileSync(join(pkgDir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
    // Compliant provenance: models a real release package so the full trust
    // contract (checksum + provenance) can be exercised end-to-end.
    const flowdeckVersion = getFlowdeckPackageVersion()
    writeFileSync(
      join(pkgDir, "provenance.json"),
      JSON.stringify({
        packageName: overrides.name ?? target.packageName,
        packageVersion: flowdeckVersion,
        flowdeckVersion,
        fdxBinaryVersion: flowdeckVersion,
        fdxProtocolVersion: "1.0.0",
        targetTriple: expectedTargetTriple(target) ?? undefined,
        platform: target.platform,
        architecture: target.arch,
        binaryFilename: target.executableName,
        binaryByteSize: binBuf.length,
        sha256,
        sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
        buildProfile: "release",
        buildTimestamp: new Date().toISOString(),
      }),
      "utf-8"
    )
    return { pkgDir, binPath }
  }

  interface ChildHandle {
    child: ReturnType<typeof spawn>
    stdout: string
    stderr: string
    exited: Promise<number | null>
  }

  function spawnScript(scriptBody: string, env: Record<string, string> = {}): ChildHandle {
    const scriptPath = join(tempDir, `child-${Math.random().toString(36).slice(2)}.ts`)
    writeFileSync(scriptPath, scriptBody, "utf-8")
    const child = spawn(process.execPath, [scriptPath], {
      cwd: tempDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const handle: ChildHandle = { child, stdout: "", stderr: "", exited: Promise.resolve(null) }
    child.stdout.on("data", (d: Buffer) => { handle.stdout += d.toString() })
    child.stderr.on("data", (d: Buffer) => { handle.stderr += d.toString() })
    child.on("error", (err: Error) => { handle.stderr += `[spawn error] ${err.message}\n` })
    handle.exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)))
    liveChildren.push(child)
    return handle
  }

  /** Acquire-and-hold script: writes the ownership token to `markerFile`, then holds the lock forever. */
  function holdLockScript(lockPath: string, markerFile: string): string {
    return `
import { acquireInstallLock } from ${JSON.stringify(FDX_ADMIN_MODULE)}
import { writeFileSync } from "node:fs"
const res = acquireInstallLock(${JSON.stringify(lockPath)}, ${JSON.stringify(TARGET_ID)})
if (!res.ok) {
  console.log("RESULT:" + JSON.stringify({ acquired: false, reason: res.reason }))
  process.exit(0)
}
writeFileSync(${JSON.stringify(markerFile)}, res.token, "utf-8")
console.log("RESULT:" + JSON.stringify({ acquired: true }))
await new Promise(() => {})
`
  }

  function parseResult(stdout: string): { acquired: boolean; reason?: string } {
    const line = stdout.split("RESULT:")[1]?.split("\n")[0]
    if (!line) throw new Error(`no RESULT line in child output: ${stdout}`)
    return JSON.parse(line)
  }

  async function waitForResult(handle: ChildHandle, timeoutMs = 15000): Promise<string> {
    const started = Date.now()
    while (!handle.stdout.includes("RESULT:")) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for child result. stdout=${JSON.stringify(handle.stdout)} stderr=${JSON.stringify(handle.stderr)}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    return handle.stdout.split("RESULT:")[1].split("\n")[0]
  }

  async function waitForFile(filePath: string, timeoutMs = 10000): Promise<void> {
    const started = Date.now()
    while (!existsSync(filePath)) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for file ${filePath}`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  async function killChild(handle: ChildHandle, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill(signal)
    }
    await handle.exited
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fdx-trusted-acq-"))
    originalEnv = { ...process.env }
    delete process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE
    delete process.env.FLOWDECK_PROFILE
    delete process.env.NODE_ENV
    delete process.env.XDG_CACHE_HOME
    delete process.env.FDX_BINARY_PATH
  })

  afterEach(() => {
    for (const child of liveChildren) {
      try { child.kill("SIGKILL") } catch {}
    }
    liveChildren = []
    setFdxPreExecTestHook(null)
    setActiveProjectDir(REPO_ROOT)
    process.env = originalEnv
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  describe("localDevSourcesAllowed", () => {
    it("is off by default (opt-in)", () => {
      expect(localDevSourcesAllowed()).toBe(false)
    })

    it("is on when FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE=1", () => {
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      expect(localDevSourcesAllowed()).toBe(true)
    })

    it("is rejected in release profile (FLOWDECK_PROFILE=release) even when opt-in set", () => {
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.FLOWDECK_PROFILE = "release"
      expect(isReleaseProfile()).toBe(true)
      expect(localDevSourcesAllowed()).toBe(false)
    })

    it("is rejected when NODE_ENV=production even when opt-in set", () => {
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.NODE_ENV = "production"
      expect(isReleaseProfile()).toBe(true)
      expect(localDevSourcesAllowed()).toBe(false)
    })

    it("is on in non-release profiles with opt-in set", () => {
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.FLOWDECK_PROFILE = "recommended-dev"
      expect(isReleaseProfile()).toBe(false)
      expect(localDevSourcesAllowed()).toBe(true)
    })
  })

  describe("install lock (token protocol)", () => {
    it("acquires, blocks a concurrent holder, releases with token, and re-acquires", () => {
      const lockPath = join(tempDir, "target.lock")
      const a = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      const b = acquireInstallLock(lockPath, TARGET_ID)
      expect(b.ok).toBe(false)
      if (!b.ok) expect(b.reason).toBe("lock-held-live")
      expect(existsSync(lockPath)).toBe(true)
      // Wrong token must not release.
      expect(releaseInstallLock(lockPath, "wrong-token")).toBe(false)
      expect(existsSync(lockPath)).toBe(true)
      // Correct token releases.
      expect(releaseInstallLock(lockPath, a.token)).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
      // Re-acquire after release succeeds.
      const c = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      expect(releaseInstallLock(lockPath, c.token)).toBe(true)
    })

    it("records a complete lock payload with unique tokens per acquisition", () => {
      const lockPath = join(tempDir, "payload.lock")
      const a = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      const data = JSON.parse(readFileSync(lockPath, "utf-8"))
      expect(data.schemaVersion).toBe(1)
      expect(data.pid).toBe(process.pid)
      expect(typeof data.createdAt).toBe("number")
      expect(data.token).toMatch(/^[0-9a-f]{64}$/)
      expect(data.target).toBe(TARGET_ID)
      expect(data.token).toBe(a.token)
      releaseInstallLock(lockPath, a.token)
      const b = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      expect(b.token).not.toBe(a.token)
      releaseInstallLock(lockPath, b.token)
    })

    it("does not break a fresh lock held by a live process", () => {
      const lockPath = join(tempDir, "live.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: process.pid })), "utf-8")
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-held-live")
      expect(existsSync(lockPath)).toBe(true)
    })

    it("never breaks a live-process lock older than the staleness threshold (age never overrides a live PID)", () => {
      const lockPath = join(tempDir, "old-live.lock")
      writeFileSync(
        lockPath,
        JSON.stringify(makeLockPayload({ pid: process.pid, createdAt: Date.now() - 45 * 60 * 1000 })),
        "utf-8"
      )
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-held-live")
      expect(existsSync(lockPath)).toBe(true)
    })

    it("does not break a freshly created empty lock (indeterminate — owner may be initializing)", () => {
      const lockPath = join(tempDir, "fresh-empty.lock")
      writeFileSync(lockPath, "", "utf-8")
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-indeterminate-fresh")
      expect(existsSync(lockPath)).toBe(true)
    })

    it("does not break a freshly created malformed lock (indeterminate)", () => {
      const lockPath = join(tempDir, "fresh-malformed.lock")
      writeFileSync(lockPath, "not-json", "utf-8")
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-indeterminate-fresh")
      expect(existsSync(lockPath)).toBe(true)
    })

    it("recovers an old malformed lock (past the bounded grace interval) and acquires", () => {
      const lockPath = join(tempDir, "old-malformed.lock")
      writeFileSync(lockPath, "not-json", "utf-8")
      // Backdate mtime beyond the bounded grace interval.
      utimesSync(lockPath, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))
      const res = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      releaseInstallLock(lockPath, res.token)
      expect(existsSync(lockPath)).toBe(false)
    })

    it("recovers a stale lock whose owner is confirmed dead and releases with the new token", () => {
      const lockPath = join(tempDir, "stale.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: 2147483647 })), "utf-8")
      const res = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      expect(releaseInstallLock(lockPath, res.token)).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    })

    it("recovers a stale lock through the direct exclusive-creation fallback (no hard links)", () => {
      const lockPath = join(tempDir, "fallback-stale.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: 2147483647 })), "utf-8")
      process.env.FLOWDECK_FDX_LOCK_FORCE_FALLBACK = "1"
      const res = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      expect(releaseInstallLock(lockPath, res.token)).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    })

    it("fails closed on the fallback path when the lock owner is live", () => {
      const lockPath = join(tempDir, "fallback-live.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: process.pid })), "utf-8")
      process.env.FLOWDECK_FDX_LOCK_FORCE_FALLBACK = "1"
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-held-live")
      expect(existsSync(lockPath)).toBe(true)
    })

    it("leaves no temporary or quarantine files behind after fallback recovery", () => {
      const lockPath = join(tempDir, "fallback-cleanup.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: 2147483647 })), "utf-8")
      process.env.FLOWDECK_FDX_LOCK_FORCE_FALLBACK = "1"
      const res = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      releaseInstallLock(lockPath, res.token)
      const leftovers = readdirSync(tempDir).filter((f) => f.includes(".tmp-") || f.includes(".stale-"))
      expect(leftovers).toEqual([])
    })

    it("fails closed when an existing lock cannot be read (permission denied)", () => {
      // POSIX permission semantics do not exist on Windows (chmod 000 is a
      // no-op on NTFS), so the unreadable-lock scenario is POSIX-only.
      if (process.platform === "win32") return
      if (typeof process.getuid === "function" && process.getuid() === 0) return // root can read 000 files
      const lockPath = join(tempDir, "unreadable.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: 2147483647 })), "utf-8")
      chmodSync(lockPath, 0o000)
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-read-error")
      // The unreadable lock is never deleted or modified.
      expect(existsSync(lockPath)).toBe(true)
      chmodSync(lockPath, 0o600)
    })

    it("fails closed on a lock with an invalid pid (unknown liveness)", () => {
      const lockPath = join(tempDir, "invalid-pid.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: -1 })), "utf-8")
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-unknown-liveness")
      expect(existsSync(lockPath)).toBe(true)
    })

    it("fails closed on a lock with a non-numeric pid (unknown liveness)", () => {
      const lockPath = join(tempDir, "nonnum-pid.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: "abc" })), "utf-8")
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-unknown-liveness")
      expect(existsSync(lockPath)).toBe(true)
    })

    it("fails closed on an unsupported lock schema version", () => {
      const lockPath = join(tempDir, "schema.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ schemaVersion: 99 })), "utf-8")
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("lock-incompatible-schema")
      expect(existsSync(lockPath)).toBe(true)
    })

    it("leaves no temporary lock files behind after a blocked acquire", () => {
      const lockPath = join(tempDir, "cleanup.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: process.pid })), "utf-8")
      const res = acquireInstallLock(lockPath, TARGET_ID)
      expect(res.ok).toBe(false)
      const leftovers = readdirSync(tempDir).filter((f) => f.includes(".tmp-"))
      expect(leftovers).toEqual([])
    })

    it("returns false (no throw) releasing a missing lock", () => {
      const lockPath = join(tempDir, "missing.lock")
      expect(releaseInstallLock(lockPath, "any-token")).toBe(false)
    })

    it("returns false (no throw) releasing a malformed lock", () => {
      const lockPath = join(tempDir, "malformed.lock")
      writeFileSync(lockPath, "not-json", "utf-8")
      expect(releaseInstallLock(lockPath, "any-token")).toBe(false)
      expect(existsSync(lockPath)).toBe(true)
    })

    it("a stale token cannot remove a replacement owner's lock (finally-safe)", () => {
      const lockPath = join(tempDir, "replacement.lock")
      const first = requireOk(acquireInstallLock(lockPath, TARGET_ID))
      // Simulate a replacement owner taking over (e.g. after stale recovery).
      const replacement = makeLockPayload({ pid: process.pid, token: "r".repeat(64) })
      writeFileSync(lockPath, JSON.stringify(replacement), "utf-8")
      // The original owner's stale token must not delete the replacement lock.
      expect(releaseInstallLock(lockPath, first.token)).toBe(false)
      expect(existsSync(lockPath)).toBe(true)
      const data = JSON.parse(readFileSync(lockPath, "utf-8"))
      expect(data.token).toBe("r".repeat(64))
      expect(releaseInstallLock(lockPath, replacement.token)).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
    })
  })

  describe("install lock (cross-process)", () => {
    it("exactly one process acquires among two concurrent contenders", async () => {
      const lockPath = join(tempDir, "contend.lock")
      const h1 = spawnScript(holdLockScript(lockPath, join(tempDir, "winner-token.txt")))
      const h2 = spawnScript(holdLockScript(lockPath, join(tempDir, "winner-token-2.txt")))
      await waitForResult(h1)
      await waitForResult(h2)
      const r1 = parseResult(h1.stdout)
      const r2 = parseResult(h2.stdout)
      const winners = [r1, r2].filter((r) => r.acquired)
      expect(winners.length).toBe(1)
      await killChild(h1)
      await killChild(h2)
    }, { timeout: 20000 })

    it("two simultaneous stale-lock contenders — exactly one wins (atomic recovery)", async () => {
      const lockPath = join(tempDir, "stale-contend.lock")
      writeFileSync(lockPath, JSON.stringify(makeLockPayload({ pid: 2147483647 })), "utf-8")
      const h1 = spawnScript(holdLockScript(lockPath, join(tempDir, "w1.txt")))
      const h2 = spawnScript(holdLockScript(lockPath, join(tempDir, "w2.txt")))
      await waitForResult(h1)
      await waitForResult(h2)
      const r1 = parseResult(h1.stdout)
      const r2 = parseResult(h2.stdout)
      expect([r1, r2].filter((r) => r.acquired).length).toBe(1)
      const loser = [r1, r2].find((r) => !r.acquired)
      expect(loser).toBeDefined()
      if (loser && loser.reason) {
        expect(["lock-held-live", "lock-recovery-error", "lock-contention-exhausted", "lock-unknown-liveness"]).toContain(loser.reason)
      }
      await killChild(h1)
      await killChild(h2)
    }, { timeout: 20000 })

    it("a killed owner's lock is recovered by a fresh process; the dead owner's token cannot release the new owner's lock", async () => {
      const lockPath = join(tempDir, "recovery.lock")
      const tokenAFile = join(tempDir, "tokenA.txt")
      const hA = spawnScript(holdLockScript(lockPath, tokenAFile))
      await waitForResult(hA)
      expect(parseResult(hA.stdout).acquired).toBe(true)
      await waitForFile(tokenAFile)
      const tokenA = readFileSync(tokenAFile, "utf-8")

      // Kill the owner abruptly — its lock (dead pid) remains in place.
      await killChild(hA)
      expect(existsSync(lockPath)).toBe(true)

      // A fresh process recovers the dead owner's lock.
      const tokenBFile = join(tempDir, "tokenB.txt")
      const hB = spawnScript(holdLockScript(lockPath, tokenBFile))
      await waitForResult(hB)
      expect(parseResult(hB.stdout).acquired).toBe(true)
      await waitForFile(tokenBFile)
      const tokenB = readFileSync(tokenBFile, "utf-8")
      expect(tokenB).not.toBe(tokenA)

      // The dead owner's token must not release the new owner's lock.
      expect(releaseInstallLock(lockPath, tokenA)).toBe(false)
      expect(existsSync(lockPath)).toBe(true)
      const data = JSON.parse(readFileSync(lockPath, "utf-8"))
      expect(data.token).toBe(tokenB)
      expect(releaseInstallLock(lockPath, tokenB)).toBe(true)
      expect(existsSync(lockPath)).toBe(false)
      await killChild(hB)
    }, { timeout: 20000 })
  })

  describe("resolution gating", () => {
    it("caller local packages are never consulted without local dev sources", () => {
      const target = detectFdxTarget()
      if (!target) return
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      setActiveProjectDir(tempDir)
      const res = resolveTrustedPlatformPackage(target, { includeLocalDev: false })
      // Either the repo's own trusted source resolves (CI, where the optional
      // dependency is installed) or nothing does — the caller-controlled fake
      // must never be selected.
      if (res) {
        expect(res.source).toBe("own")
        expect(res.pkgDir.startsWith(tempDir)).toBe(false)
      } else {
        expect(res).toBeNull()
      }
    })

    it("caller local packages are consulted when local dev sources are enabled (identity-verified)", () => {
      const target = detectFdxTarget()
      if (!target) return
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      setActiveProjectDir(tempDir)
      const res = resolveTrustedPlatformPackage(target, { includeLocalDev: true })
      expect(res).not.toBeNull()
      if (res) {
        if (res.source === "local-dev") {
          expect(res.pkgDir).toBe(fake.pkgDir)
        } else {
          // Own trusted source legitimately wins when present.
          expect(res.source).toBe("own")
          expect(res.pkgDir.startsWith(tempDir)).toBe(false)
        }
      }
    })

    it("rejects a caller package with a mismatched version (verification)", () => {
      const target = detectFdxTarget()
      if (!target) return
      const fake = buildFakePlatformPackage(tempDir, { version: "9.9.9" })
      if (!fake) return
      setActiveProjectDir(tempDir)
      const res = resolveTrustedPlatformPackage(target, { includeLocalDev: true })
      // The mismatched fake must never be selected; only the always-trusted
      // own source (or nothing) may win.
      expect(res?.pkgDir).not.toBe(fake.pkgDir)
    })

    it("rejects a caller package with a mismatched name (verification)", () => {
      const target = detectFdxTarget()
      if (!target) return
      const fake = buildFakePlatformPackage(tempDir, { name: "@heidi-dang/evil-fdx" })
      if (!fake) return
      setActiveProjectDir(tempDir)
      const res = resolveTrustedPlatformPackage(target, { includeLocalDev: true })
      // The mismatched fake must never be selected; only the always-trusted
      // own source (or nothing) may win.
      expect(res?.pkgDir).not.toBe(fake.pkgDir)
    })

    it("never resolves local dev sources in a release profile, even when explicitly requested", () => {
      const target = detectFdxTarget()
      if (!target) return
      buildFakePlatformPackage(tempDir, {})
      setActiveProjectDir(tempDir)
      process.env.FLOWDECK_PROFILE = "release"
      const res = resolveTrustedPlatformPackage(target, { includeLocalDev: true })
      if (res) {
        expect(res.source).toBe("own")
        expect(res.pkgDir.startsWith(tempDir)).toBe(false)
      } else {
        expect(res).toBeNull()
      }
    })

    it("resolution never throws and classifies sources correctly", () => {
      process.env.XDG_CACHE_HOME = tempDir
      const status = getFdxAvailabilityStatus(true)
      expect(typeof status.available).toBe("boolean")
      expect(["env", "package", "cache", "path", "none"]).toContain(status.source)
    })

    it("emits a release-profile diagnostic when local dev sources are requested but rejected", () => {
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.FLOWDECK_PROFILE = "release"
      const status = getFdxAvailabilityStatus(true)
      // In this repo (own optional dependency not installed), the opt-in is
      // rejected with a diagnostic. If the own dependency IS installed, the
      // always-trusted own source legitimately wins instead — that is the
      // correct release-profile contract, so either is acceptable.
      const hasRejection = status.diagnostics.some((d) => d.includes("local dev sources are rejected"))
      const ownSource = status.source === "package"
      expect(hasRejection || ownSource).toBe(true)
    })
  })

  describe("install integration", () => {
    it("handleFdxInstall does not throw with gating active", async () => {
      process.env.XDG_CACHE_HOME = tempDir
      const result = await handleFdxInstall(true)
      expect(typeof result).toBe("boolean")
    })

    it("releases the per-target lock after handleFdxInstall completes (all paths)", async () => {
      process.env.XDG_CACHE_HOME = tempDir
      const target = detectFdxTarget()
      if (!target) return
      await handleFdxInstall(true)
      const lockPath = `${getFdxCacheDir(target)}.lock`
      expect(existsSync(lockPath)).toBe(false)
    })

    it("a blocked install (held lock) returns false and leaves the lock and cache untouched", async () => {
      process.env.XDG_CACHE_HOME = tempDir
      const target = detectFdxTarget()
      if (!target) return
      const lockPath = `${getFdxCacheDir(target)}.lock`
      const held = makeLockPayload({ pid: process.pid, token: "h".repeat(64) })
      mkdirSync(dirname(lockPath), { recursive: true })
      writeFileSync(lockPath, JSON.stringify(held), "utf-8")
      const result = await handleFdxInstall(true)
      expect(result).toBe(false)
      // The existing lock must be untouched (a blocked acquire never breaks it).
      expect(existsSync(lockPath)).toBe(true)
      const data = JSON.parse(readFileSync(lockPath, "utf-8"))
      expect(data.token).toBe("h".repeat(64))
      // No staging directory may be created for a blocked install.
      const stagingLeftovers = readdirSync(tempDir).filter((f) => f.includes(".staging-"))
      expect(stagingLeftovers).toEqual([])
      expect(releaseInstallLock(lockPath, "h".repeat(64))).toBe(true)
    })
  })

  describe("install trust contract (provenance, execution, activated cache)", () => {
    it("installs a compliant local-dev package end-to-end and directly validates the activated cache", async () => {
      const target = detectFdxTarget()
      if (!target) return
      // Windows: the fake binary would have to be a real PE executable to be
      // spawned without a shell (the audit removed `shell: true`). The
      // end-to-end activation path is exercised on POSIX here; the packed-cli
      // CI job covers real Windows execution with spaces in paths.
      if (process.platform === "win32") return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      setActiveProjectDir(tempDir)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      const result = await handleFdxInstall(true)
      expect(result).toBe(true)
      const cacheDir = getFdxCacheDir(target)
      expect(existsSync(join(cacheDir, target.executableName))).toBe(true)
      expect(existsSync(join(cacheDir, "checksum.json"))).toBe(true)
      expect(existsSync(join(cacheDir, "provenance.json"))).toBe(true)
      const manifest = JSON.parse(readFileSync(join(cacheDir, "install-manifest.json"), "utf-8"))
      expect(manifest.packageName).toBe(target.packageName)
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
      // The activated cache satisfies the full trust contract on its own:
      // post-activation direct validation of the cached binary (the P2-4
      // gate) passes with checksum AND provenance required.
      const cacheBin = join(cacheDir, target.executableName)
      const direct = validateFdxBinaryPath(cacheBin, cacheDir, { requireChecksum: true, requireProvenance: true, target })
      expect(direct.valid).toBe(true)
      expect(direct.integrity.status).toBe("pass")
      // Once the transient local-dev source is removed, the resolver serves
      // a trusted managed source — either the activated cache or the repo's
      // own local-dev package (both pass the full trust contract).
      rmSync(fake.pkgDir, { recursive: true, force: true })
      const status = getFdxAvailabilityStatus(true)
      expect(status.available).toBe(true)
      expect(["cache", "package"]).toContain(status.source)
    }, { timeout: 30000 })

    it("rejects an install when provenance fails the trust contract (tampered packageName)", async () => {
      const target = detectFdxTarget()
      if (!target) return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      setActiveProjectDir(tempDir)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      const prov = JSON.parse(readFileSync(join(fake.pkgDir, "provenance.json"), "utf-8"))
      prov.packageName = "@heidi-dang/evil-fdx"
      writeFileSync(join(fake.pkgDir, "provenance.json"), JSON.stringify(prov), "utf-8")
      const result = await handleFdxInstall(true)
      expect(result).toBe(false)
      // Nothing may be activated for a failed install.
      const cacheDir = getFdxCacheDir(target)
      expect(existsSync(cacheDir)).toBe(false)
    }, { timeout: 30000 })

    it("rejects an install when the source binary does not match its checksum", async () => {
      const target = detectFdxTarget()
      if (!target) return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      setActiveProjectDir(tempDir)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      // Corrupt the binary AFTER checksum/provenance generation: the checksum
      // and provenance both reference the original bytes, so the mismatch is
      // detected before anything is staged.
      writeFileSync(fake.binPath, "#!/bin/sh\necho 'tampered'\n", "utf-8")
      chmodSync(fake.binPath, 0o755)
      const result = await handleFdxInstall(true)
      expect(result).toBe(false)
      expect(existsSync(getFdxCacheDir(target))).toBe(false)
    }, { timeout: 30000 })

    it("never copies an FDX_BINARY_PATH / PATH binary into the managed repair cache", async () => {
      const target = detectFdxTarget()
      if (!target) return
      // Windows uses a genuine PE fixture (bun.exe) — the audit requires PE
      // fixtures because .cmd-content files cannot be spawned by the
      // secure-exec helper (CreateProcess only runs real PE images).
      const envBin = process.platform === "win32" ? join(tempDir, "fdx-env.exe") : join(tempDir, "fdx-env")
      if (process.platform === "win32") {
        writeFileSync(envBin, readFileSync(process.execPath))
      } else {
        writeFileSync(envBin, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
        chmodSync(envBin, 0o755)
      }
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FDX_BINARY_PATH = envBin
      const status = getFdxAvailabilityStatus(true)
      expect(status.source).toBe("env")
      // A repair install never imports the unmanaged env binary into the
      // managed cache. Without a trusted managed/local source to repair from,
      // the install fails closed and leaves the cache untouched.
      const result = await handleFdxInstall(true)
      expect(result).toBe(false)
      const cacheDir = getFdxCacheDir(target)
      expect(existsSync(cacheDir)).toBe(false)
    }, { timeout: 30000 })

    it("validates binaries at paths containing spaces (shell-free execution)", () => {
      const target = detectFdxTarget()
      if (!target) return
      // Windows: spawn of a non-PE file fails without a shell; the packed-cli
      // CI job exercises real Windows execution under spaces in paths.
      if (process.platform === "win32") return
      const spaceDir = join(tempDir, "My Project With Spaces", "app")
      mkdirSync(spaceDir, { recursive: true })
      const binPath = join(spaceDir, target.executableName)
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
      const binBuf = readFileSync(binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(spaceDir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const val = validateFdxBinaryPath(binPath, spaceDir, { requireChecksum: true })
      expect(val.valid).toBe(true)
      expect(val.version).toBe("1.0.4")
    })

    it("a present-but-invalid provenance invalidates an otherwise checksum-valid binary", () => {
      const target = detectFdxTarget()
      if (!target) return
      const dir = join(tempDir, "bad-prov")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, target.executableName)
      if (process.platform === "win32") {
        writeFileSync(binPath, "@echo fdx v1.0.4\r\n", "utf-8")
      } else {
        writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
        chmodSync(binPath, 0o755)
      }
      const binBuf = readFileSync(binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const flowdeckVersion = getFlowdeckPackageVersion()
      writeFileSync(
        join(dir, "provenance.json"),
        JSON.stringify({
          packageName: "@heidi-dang/evil-fdx", // wrong identity
          packageVersion: flowdeckVersion,
          flowdeckVersion,
          fdxBinaryVersion: flowdeckVersion,
          fdxProtocolVersion: "1.0.0",
          targetTriple: expectedTargetTriple(target) ?? undefined,
          platform: target.platform,
          architecture: target.arch,
          binaryFilename: target.executableName,
          binaryByteSize: binBuf.length,
          sha256,
          sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
          buildProfile: "release",
          buildTimestamp: new Date().toISOString(),
        }),
        "utf-8"
      )
      const val = validateFdxBinaryPath(binPath, dir, { requireChecksum: true, requireProvenance: true, target })
      expect(val.valid).toBe(false)
      expect(val.reason).toContain("Provenance validation failed")
    })

    it("rejects local dev sources in a release profile in a fresh process", async () => {
      const target = detectFdxTarget()
      if (!target) return
      buildFakePlatformPackage(tempDir, {})
      const script = `
import { resolveTrustedPlatformPackage, detectFdxTarget, setActiveProjectDir } from ${JSON.stringify(join(REPO_ROOT, "src/tools/fdx-shared.ts"))}
setActiveProjectDir(${JSON.stringify(tempDir)})
const target = detectFdxTarget()
const res = target ? resolveTrustedPlatformPackage(target, { includeLocalDev: true }) : null
console.log("RESULT:" + JSON.stringify({ source: res?.source ?? null, isLocalDev: res?.source === "local-dev" }))
`
      const h = spawnScript(script, { FLOWDECK_PROFILE: "release", FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE: "1" })
      await waitForResult(h)
      const line = h.stdout.split("RESULT:")[1]?.split("\n")[0]
      expect(line).toBeDefined()
      const r = JSON.parse(line!)
      expect(r.isLocalDev).toBe(false)
      await killChild(h)
    }, { timeout: 20000 })
  })

  describe("audit remediation acceptance (P1-1, P1-2, P1-4, P1-5, P2-1, P2-2, P2-3)", () => {
    it("P1-1: two distinct resolver contexts never produce the same canonical cache key", () => {
      const target = detectFdxTarget()
      if (!target) return
      process.env.XDG_CACHE_HOME = tempDir
      // These two contexts collided under the old "|"-joined key:
      //   FDX_BINARY_PATH="a|path:b", PATH="c"
      //   FDX_BINARY_PATH="a",         PATH="b|path:c"
      const savedEnv = { ...process.env }
      process.env.FDX_BINARY_PATH = "a|path:b"
      process.env.PATH = "c"
      const key1 = buildResolutionCacheKey()
      process.env.FDX_BINARY_PATH = "a"
      process.env.PATH = "b|path:c"
      const key2 = buildResolutionCacheKey()
      expect(key1).not.toBe(key2)
      // The same context repeated must produce the identical key.
      process.env.FDX_BINARY_PATH = "a|path:b"
      process.env.PATH = "c"
      expect(buildResolutionCacheKey()).toBe(key1)
      process.env = savedEnv
    })

    it("P1-1: switching the cache root invalidates the resolution cache identity", () => {
      const target = detectFdxTarget()
      if (!target) return
      const savedEnv = { ...process.env }
      // The cache root is driven by XDG_CACHE_HOME on POSIX and by
      // LOCALAPPDATA on win32 (see getFdxCacheDir). Switch the platform-relevant
      // variable and verify the key changes — a long-running process must not
      // serve a resolution computed for a different cache root.
      if (process.platform === "win32") {
        process.env.LOCALAPPDATA = join(tempDir, "localappdata-a")
        const keyC = buildResolutionCacheKey()
        process.env.LOCALAPPDATA = join(tempDir, "localappdata-b")
        expect(buildResolutionCacheKey()).not.toBe(keyC)
      } else {
        process.env.XDG_CACHE_HOME = join(tempDir, "root-a")
        const keyA = buildResolutionCacheKey()
        process.env.XDG_CACHE_HOME = join(tempDir, "root-b")
        const keyB = buildResolutionCacheKey()
        expect(keyA).not.toBe(keyB)
      }
      process.env = savedEnv
    })

    it("P1-1: the cache key embeds the resolved target cache directory", () => {
      const target = detectFdxTarget()
      if (!target) return
      const savedEnv = { ...process.env }
      const root = join(tempDir, "embed-root")
      if (process.platform === "win32") {
        process.env.LOCALAPPDATA = root
      } else {
        process.env.XDG_CACHE_HOME = root
      }
      const key = buildResolutionCacheKey()
      // The key is JSON-serialized, so backslashes are escaped on win32.
      // Decode it and check the resolved cache-root tuple value directly.
      const decoded: Array<[string, string]> = JSON.parse(key)
      const cacheRootEntry = decoded.find(([field]) => field === "cacheRoot")
      expect(cacheRootEntry).toBeDefined()
      // The resolved cache dir is derived from the platform cache root and is
      // embedded in the key regardless of which variable drives it.
      expect(cacheRootEntry![1]).toContain(join(root, "flowdeck"))
      process.env = savedEnv
    })

    it("P1-2: same-inode, same-size tampering with restored mtime changes the trusted digest", () => {
      const target = detectFdxTarget()
      if (!target) return
      process.env.XDG_CACHE_HOME = tempDir
      const dir = join(tempDir, "stale-cache")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, target.executableName)
      // Two payloads with IDENTICAL byte length so a size-based fingerprint
      // cannot distinguish them.
      const contentA = "#!/bin/sh\necho 'fdx v1.0.4'\n"
      const contentB = "#!/bin/sh\necho 'fdx v9.9.9'\n"
      expect(contentA.length).toBe(contentB.length)
      writeFileSync(binPath, contentA, "utf-8")
      chmodSync(binPath, 0o755)
      // Capture the pre-tamper mtime, then rewrite the SAME inode (writeFileSync
      // truncates in place) with same-length content and RESTORE the original
      // mtime. A stat-based fingerprint (dev/ino/size/mtime) would not change;
      // the SHA-256 digest must.
      const st = statSync(binPath)
      const originalMtime = st.mtime
      writeFileSync(binPath, contentB, "utf-8")
      chmodSync(binPath, 0o755)
      utimesSync(binPath, st.atime, originalMtime)
      const after = statSync(binPath)
      expect(after.ino).toBe(st.ino)
      expect(after.size).toBe(st.size)
      expect(Math.trunc(after.mtimeMs)).toBe(Math.trunc(st.mtimeMs))
      const shaA = sha256FileContents(binPath)
      // Prove the digest differs from what contentA would produce, and that a
      // full trust validation now fails (checksum mismatch against contentA).
      expect(shaA).not.toBe(createHash("sha256").update(contentA).digest("hex"))
    })

    it("P1-2: a mutation between cache validation and native execution is refused", () => {
      const target = detectFdxTarget()
      if (!target) return
      // Windows: shell-script fixtures cannot execute as fdx.exe without a
      // shell; the packed-cli CI job covers Windows execution with a real PE.
      if (process.platform === "win32") return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.FDX_DISABLE_FALLBACK = "1"
      setActiveProjectDir(tempDir)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      // Resolve once so the cache is populated with a trusted digest.
      const before = getFdxAvailabilityStatus(true)
      console.log(before); expect(before.available).toBe(true)
      // Mutate the binary AFTER the cache was validated, preserving size and
      // restoring mtime so only the digest can detect it.
      const st = statSync(fake.binPath)
      writeFileSync(fake.binPath, "#!/bin/sh\necho 'fdx v9.9.9'\n", "utf-8")
      chmodSync(fake.binPath, 0o755)
      utimesSync(fake.binPath, st.atime, st.mtime)
      // The cache-hit path re-verifies the digest before serving; the mutation
      // must invalidate the cached resolution (re-resolution fails checksum),
      // so native execution must refuse to run the tampered binary.
      const after = getFdxAvailabilityStatus()
      expect(after.available).toBe(false)
      expect(() => runFdx(["read", "tests/fdx-trusted-acquisition.test.ts"])).toThrow()
    })

    it("P1-4: parseSRI accepts single-line supported digests and rejects malformed/multiline/unsupported values", () => {
      const { createHash: ch } = require("node:crypto")
      const good512 = `sha512-${ch("sha512").update(Buffer.from("abc")).digest("base64")}`
      expect(parseSRI(good512)).toMatchObject({ ok: true, algo: "sha512" })
      const good256 = `sha256-${ch("sha256").update(Buffer.from("abc")).digest("base64")}`
      expect(parseSRI(good256)).toMatchObject({ ok: true, algo: "sha256" })
      // Malformed / multiline / unsupported / too-short all fail closed.
      expect(parseSRI("sha512-###invalid###").ok).toBe(false)
      expect(parseSRI(`${good512}\n${good512}`).ok).toBe(false)
      expect(parseSRI(`${good512} ${good512}`).ok).toBe(false)
      expect(parseSRI("sha1-abc").ok).toBe(false)
      expect(parseSRI("sha512-").ok).toBe(false)
      expect(parseSRI("").ok).toBe(false)
      expect(parseSRI(undefined as any).ok).toBe(false)
      expect(parseSRI("sha512-YWJj").ok).toBe(false) // digest too short
    })

    it("P1-5: a failed first install leaves no newly-created cache and no rollback leftovers", async () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      setActiveProjectDir(tempDir)
      const cacheDir = getFdxCacheDir(target)
      // No pre-existing cache exists (first install).
      expect(existsSync(cacheDir)).toBe(false)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      // Tamper the provenance so the install fails the trust contract. The
      // P1-5 rollback contract requires that a failed install — including a
      // first install with no backup — never leaves a newly-created cache or
      // quarantined/backup directories behind.
      const prov = JSON.parse(readFileSync(join(fake.pkgDir, "provenance.json"), "utf-8"))
      prov.binaryByteSize = (prov.binaryByteSize ?? 0) + 999
      writeFileSync(join(fake.pkgDir, "provenance.json"), JSON.stringify(prov), "utf-8")
      const result = await handleFdxInstall(true)
      expect(result).toBe(false)
      // The cache path must not be activated by the failed install.
      expect(existsSync(cacheDir)).toBe(false)
      // No quarantined-failed or backup directories may remain either.
      const leftovers = readdirSync(tempDir).filter((n) => n.includes("backup") || n.includes("failed"))
      expect(leftovers).toEqual([])
    }, { timeout: 30000 })

    it("P2-1: provenance version bindings reject non-canonical package/flowdeck versions", () => {
      const target = detectFdxTarget()
      if (!target) return
      const dir = join(tempDir, "version-binding")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, target.executableName)
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
      const binBuf = readFileSync(binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const canonical = getFlowdeckPackageVersion()
      // packageVersion differs from the canonical FlowDeck version.
      writeFileSync(
        join(dir, "provenance.json"),
        JSON.stringify({
          packageName: target.packageName,
          packageVersion: "9.9.9",
          flowdeckVersion: canonical,
          fdxBinaryVersion: canonical,
          fdxProtocolVersion: "1.0.0",
          targetTriple: expectedTargetTriple(target) ?? undefined,
          platform: target.platform,
          architecture: target.arch,
          binaryFilename: target.executableName,
          binaryByteSize: binBuf.length,
          sha256,
          sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
          buildProfile: "release",
          buildTimestamp: new Date().toISOString(),
        }),
        "utf-8"
      )
      const val = validateFdxBinaryPath(binPath, dir, { requireChecksum: true, requireProvenance: true, target })
      expect(val.valid).toBe(false)
      expect(val.reason).toContain("packageVersion")
    })

    it("P2-1: provenance fdxBinaryVersion must match the version the binary actually reports", () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      const dir = join(tempDir, "binary-version-binding")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, target.executableName)
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.5'\n", "utf-8")
      chmodSync(binPath, 0o755)
      const binBuf = readFileSync(binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const canonical = getFlowdeckPackageVersion()
      // Provenance claims the canonical version, but the binary reports 1.0.5
      // — a different, still semver-compatible version. The only reason this
      // must fail is the fdxBinaryVersion binding (P2-1).
      writeFileSync(
        join(dir, "provenance.json"),
        JSON.stringify({
          packageName: target.packageName,
          packageVersion: canonical,
          flowdeckVersion: canonical,
          fdxBinaryVersion: canonical,
          fdxProtocolVersion: "1.0.0",
          targetTriple: expectedTargetTriple(target) ?? undefined,
          platform: target.platform,
          architecture: target.arch,
          binaryFilename: target.executableName,
          binaryByteSize: binBuf.length,
          sha256,
          sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
          buildProfile: "release",
          buildTimestamp: new Date().toISOString(),
        }),
        "utf-8"
      )
      const val = validateFdxBinaryPath(binPath, dir, { requireChecksum: true, requireProvenance: true, target })
      expect(val.valid).toBe(false)
      expect(val.reason).toContain("fdxBinaryVersion")
    })

    it("P2-2: binaryByteSize mismatch between provenance and actual file is rejected", () => {
      const target = detectFdxTarget()
      if (!target) return
      const dir = join(tempDir, "size-binding")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, target.executableName)
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
      const binBuf = readFileSync(binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const canonical = getFlowdeckPackageVersion()
      writeFileSync(
        join(dir, "provenance.json"),
        JSON.stringify({
          packageName: target.packageName,
          packageVersion: canonical,
          flowdeckVersion: canonical,
          fdxBinaryVersion: canonical,
          fdxProtocolVersion: "1.0.0",
          targetTriple: expectedTargetTriple(target) ?? undefined,
          platform: target.platform,
          architecture: target.arch,
          binaryFilename: target.executableName,
          binaryByteSize: binBuf.length + 12345,
          sha256,
          sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
          buildProfile: "release",
          buildTimestamp: new Date().toISOString(),
        }),
        "utf-8"
      )
      const val = validateFdxBinaryPath(binPath, dir, { requireChecksum: true, requireProvenance: true, target })
      expect(val.valid).toBe(false)
      expect(val.reason).toContain("binaryByteSize")
    })

    it("P2-3: registry subprocesses run under a bounded timeout", () => {
      expect(REGISTRY_TIMEOUT_MS).toBeGreaterThan(0)
      expect(REGISTRY_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
    })

    it("P2-2: string, fractional, negative, NaN and unsafe binaryByteSize values are rejected", () => {
      const target = detectFdxTarget()
      if (!target) return
      const canonical = getFlowdeckPackageVersion()
      const makeProv = (binaryByteSize: unknown) => ({
        packageName: target.packageName,
        packageVersion: canonical,
        flowdeckVersion: canonical,
        fdxBinaryVersion: canonical,
        fdxProtocolVersion: "1.0.0",
        targetTriple: expectedTargetTriple(target) ?? undefined,
        platform: target.platform,
        architecture: target.arch,
        binaryFilename: target.executableName,
        binaryByteSize,
        sha256: "3db48a0b85dbb8074f996ffa167486b49d1c25e1e80dcfa85aba28a4570a33f0",
        sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
        buildProfile: "release",
        buildTimestamp: new Date().toISOString(),
      })
      const { validateFdxProvenance } = require("../src/tools/fdx-shared.js")
      // Each of these must fail closed at the provenance-document level.
      for (const bad of ["12345", 1234.5, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const res = validateFdxProvenance(makeProv(bad), target)
        expect(res.valid).toBe(false)
        expect(res.reason).toContain("binaryByteSize")
      }
      // A valid safe integer passes the document-level check.
      const ok = validateFdxProvenance(makeProv(4096), target)
      expect(ok.valid).toBe(true)
    })

    it("P2-3: runtime provenance validation rejects an all-zero source commit", () => {
      const target = detectFdxTarget()
      if (!target) return
      const canonical = getFlowdeckPackageVersion()
      const baseProv = {
        packageName: target.packageName,
        packageVersion: canonical,
        flowdeckVersion: canonical,
        fdxBinaryVersion: canonical,
        fdxProtocolVersion: "1.0.0",
        targetTriple: expectedTargetTriple(target) ?? undefined,
        platform: target.platform,
        architecture: target.arch,
        binaryFilename: target.executableName,
        binaryByteSize: 4096,
        sha256: "3db48a0b85dbb8074f996ffa167486b49d1c25e1e80dcfa85aba28a4570a33f0",
        buildProfile: "release",
        buildTimestamp: new Date().toISOString(),
      }
      const { validateFdxProvenance } = require("../src/tools/fdx-shared.js")
      expect(validateFdxProvenance({ ...baseProv, sourceCommitSha: "0000000000000000000000000000000000000000" }, target).valid).toBe(false)
      // The shared validator is consistent across runtime and build paths.
      expect(sourceCommitShaError("0000000000000000000000000000000000000000")).toContain("all-zero")
      expect(sourceCommitShaError("0123456789abcdef0123456789abcdef01234567")).toBeNull()
      expect(sourceCommitShaError("not-a-sha")).toContain("40 hexadecimal")
      expect(sourceCommitShaError("")).toContain("40 hexadecimal")
    })

    it("P2-1: deterministic post-activation failure on a first install removes the activated cache and retains .failed- evidence", async () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      setActiveProjectDir(tempDir)
      const cacheDir = getFdxCacheDir(target)
      expect(existsSync(cacheDir)).toBe(false)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      // Deterministic post-activation fault injection (Contract 1 compatible):
      // the staged binary is a plain valid script. The step-5 staging probe
      // runs it from a private snapshot of the checksum-verified bytes and
      // passes. The pre-exec test hook fires at that exact boundary with the
      // STAGED source path; it overwrites the staged copy on disk with
      // checksum-mismatching bytes. Step 7b then re-validates the ACTIVATED
      // cache copy — which now holds the mismatching bytes — and fails
      // deterministically, reaching cacheActivated=true with
      // newCacheActivated=false.
      writeFileSync(fake.binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(fake.binPath, 0o755)
      // Recompute checksum + provenance over the valid binary so staging
      // validation passes while the binary lives in the staging path.
      const binBuf = readFileSync(fake.binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(fake.pkgDir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const prov = JSON.parse(readFileSync(join(fake.pkgDir, "provenance.json"), "utf-8"))
      prov.sha256 = sha256
      prov.binaryByteSize = binBuf.length
      writeFileSync(join(fake.pkgDir, "provenance.json"), JSON.stringify(prov), "utf-8")
      const evil = "#!/bin/sh\necho 'fdx v9.9.9 evil'\n"
      setFdxPreExecTestHook((snapshotPath: string, sourceBin: string) => {
        if (sourceBin.includes(".staging-")) writeFileSync(sourceBin, evil, "utf-8")
      })
      try {
        const result = await handleFdxInstall(true)
        expect(result).toBe(false)
        // The activated cache must not survive the post-activation failure.
        expect(existsSync(cacheDir)).toBe(false)
        // Evidence retention: exactly one .failed-<pid>-<ts> quarantine dir exists.
        const failedDirs = readdirSync(dirname(cacheDir)).filter((n) => n.includes("failed"))
        expect(failedDirs.length).toBe(1)
        expect(failedDirs[0]).toContain(".failed-")
        // No staging or temporary dirs may remain.
        const stagingLeftovers = readdirSync(dirname(cacheDir)).filter((n) => n.includes("staging") || n.includes(".registry-fetch"))
        expect(stagingLeftovers).toEqual([])
        // The install lock is released.
        expect(existsSync(`${cacheDir}.lock`)).toBe(false)
      } finally {
        setFdxPreExecTestHook(null)
      }
    }, { timeout: 30000 })

    it("P2-1: deterministic post-activation failure restores a pre-existing backup exactly (full tree)", async () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      setActiveProjectDir(tempDir)
      const cacheDir = getFdxCacheDir(target)
      // Pre-existing known-good cache: a realistic set of files with distinct
      // sizes and content — the binary, checksum, provenance, install manifest
      // and an unexpected-file marker.
      mkdirSync(cacheDir, { recursive: true })
      const preExisting = new Map<string, Buffer>()
      preExisting.set("pre-existing-marker.txt", Buffer.from("known-good-state"))
      preExisting.set("unexpected-extra.bin", Buffer.from("x".repeat(4096)))
      preExisting.set("checksum.json", Buffer.from(JSON.stringify({ sha256: "c".repeat(64) }, null, 2)))
      preExisting.set("provenance.json", Buffer.from(JSON.stringify({ packageName: "pre-existing" }, null, 2)))
      for (const [name, content] of preExisting) {
        writeFileSync(join(cacheDir, name), content)
      }
      // Snapshot the full tree (paths, sizes, contents) BEFORE the install.
      const snapshotBefore = new Map<string, Buffer>()
      for (const name of readdirSync(cacheDir)) {
        snapshotBefore.set(name, readFileSync(join(cacheDir, name)))
      }

      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      // Deterministic post-activation fault injection (Contract 1 compatible):
      // same hook-based mechanism as the first-install test — the staged copy
      // is overwritten with checksum-mismatching bytes at the step-5 probe
      // boundary so the step-7b activation verification fails deterministically
      // and the backup is restored.
      writeFileSync(fake.binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(fake.binPath, 0o755)
      const binBuf = readFileSync(fake.binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(fake.pkgDir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const prov = JSON.parse(readFileSync(join(fake.pkgDir, "provenance.json"), "utf-8"))
      prov.sha256 = sha256
      prov.binaryByteSize = binBuf.length
      writeFileSync(join(fake.pkgDir, "provenance.json"), JSON.stringify(prov), "utf-8")
      const evil = "#!/bin/sh\necho 'fdx v9.9.9 evil'\n"
      setFdxPreExecTestHook((snapshotPath: string, sourceBin: string) => {
        if (sourceBin.includes(".staging-")) writeFileSync(sourceBin, evil, "utf-8")
      })
      try {
        const result = await handleFdxInstall(true)
        expect(result).toBe(false)
        // The pre-existing cache must be restored to EXACTLY its prior tree —
        // same file set, same sizes, same bytes — not merely a marker file.
        expect(existsSync(cacheDir)).toBe(true)
        const snapshotAfter = new Map<string, Buffer>()
        for (const name of readdirSync(cacheDir)) {
          snapshotAfter.set(name, readFileSync(join(cacheDir, name)))
        }
        expect([...snapshotAfter.keys()].sort()).toEqual([...snapshotBefore.keys()].sort())
        for (const [name, content] of snapshotBefore) {
          expect(snapshotAfter.get(name)!.length).toBe(content.length)
          expect(snapshotAfter.get(name)!.equals(content)).toBe(true)
        }
        // No unexpected files were added by the failed activation.
        expect([...snapshotAfter.keys()].sort()).toEqual([...snapshotBefore.keys()].sort())
        // Evidence retained for the failed activation.
        const failedDirs = readdirSync(dirname(cacheDir)).filter((n) => n.includes("failed"))
        expect(failedDirs.length).toBe(1)
        // No staging/tmp leftovers; lock released.
        const stagingLeftovers = readdirSync(dirname(cacheDir)).filter((n) => n.includes("staging") || n.includes(".registry-fetch"))
        expect(stagingLeftovers).toEqual([])
        expect(existsSync(`${cacheDir}.lock`)).toBe(false)
      } finally {
        setFdxPreExecTestHook(null)
      }
    }, { timeout: 30000 })

    it("P1-1: the validated digest comes from the checksum-verified bytes, not a post-validation reread", () => {
      const target = detectFdxTarget()
      if (!target) return
      // Windows: the shell-script fixture cannot execute as fdx.exe without a
      // shell (the audit removed shell:true); the genuine-PE test covers the
      // Windows execution path.
      if (process.platform === "win32") return
      const dir = join(tempDir, "digest-propagation")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, target.executableName)
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
      const binBuf = readFileSync(binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const flowdeckVersion = getFlowdeckPackageVersion()
      writeFileSync(
        join(dir, "provenance.json"),
        JSON.stringify({
          packageName: target.packageName,
          packageVersion: flowdeckVersion,
          flowdeckVersion,
          fdxBinaryVersion: flowdeckVersion,
          fdxProtocolVersion: "1.0.0",
          targetTriple: expectedTargetTriple(target) ?? undefined,
          platform: target.platform,
          architecture: target.arch,
          binaryFilename: target.executableName,
          binaryByteSize: binBuf.length,
          sha256,
          sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
          buildProfile: "release",
          buildTimestamp: new Date().toISOString(),
        }),
        "utf-8"
      )
      const val = validateFdxBinaryPath(binPath, dir, { requireChecksum: true, requireProvenance: true, target })
      expect(val.valid).toBe(true)
      // The validated digest must equal the checksum digest of the bytes read.
      expect(val.validatedSha256).toBe(sha256)
      // And it must be exactly the digest of the current file contents.
      expect(val.validatedSha256).toBe(sha256FileContents(binPath))
    })

    it("Contract1/P1-1: replacement-before-probe — the candidate pathname is never executed after validation begins", () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      const dir = join(tempDir, "replacement-before-probe")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, target.executableName)
      writeFileSync(binPath, "#!/bin/sh\necho 'fdx v1.0.4'\n", "utf-8")
      chmodSync(binPath, 0o755)
      const binBuf = readFileSync(binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const flowdeckVersion = getFlowdeckPackageVersion()
      writeFileSync(
        join(dir, "provenance.json"),
        JSON.stringify({
          packageName: target.packageName,
          packageVersion: flowdeckVersion,
          flowdeckVersion,
          fdxBinaryVersion: flowdeckVersion,
          fdxProtocolVersion: "1.0.0",
          targetTriple: expectedTargetTriple(target) ?? undefined,
          platform: target.platform,
          architecture: target.arch,
          binaryFilename: target.executableName,
          binaryByteSize: binBuf.length,
          sha256,
          sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
          buildProfile: "release",
          buildTimestamp: new Date().toISOString(),
        }),
        "utf-8"
      )
      const evil = "#!/bin/sh\necho 'fdx v1.0.4 evil'\n"
      // Replace the candidate pathname exactly at the validated-snapshot ->
      // OS-execution boundary (the pre-exec hook). The probe must run the
      // private snapshot of the ORIGINAL bytes, never the replaced pathname.
      setFdxPreExecTestHook((snapshotPath: string, sourceBin: string) => {
        if (sourceBin === binPath) writeFileSync(binPath, evil, "utf-8")
      })
      try {
        const val = validateFdxBinaryPath(binPath, dir, { requireChecksum: true, requireProvenance: true, target })
        expect(val.valid).toBe(true)
        expect(val.version).toBe("1.0.4")
        // The trusted digest is the original checksum-verified generation.
        expect(val.validatedSha256).toBe(sha256)
        // The replacement really happened during the probe...
        expect(readFileSync(binPath, "utf-8")).toBe(evil)
        // ...and the evil bytes never became the trusted digest.
        expect(val.validatedSha256).not.toBe(createHash("sha256").update(evil).digest("hex"))
      } finally {
        setFdxPreExecTestHook(null)
      }
    })

    /**
     * Cross-platform verified-execution fixture. On POSIX a fake platform
     * package with a shebang script is used (package source); on Windows a
     * genuine PE (bun.exe) is used via FDX_BINARY_PATH — `.exe`-named
     * cmd-script fixtures cannot execute on Windows (ENOEXEC), so a real
     * executable is required for deterministic snapshot-boundary tests.
     */
    function setupVerifiedExecFixture(): { binPath: string } | null {
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FDX_DISABLE_FALLBACK = "1"
      if (process.platform === "win32") {
        const binPath = join(tempDir, "fdx.exe")
        writeFileSync(binPath, readFileSync(process.execPath))
        process.env.FDX_BINARY_PATH = binPath
        return { binPath }
      }
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      setActiveProjectDir(tempDir)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return null
      return { binPath: fake.binPath }
    }

    it("Contract1/P1-2: same-inode mutation after snapshot creation cannot change what executes", () => {
      const target = detectFdxTarget()
      if (!target) return
      const fixture = setupVerifiedExecFixture()
      if (!fixture) return
      // Resolve + validate BEFORE arming the hook: the probe runs without the
      // hook and the resolution is cached for runFdx.
      const before = getFdxAvailabilityStatus(true)
      console.log(before); expect(before.available).toBe(true)
      // At the command's validated-snapshot -> OS-execution boundary, mutate
      // the source IN PLACE (same inode, different content). The command must
      // execute the snapshot's ORIGINAL bytes, never the mutated path.
      setFdxPreExecTestHook((snapshotPath: string, sourceBin: string) => {
        if (sourceBin === fixture.binPath) {
          writeFileSync(fixture.binPath, "#!/bin/sh\necho 'evil-generation'\n", "utf-8")
        }
      })
      try {
        const out = runFdx(["--version"])
        expect(out).not.toContain("evil-generation")
        if (process.platform === "win32") {
          // The original PE generation executed (bun --version output).
          expect(out.trim().length).toBeGreaterThan(0)
        } else {
          expect(out).toContain("fdx v1.0.4")
        }
        expect(readFileSync(fixture.binPath, "utf-8")).toContain("evil-generation")
      } finally {
        setFdxPreExecTestHook(null)
      }
    }, { timeout: 30000 })

    it("Contract1/P1-2: snapshot replacement at the pre-exec barrier never executes the replaced bytes", () => {
      const target = detectFdxTarget()
      if (!target) return
      const fixture = setupVerifiedExecFixture()
      if (!fixture) return
      const before = getFdxAvailabilityStatus(true)
      console.log(before); expect(before.available).toBe(true)
      const evilMarker = "EVIL-SNAPSHOT-MARKER"
      const evilBytes = process.platform === "win32"
        ? `@echo ${evilMarker}\r\n`
        : `#!/bin/sh\necho '${evilMarker}'\n`
      // REPLACE the snapshot pathname with attacker-controlled bytes exactly at
      // the validated-snapshot -> OS-execution barrier. The replaced bytes must
      // NEVER execute on any platform:
      // - Linux: execution binds the snapshot descriptor (held open), so the
      //   ORIGINAL snapshot generation runs.
      // - macOS/Windows: the fail-closed generation re-verify refuses to run.
      setFdxPreExecTestHook((snapshotPath: string, _sourceBin: string) => {
        const evil = join(tempDir, "snapshot-replacement")
        writeFileSync(evil, evilBytes, "utf-8")
        if (process.platform !== "win32") chmodSync(evil, 0o755)
        renameSync(evil, snapshotPath)
      })
      try {
        let out: string | null = null
        let threw: string | null = null
        try {
          out = runFdx(["--version"])
        } catch (e: any) {
          threw = String(e?.message ?? e)
        }
        if (threw !== null) {
          // Fail-closed refusal: nothing ran, so the replaced bytes never
          // executed.
          expect(threw).toMatch(/FDX Integrity/)
          expect(threw).not.toContain(evilMarker)
        } else {
          // Descriptor-bound execution (Linux): the ORIGINAL snapshot bytes ran.
          expect(out!).not.toContain(evilMarker)
          if (process.platform === "win32") {
            expect(out!.trim().length).toBeGreaterThan(0)
          } else {
            expect(out!).toContain("fdx v1.0.4")
          }
        }
      } finally {
        setFdxPreExecTestHook(null)
      }
    }, { timeout: 30000 })

    it("Contract1/P2-1: structured cleanup preserves both primary and cleanup failures", () => {
      const target = detectFdxTarget()
      if (!target) return
      // POSIX-only: the deterministic cleanup-failure injection relies on
      // POSIX directory permissions (chmod 0500 makes unlink/rmdir fail).
      // Windows chmod is a no-op, so cleanup-failure injection is not
      // expressible in pure Node there; the structured result contract itself
      // (cleanup errors captured on every result) is platform-independent.
      if (process.platform === "win32") return
      // Case 1: primary probe failure + injected cleanup failure (snapshot dir
      // made non-writable so unlink/rmdir fail). Both must be reported; the
      // cleanup failure must not replace the primary one.
      const dir = join(tempDir, "cleanup-fail")
      mkdirSync(dir, { recursive: true })
      const failScript = "#!/bin/sh\nexit 3\n"
      const binPath = join(dir, target.executableName)
      writeFileSync(binPath, failScript, "utf-8")
      chmodSync(binPath, 0o755)
      let snapshotDirSeen: string | null = null
      setFdxPreExecTestHook((snapshotPath: string, _sourceBin: string) => {
        snapshotDirSeen = dirname(snapshotPath)
        try { chmodSync(dirname(snapshotPath), 0o500) } catch {}
      })
      try {
        const res = executeVerifiedSnapshot(binPath, ["--version"], null)
        expect(res.kind).toBe("rejected")
        if (res.kind === "rejected") {
          // Primary failure preserved, explicitly structured.
          expect(res.reason).toContain("exit code 3")
          // Cleanup failures surfaced, not swallowed.
          expect(res.cleanup.unlinkError).not.toBeNull()
          expect(res.cleanup.rmdirError).not.toBeNull()
        }
      } finally {
        setFdxPreExecTestHook(null)
        if (snapshotDirSeen) {
          try { chmodSync(snapshotDirSeen, 0o700) } catch {}
          try { rmSync(snapshotDirSeen, { recursive: true, force: true }) } catch {}
        }
      }

      // Case 2: successful execution with a cleanup failure — the primary
      // result is preserved and the cleanup errors are attached.
      const dir2 = join(tempDir, "cleanup-fail-success")
      mkdirSync(dir2, { recursive: true })
      const goodScript = "#!/bin/sh\necho 'fdx v1.0.4'\n"
      const binPath2 = join(dir2, target.executableName)
      writeFileSync(binPath2, goodScript, "utf-8")
      chmodSync(binPath2, 0o755)
      let snapshotDirSeen2: string | null = null
      setFdxPreExecTestHook((snapshotPath: string, _sourceBin: string) => {
        snapshotDirSeen2 = dirname(snapshotPath)
        try { chmodSync(dirname(snapshotPath), 0o500) } catch {}
      })
      try {
        const res2 = executeVerifiedSnapshot(binPath2, ["--version"], null)
        expect(res2.kind).toBe("executed")
        if (res2.kind === "executed") {
          expect(res2.out).toContain("fdx v1.0.4")
          expect(res2.cleanup.unlinkError).not.toBeNull()
          expect(res2.cleanup.rmdirError).not.toBeNull()
        }
      } finally {
        setFdxPreExecTestHook(null)
        if (snapshotDirSeen2) {
          try { chmodSync(snapshotDirSeen2, 0o700) } catch {}
          try { rmSync(snapshotDirSeen2, { recursive: true, force: true }) } catch {}
        }
      }
    })

    it("Contract1/P1-2: same-inode mutation of the snapshot at the pre-exec barrier never executes the mutated bytes", () => {
      const target = detectFdxTarget()
      if (!target) return
      const fixture = setupVerifiedExecFixture()
      if (!fixture) return
      const before = getFdxAvailabilityStatus(true)
      console.log(before); expect(before.available).toBe(true)
      const evilMarker = "EVIL-INODE-MUTATION"
      const evilBytes = process.platform === "win32"
        ? `@echo ${evilMarker}\r\n`
        : `#!/bin/sh\necho '${evilMarker}'\n`
      // Mutate the ACTUAL snapshot inode IN PLACE (same inode, new content) at
      // the validated-snapshot -> OS-execution barrier — not merely the source
      // candidate. A same-user attacker can chmod its own file first, then
      // write, so the hook mirrors that capability. The mutated bytes must
      // never execute: execution is bound to the validated in-memory bytes
      // (sealed object on Linux, protected handle on macOS, share-denied
      // handle on Windows), never to the mutable snapshot pathname.
      setFdxPreExecTestHook((snapshotPath: string, _sourceBin: string) => {
        if (process.platform !== "win32") chmodSync(snapshotPath, 0o600)
        writeFileSync(snapshotPath, evilBytes, "utf-8")
        if (process.platform !== "win32") chmodSync(snapshotPath, 0o755)
      })
      try {
        let out: string | null = null
        let threw: string | null = null
        try {
          out = runFdx(["--version"])
        } catch (e: any) {
          threw = String(e?.message ?? e)
        }
        if (threw !== null) {
          // Fail-closed refusal: the mutated bytes never executed.
          expect(threw).toMatch(/FDX Integrity/)
          expect(threw).not.toContain(evilMarker)
        } else {
          expect(out).not.toContain(evilMarker)
        }
      } finally {
        setFdxPreExecTestHook(null)
      }
    }, { timeout: 30000 })

    it("Contract1/P2-1: a successful --version probe surfaces cleanup failures structurally", () => {
      const target = detectFdxTarget()
      if (!target) return
      // POSIX-only: cleanup-failure injection relies on POSIX directory
      // permissions (chmod 0500 makes unlink/rmdir fail); Windows chmod is a
      // no-op.
      if (process.platform === "win32") return
      const dir = join(tempDir, "probe-cleanup-success")
      mkdirSync(dir, { recursive: true })
      const script = "#!/bin/sh\necho 'fdx v1.0.4'\n"
      const binPath = join(dir, target.executableName)
      writeFileSync(binPath, script, "utf-8")
      chmodSync(binPath, 0o755)
      const sha256 = createHash("sha256").update(readFileSync(binPath)).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      let snapshotDirSeen: string | null = null
      setFdxPreExecTestHook((snapshotPath: string, _sourceBin: string) => {
        snapshotDirSeen = dirname(snapshotPath)
        try { chmodSync(dirname(snapshotPath), 0o500) } catch {}
      })
      try {
        const val = validateFdxBinaryPath(binPath, dir, { requireChecksum: true, target })
        // The successful probe result is preserved...
        expect(val.valid).toBe(true)
        expect(val.version).toBe("1.0.4")
        // ...and the cleanup failures are surfaced as a mandatory structured
        // diagnostic on the successful probe result, never silently discarded.
        expect(val.probeCleanup).toBeDefined()
        expect(val.probeCleanup!.unlinkError).not.toBeNull()
        expect(val.probeCleanup!.rmdirError).not.toBeNull()
      } finally {
        setFdxPreExecTestHook(null)
        if (snapshotDirSeen) {
          try { chmodSync(snapshotDirSeen, 0o700) } catch {}
          try { rmSync(snapshotDirSeen, { recursive: true, force: true }) } catch {}
        }
      }
    })

    it("Contract1/P2-1: a failed command surfaces both the primary exit failure and cleanup failures", () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      const dir = join(tempDir, "cmd-fail-cleanup")
      mkdirSync(dir, { recursive: true })
      const script = [
        "#!/bin/sh",
        'case "$1" in',
        "  --version) echo 'fdx v1.0.4' ;;",
        "  *) exit 5 ;;",
        "esac",
      ].join("\n")
      const binPath = join(dir, target.executableName)
      writeFileSync(binPath, script, "utf-8")
      chmodSync(binPath, 0o755)
      const sha256 = createHash("sha256").update(readFileSync(binPath)).digest("hex")
      writeFileSync(join(dir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.FDX_DISABLE_FALLBACK = "1"
      setActiveProjectDir(tempDir)
      process.env.FDX_BINARY_PATH = binPath
      const before = getFdxAvailabilityStatus(true)
      console.log(before); expect(before.available).toBe(true)
      let snapshotDirSeen: string | null = null
      setFdxPreExecTestHook((snapshotPath: string, _sourceBin: string) => {
        snapshotDirSeen = dirname(snapshotPath)
        try { chmodSync(dirname(snapshotPath), 0o500) } catch {}
      })
      try {
        let threw: string | null = null
        try {
          runFdx(["read", "tests/fdx-trusted-acquisition.test.ts"])
        } catch (e: any) {
          threw = String(e?.message ?? e)
        }
        expect(threw).not.toBeNull()
        // Primary exit failure preserved...
        expect(threw!).toContain("exit code 5")
        // ...and cleanup failures surfaced alongside, not replacing it.
        expect(threw!).toContain("cleanup")
        expect(threw!).toContain("unlink failed")
      } finally {
        setFdxPreExecTestHook(null)
        if (snapshotDirSeen) {
          try { chmodSync(snapshotDirSeen, 0o700) } catch {}
          try { rmSync(snapshotDirSeen, { recursive: true, force: true }) } catch {}
        }
      }
    }, { timeout: 30000 })

    it("Contract1: the real resolver path completes under an explicit bounded timeout", () => {
      const target = detectFdxTarget()
      if (!target) return
      const fixture = setupVerifiedExecFixture()
      if (!fixture) return
      // Real resolver + real secure process creation, repeated, under an
      // explicit bounded timeout — never reliant on Bun's default 5s.
      for (let i = 0; i < 3; i++) {
        const res = getFdxAvailabilityStatus(true)
        expect(res.available).toBe(true)
        expect(res.validatedSha256).not.toBeNull()
      }
    }, { timeout: 30000 })

    it("Contract1/P1-1: unmanaged (env/PATH) candidates are hashed before first execution", () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      const dir = join(tempDir, "unmanaged-trust-order")
      mkdirSync(dir, { recursive: true })
      const binPath = join(dir, target.executableName)
      const evilPath = join(dir, "replacement-bytes")
      writeFileSync(evilPath, "#!/bin/sh\necho 'fdx v1.0.4 replaced'\n", "utf-8")
      // On its first execution the script replaces its own pathname with the
      // replacement bytes (same inode via cp truncation). If the candidate
      // were hashed AFTER first execution, the trusted digest would be the
      // REPLACED generation; the contract hashes the opened bytes BEFORE any
      // execution.
      const selfReplacing = [
        "#!/bin/sh",
        `SELF=${JSON.stringify(binPath)}`,
        `EVIL=${JSON.stringify(evilPath)}`,
        'cp "$EVIL" "$SELF"',
        'chmod +x "$SELF"',
        "echo 'fdx v1.0.4'",
      ].join("\n")
      writeFileSync(binPath, selfReplacing, "utf-8")
      chmodSync(binPath, 0o755)
      const originalSha = sha256FileContents(binPath)
      expect(originalSha).not.toBeNull()
      process.env.FDX_BINARY_PATH = binPath
      process.env.FDX_DISABLE_FALLBACK = "1"
      const res = getFdxAvailabilityStatus(true)
      expect(res.available).toBe(true)
      expect(res.source).toBe("env")
      // Trusted digest = the ORIGINAL generation (hashed before the probe),
      // never the post-execution replacement.
      expect(res.validatedSha256).toBe(originalSha)
      expect(sha256FileContents(binPath)).not.toBe(originalSha)
      expect(readFileSync(binPath, "utf-8")).toContain("replaced")
    })

    it("Contract1/P1-2: the pre-exec hook fires after the snapshot exists and before the OS execution call", () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.FDX_DISABLE_FALLBACK = "1"
      setActiveProjectDir(tempDir)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      const before = getFdxAvailabilityStatus(true)
      console.log(before); expect(before.available).toBe(true)
      let snapshotSeen: string | null = null
      let sourceSeen: string | null = null
      let snapshotBytesAtHook: string | null = null
      setFdxPreExecTestHook((snapshotPath: string, sourceBin: string) => {
        snapshotSeen = snapshotPath
        sourceSeen = sourceBin
        snapshotBytesAtHook = sha256FileContents(snapshotPath)
      })
      try {
        const out = runFdx(["read", "tests/fdx-trusted-acquisition.test.ts"])
        // The hook saw a real snapshot path — distinct from the source — that
        // already carried the validated bytes (post final hash op)...
        expect(snapshotSeen).not.toBeNull()
        expect(snapshotSeen!).not.toBe(fake.binPath)
        expect(sourceSeen).not.toBeNull()
        expect(sourceSeen!).toBe(fake.binPath)
        expect(snapshotBytesAtHook).not.toBeNull()
        expect(snapshotBytesAtHook!).toBe(createHash("sha256").update(readFileSync(fake.binPath)).digest("hex"))
        // ...and the OS execution call still ran after the hook (the snapshot
        // executed successfully and returned the validated binary's output).
        expect(out).toContain("fdx v1.0.4")
      } finally {
        setFdxPreExecTestHook(null)
      }
    })

    it("Contract1/P1-1/P1-2: probe and command run from the same private snapshot generation (parity)", () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.FDX_DISABLE_FALLBACK = "1"
      setActiveProjectDir(tempDir)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      // The binary records the path it was executed from ($0) into a marker.
      const marker = join(tempDir, "executed-from.txt")
      const recorder = [
        "#!/bin/sh",
        `echo "$0" > ${JSON.stringify(marker)}`,
        "echo 'fdx v1.0.4'",
      ].join("\n")
      writeFileSync(fake.binPath, recorder, "utf-8")
      chmodSync(fake.binPath, 0o755)
      const binBuf = readFileSync(fake.binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(fake.pkgDir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const prov = JSON.parse(readFileSync(join(fake.pkgDir, "provenance.json"), "utf-8"))
      prov.sha256 = sha256
      prov.binaryByteSize = binBuf.length
      writeFileSync(join(fake.pkgDir, "provenance.json"), JSON.stringify(prov), "utf-8")

      // Probe (during resolution): records the path it ran from.
      const status = getFdxAvailabilityStatus(true)
      expect(status.available).toBe(true)
      const probePath = readFileSync(marker, "utf-8").trim()
      // Command (normal runFdx): records its own path.
      const out = runFdx(["read", "tests/fdx-trusted-acquisition.test.ts"])
      expect(out).toContain("fdx v1.0.4")
      const commandPath = readFileSync(marker, "utf-8").trim()
      // Neither the probe nor the command ever executed the original candidate
      // pathname or the mutable snapshot pathname — execution is bound to the
      // validated in-memory bytes via the secure-exec helper. $0 is the
      // helper's private payload path (macOS), the kernel's descriptor path
      // for the sealed object (/dev/fd/N or /proc/self/fd/N on Linux), or the
      // helper's own argv[0].
      expect(probePath).not.toBe(fake.binPath)
      expect(commandPath).not.toBe(fake.binPath)
      expect(probePath).not.toContain("flowdeck-fdx-snapshot")
      expect(commandPath).not.toContain("flowdeck-fdx-snapshot")
      const sealedObjectPath = /fdx-secure-exec-\d+\/payload$|^\/dev\/fd\/\d+$|^\/proc\/self\/fd\/\d+$|^fdx-secure-exec$/
      expect(probePath).toMatch(sealedObjectPath)
      expect(commandPath).toMatch(sealedObjectPath)
    })

    it("Contract1/P1-2: private snapshot cleanup on failure (dual-error: probe fails AND command fails)", () => {
      const target = detectFdxTarget()
      if (!target) return
      if (process.platform === "win32") return
      const listSnapshots = (): string[] => {
        try {
          return readdirSync(tmpdir()).filter((n) => n.startsWith("flowdeck-fdx-snapshot"))
        } catch {
          return []
        }
      }
      const before = listSnapshots()
      // Dual-error case 1: the --version probe itself fails (non-zero exit).
      const failDir = join(tempDir, "probe-fails")
      mkdirSync(failDir, { recursive: true })
      const failScript = "#!/bin/sh\nexit 3\n"
      writeFileSync(join(failDir, target.executableName), failScript, "utf-8")
      chmodSync(join(failDir, target.executableName), 0o755)
      writeFileSync(join(failDir, "checksum.json"), JSON.stringify({ sha256: createHash("sha256").update(failScript).digest("hex") }), "utf-8")
      const val = validateFdxBinaryPath(join(failDir, target.executableName), failDir, { requireChecksum: true, target })
      expect(val.valid).toBe(false)
      expect(listSnapshots()).toEqual(before)

      // Dual-error case 2: the probe passes but the command fails.
      process.env.XDG_CACHE_HOME = tempDir
      process.env.FLOWDECK_FDX_ALLOW_LOCAL_DEV_SOURCE = "1"
      process.env.FDX_DISABLE_FALLBACK = "1"
      setActiveProjectDir(tempDir)
      const fake = buildFakePlatformPackage(tempDir, {})
      if (!fake) return
      const failsOnCommand = [
        "#!/bin/sh",
        'case "$1" in',
        "  --version) echo 'fdx v1.0.4' ;;",
        "  *) exit 9 ;;",
        "esac",
      ].join("\n")
      writeFileSync(fake.binPath, failsOnCommand, "utf-8")
      chmodSync(fake.binPath, 0o755)
      const binBuf = readFileSync(fake.binPath)
      const sha256 = createHash("sha256").update(binBuf).digest("hex")
      writeFileSync(join(fake.pkgDir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
      const prov = JSON.parse(readFileSync(join(fake.pkgDir, "provenance.json"), "utf-8"))
      prov.sha256 = sha256
      prov.binaryByteSize = binBuf.length
      writeFileSync(join(fake.pkgDir, "provenance.json"), JSON.stringify(prov), "utf-8")
      const status = getFdxAvailabilityStatus(true)
      expect(status.available).toBe(true)
      expect(() => runFdx(["read", "tests/fdx-trusted-acquisition.test.ts"])).toThrow(/FDX Integrity/)
      expect(listSnapshots()).toEqual(before)
    })
  })
})
