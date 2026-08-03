import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync,
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
} from "../src/tools/fdx-shared"
import { acquireInstallLock, releaseInstallLock, handleFdxInstall, type InstallLockResult } from "../src/commands/fdx-admin"

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
    const sha256 = createHash("sha256").update(readFileSync(binPath)).digest("hex")
    writeFileSync(join(pkgDir, "checksum.json"), JSON.stringify({ sha256 }), "utf-8")
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
})
