/**
 * FDX CLI Administration & Installer Subcommands
 *
 * Implements CLI commands:
 *   flowdeck fdx status
 *   flowdeck fdx install
 *   flowdeck fdx repair
 *   flowdeck fdx verify
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, renameSync, readFileSync, rmSync, readdirSync, openSync, closeSync, fsyncSync, linkSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  detectFdxTarget,
  getFdxAvailabilityStatus,
  getFdxCacheDir,
  getFlowdeckPackageVersion,
  resolveTrustedPlatformPackage,
  validateFdxBinaryPath,
  validateFdxProvenance,
} from "../tools/fdx-shared"

export function handleFdxStatus(): void {
  const status = getFdxAvailabilityStatus(true)
  console.log("\n=== FlowDeck FDX Native Status ===")
  console.log(`Target:             ${status.target ? `${status.target.platform}/${status.target.arch}${status.target.libc ? ` (${status.target.libc})` : ""}` : "Unsupported"}`)
  console.log(`Expected Package:   ${status.target ? status.target.packageName : "n/a"}`)
  console.log(`Native Available:   ${status.available ? "Yes" : "No"}`)
  console.log(`Resolution Source:  ${status.source}`)
  console.log(`Resolved Path:      ${status.binaryPath ?? "(none)"}`)
  console.log(`Binary Version:     ${status.binaryVersion ?? "n/a"}`)
  console.log(`Checksum Status:    ${status.checksumStatus}`)
  console.log(`Fallback Mode:      ${status.available ? "Inactive (using native performance)" : "Active (TypeScript fallback)"}`)

  if (status.diagnostics.length > 0) {
    console.log("\nDiagnostics:")
    for (const diag of status.diagnostics) {
      console.log(`  - ${diag}`)
    }
  }

  if (!status.available && status.targetSupported) {
    console.log(`\nRepair Command:     ${status.repairCommand}`)
  }
}

export function handleFdxVerify(): boolean {
  const status = getFdxAvailabilityStatus(true)
  console.log("\n=== FlowDeck FDX Verification ===")
  if (!status.targetSupported) {
    console.log(`ℹ Target platform ${process.platform}/${process.arch} uses TypeScript fallback mode by design.`)
    return true
  }

  if (!status.available || !status.binaryPath) {
    console.error(`✗ Verification FAILED: Native FDX executable not available.`)
    console.error(`  Run '${status.repairCommand}' to acquire the native binary.`)
    return false
  }

  const val = validateFdxBinaryPath(status.binaryPath)
  if (!val.valid) {
    console.error(`✗ Verification FAILED: ${val.reason}`)
    console.error(`  Run '${status.repairCommand}' to repair the native binary.`)
    return false
  }

  console.log(`✓ FDX native binary verified successfully:`)
  console.log(`  Path:    ${status.binaryPath}`)
  console.log(`  Version: ${val.version}`)
  console.log(`  Source:  ${status.source}`)
  return true
}

/** Compute SHA-256 of a file and return the hex digest. */
function sha256File(filePath: string): string {
  const buf = readFileSync(filePath)
  return createHash("sha256").update(buf).digest("hex")
}

const INSTALL_LOCK_SCHEMA_VERSION = 1
/** Bounded grace interval for newly observed empty/partial/malformed lock files. */
const INSTALL_LOCK_INIT_GRACE_MS = 30_000

/** Bounded timeout for registry metadata, download, and extract subprocesses. */
export const REGISTRY_TIMEOUT_MS = 60_000

/**
 * Canonical single-value SRI parser. Accepts exactly one supported digest
 * (sha512 or sha256) with a valid base64 value on a single line. Rejects
 * multiline, whitespace-padded, unsupported-algorithm, or malformed values.
 * Used to fail closed on registry `dist.integrity` metadata (P1-4).
 */
export function parseSRI(sri: string): { ok: true; algo: "sha512" | "sha256"; digest: string } | { ok: false; reason: string } {
  if (typeof sri !== "string" || sri.length === 0) {
    return { ok: false, reason: "empty integrity value" }
  }
  if (/\s/.test(sri)) {
    return { ok: false, reason: "multiline or whitespace-separated integrity value" }
  }
  const match = sri.match(/^(sha512|sha256)-([A-Za-z0-9+/=]+)$/)
  if (!match) {
    return { ok: false, reason: "unsupported or malformed integrity value" }
  }
  const algo = match[1] as "sha512" | "sha256"
  const digest = match[2]
  if (digest.length < 32) {
    return { ok: false, reason: "integrity digest too short to be valid" }
  }
  return { ok: true, algo, digest }
}

export type InstallLockResult =
  | { ok: true; token: string }
  | { ok: false; reason: string; detail?: string }

/** Returns "alive" | "dead" | "unknown" for the given pid. */
function pidLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (e: any) {
    if (e?.code === "EPERM") return "alive"
    if (e?.code === "ESRCH") return "dead"
    return "unknown"
  }
}

type LockClassification =
  | { recoverable: false; reason: string; detail?: string }
  | { recoverable: true; raw: string | null }

/**
 * Classify an existing lock file at `lockPath`.
 *
 * Deterministic rules:
 *  - Valid schema + confirmed live owner  → blocked, never broken (age never
 *    overrides a confirmed live PID).
 *  - Valid schema + confirmed dead owner  → recoverable.
 *  - Valid schema + unknown liveness      → blocked (fail closed).
 *  - Empty / partially written / malformed + freshly created → blocked
 *    (indeterminate: the owner may still be initializing within the bounded
 *    grace interval — never break a fresh lock).
 *  - Empty / partially written / malformed + older than grace → recoverable.
 *  - Unsupported schema version           → blocked (fail closed).
 */
function classifyExistingLock(lockPath: string): LockClassification {
  let mtimeMs: number | null = null
  let raw: string | null = null
  try {
    mtimeMs = statSync(lockPath).mtimeMs
    raw = readFileSync(lockPath, "utf-8")
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      // Lock vanished between EEXIST and read — retry the exclusive create.
      return { recoverable: true, raw: null }
    }
    // Any other failure (EACCES, EPERM, EIO, ENOTDIR, EISDIR, ...) is NOT a
    // disappearance: the lock may exist but be uninspectable. Fail closed —
    // never classify a lock we could not read, and never hint at deletion.
    return {
      recoverable: false,
      reason: "lock-read-error",
      detail: `Existing lock could not be inspected (${e?.code ?? e?.message}); the owning process is unknown.`,
    }
  }

  const ageMs = Date.now() - mtimeMs
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    if (ageMs < INSTALL_LOCK_INIT_GRACE_MS) {
      return { recoverable: false, reason: "lock-indeterminate-fresh", detail: "Lock file is empty, partially written, or malformed and was created recently; the owner may still be initializing it." }
    }
    return { recoverable: true, raw }
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    if (ageMs < INSTALL_LOCK_INIT_GRACE_MS) {
      return { recoverable: false, reason: "lock-indeterminate-fresh", detail: "Lock file content is malformed and was created recently; the owner may still be initializing it." }
    }
    return { recoverable: true, raw }
  }

  if (data.schemaVersion !== INSTALL_LOCK_SCHEMA_VERSION) {
    return { recoverable: false, reason: "lock-incompatible-schema", detail: `Lock schema version ${JSON.stringify(data.schemaVersion)} is not supported by this FlowDeck version.` }
  }

  const pid = Number(data.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    return { recoverable: false, reason: "lock-unknown-liveness", detail: `Lock references an invalid pid (${JSON.stringify(data.pid)}); liveness cannot be determined.` }
  }

  const liveness = pidLiveness(pid)
  if (liveness === "alive") {
    return { recoverable: false, reason: "lock-held-live", detail: `Lock is held by live process ${pid}.` }
  }
  if (liveness === "dead") {
    return { recoverable: true, raw }
  }
  return { recoverable: false, reason: "lock-unknown-liveness", detail: `Liveness of lock owner process ${pid} could not be determined.` }
}

/**
 * Atomically recover a stale lock without ever assuming ownership from a
 * deletion. The lock is first renamed to a unique quarantine path (atomic —
 * there is exactly one winner per stale lock), then the quarantined bytes are
 * re-verified against the content that was classified. If a fresh owner
 * replaced the lock between classification and rename, the quarantine holds
 * the *new* lock: it is restored for its true owner and recovery fails closed.
 * Only after identity confirmation is the stale lock removed; the subsequent
 * exclusive create is what actually grants ownership.
 */
function recoverStaleLock(lockPath: string, expectedRaw: string): "recovered" | "contended" | "error" {
  const claim = randomBytes(16).toString("hex")
  const quarantinePath = `${lockPath}.stale-${process.pid}-${claim}`
  try {
    renameSync(lockPath, quarantinePath)
  } catch (e: any) {
    // ENOENT: another contender already quarantined it — retry the create.
    if (e?.code === "ENOENT") return "contended"
    return "error"
  }
  let quarantinedRaw: string
  try {
    quarantinedRaw = readFileSync(quarantinePath, "utf-8")
  } catch {
    // Unreadable quarantine: preserve it as evidence; fail closed.
    return "error"
  }
  if (quarantinedRaw !== expectedRaw) {
    // We quarantined a DIFFERENT lock (a fresh owner won after our classify,
    // or another contender's quarantine). Restore it WITHOUT ever replacing a
    // lock that may now exist at lockPath: POSIX rename replaces any existing
    // destination, which would clobber a valid replacement owner's lock.
    restoreQuarantinedLock(quarantinePath, lockPath, quarantinedRaw)
    return "contended"
  }
  rmSync(quarantinePath, { force: true })
  return "recovered"
}

/**
 * No-clobber restore of a quarantined lock. Only places the quarantined
 * content back if lockPath is still free: `linkSync` is atomic and fails with
 * EEXIST when a newer lock exists — it never replaces an existing lock. On
 * filesystems without hard links, an exclusive create carrying the quarantined
 * content is the equivalent no-replace primitive. If a newer lock occupies the
 * path, the quarantined (superseded) lock is discarded; the newest lock is
 * authoritative, and the superseded owner's later release attempt simply fails
 * its token check instead of deleting another owner's lock.
 */
function restoreQuarantinedLock(quarantinePath: string, lockPath: string, content: string): void {
  try {
    linkSync(quarantinePath, lockPath)
    try { rmSync(quarantinePath, { force: true }) } catch {}
    return
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      // A newer lock exists at lockPath — it is authoritative. Discard the
      // superseded quarantine.
      try { rmSync(quarantinePath, { force: true }) } catch {}
      return
    }
    // Hard links unavailable or denied — fall through to exclusive creation.
  }
  try {
    const fd = openSync(lockPath, "wx")
    try {
      writeFileSync(fd, content, "utf-8")
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try { rmSync(quarantinePath, { force: true }) } catch {}
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      try { rmSync(quarantinePath, { force: true }) } catch {}
      return
    }
    // Restore failed for a non-contention reason: keep the quarantine file as
    // evidence and fail closed (the caller treats "contended" as a retry).
  }
}

type ActivationResult =
  | { state: "acquired" }
  | { state: "contended" }
  | { state: "tmp-missing" }
  | { state: "fatal"; reason: string; detail?: string }

/**
 * Common lock activation used by BOTH the hard-link path and the direct
 * exclusive-creation fallback. Activation is atomic and never replaces an
 * existing lock:
 *  - linkSync(tmpPath, lockPath): atomic no-replace on hard-link filesystems.
 *  - openSync(lockPath, "wx"): fallback when hard links are unavailable or
 *    denied (EPERM/ENOTSUP/EACCES/...); observers are protected by the bounded
 *    grace interval while the metadata is written.
 * EEXIST from either primitive is the single "contended" outcome and always
 * feeds the same classify/recover path — stale recovery therefore behaves
 * identically on filesystems without hard links (previously the fallback loop
 * deleted the tmp payload and never reached classification, permanently
 * blocking dead-owner locks). The tmp payload is preserved across retries.
 */
function tryActivate(tmpPath: string, lockPath: string, payload: string, tryHardLink: boolean): ActivationResult {
  if (tryHardLink) {
    try {
      linkSync(tmpPath, lockPath)
      try { rmSync(tmpPath, { force: true }) } catch {}
      return { state: "acquired" }
    } catch (e: any) {
      if (e?.code === "EEXIST") return { state: "contended" }
      if (e?.code === "ENOENT") return { state: "tmp-missing" }
      // Hard links unavailable or denied — fall through to exclusive create.
    }
  }
  try {
    const fd = openSync(lockPath, "wx")
    try {
      writeFileSync(fd, payload, "utf-8")
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try { rmSync(tmpPath, { force: true }) } catch {}
    return { state: "acquired" }
  } catch (e: any) {
    if (e?.code === "EEXIST") return { state: "contended" }
    return { state: "fatal", reason: "lock-activation-error", detail: e?.message }
  }
}

/**
 * Acquire a per-target install lock.
 *
 * Ownership-safe protocol:
 *   1. Write the complete lock metadata (schema, pid, timestamp, random
 *      ownership token, target identity) to a unique sibling temporary file and
 *      fsync it — observers never see a partially written lock. The tmp
 *      payload is preserved across contention retries and only rewritten if
 *      it was actually lost; it is never deleted on contention.
 *   2. Atomically activate the lock without replacing an existing lock via a
 *      common activation primitive (hard-link creation; direct O_EXCL
 *      fallback for platforms without hard links, where the bounded grace
 *      interval protects observers).
 *   3. On contention, classify the existing lock:
 *        - live owner, unknown liveness, fresh malformed/empty, incompatible
 *          schema, or an uninspectable lock (read error) → fail closed;
 *        - confirmed dead owner or old malformed lock → atomic recovery via
 *          quarantine + identity re-verification with no-clobber restores,
 *          then retry the exclusive create. Ownership is granted only by the
 *          exclusive create, never by deleting a lock.
 * The returned token is the only credential that may release the lock.
 */
export function acquireInstallLock(lockPath: string, targetId: string): InstallLockResult {
  const token = randomBytes(32).toString("hex")
  const tmpPath = `${lockPath}.tmp-${process.pid}-${token.slice(0, 8)}`
  const payload = JSON.stringify({
    schemaVersion: INSTALL_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    createdAt: Date.now(),
    token,
    target: targetId,
  })

  // The lock lives beside the target cache directory; on a fresh machine that
  // parent directory does not exist yet, so create it before any lock I/O.
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch (e: any) {
    return { ok: false, reason: "lock-dir-error", detail: e?.message }
  }

  const writeTmp = (): InstallLockResult => {
    try {
      const fd = openSync(tmpPath, "wx")
      try {
        writeFileSync(fd, payload, "utf-8")
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return { ok: true, token }
    } catch (e: any) {
      return { ok: false, reason: "lock-tmp-write-error", detail: e?.message }
    }
  }

  let tmpWrite = writeTmp()
  if (!tmpWrite.ok) return tmpWrite

  // Test hook (never set in production): force the direct exclusive-creation
  // path so stale recovery through the fallback is exercised deterministically
  // even on filesystems where hard links exist.
  const tryHardLink = process.env.FLOWDECK_FDX_LOCK_FORCE_FALLBACK !== "1"

  for (let attempt = 0; attempt < 3; attempt++) {
    const act = tryActivate(tmpPath, lockPath, payload, tryHardLink)
    if (act.state === "acquired") return { ok: true, token }
    if (act.state === "fatal") {
      try { rmSync(tmpPath, { force: true }) } catch {}
      return { ok: false, reason: act.reason, detail: act.detail }
    }
    if (act.state === "tmp-missing") {
      // The tmp payload was lost (external cleanup or an exotic filesystem) —
      // rewrite it and retry; bounded retries keep this from looping forever.
      tmpWrite = writeTmp()
      if (!tmpWrite.ok) {
        try { rmSync(tmpPath, { force: true }) } catch {}
        return tmpWrite
      }
      continue
    }

    // Contended: classify the existing lock (ENOENT-only vanish detection;
    // any other read failure fails closed as lock-read-error).
    const cls = classifyExistingLock(lockPath)
    if (!cls.recoverable) {
      try { rmSync(tmpPath, { force: true }) } catch {}
      return { ok: false, reason: cls.reason, detail: cls.detail }
    }
    if (cls.raw === null) continue // Lock vanished — retry the exclusive create.

    const rec = recoverStaleLock(lockPath, cls.raw)
    if (rec === "error") {
      try { rmSync(tmpPath, { force: true }) } catch {}
      return { ok: false, reason: "lock-recovery-error", detail: "Stale lock recovery failed; preserved evidence and failed closed." }
    }
    // "recovered" or "contended" → retry the exclusive create; the create is
    // the single arbiter of ownership.
  }
  try { rmSync(tmpPath, { force: true }) } catch {}
  return { ok: false, reason: "lock-contention-exhausted", detail: "Repeated contention with other installers; giving up." }
}

/**
 * Release a per-target install lock. The ownership token is the only valid
 * credential: a stale token (e.g. from an old process after a replacement
 * owner took over) never deletes the lock. Returns true only when the lock was
 * actually removed by this caller.
 */
export function releaseInstallLock(lockPath: string, token: string): boolean {
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf-8"))
    if (data?.schemaVersion !== INSTALL_LOCK_SCHEMA_VERSION) return false
    if (data.token !== token) return false
    rmSync(lockPath, { force: true })
    return true
  } catch {
    return false
  }
}

/** Attempt to download platform package from npm registry with integrity verification. */
function fetchFromRegistry(packageName: string, version: string): { dir: string; tmpDir: string; reason?: string } | null {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
  const npmShell = process.platform === "win32"
  const tmpDir = join(getFdxCacheDir({ platform: process.platform, arch: process.arch, packageName, executableName: "fdx" }), `..`, `.registry-fetch-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(tmpDir, { recursive: true })

    // 1. Query registry metadata
    let metaRaw: string
    try {
      metaRaw = execFileSync(npmCmd, ["view", `${packageName}@${version}`, "--json"], { cwd: tmpDir, encoding: "utf-8", shell: npmShell, stdio: ["pipe", "pipe", "pipe"], timeout: REGISTRY_TIMEOUT_MS })
    } catch (e: any) {
      const msg = e.stderr?.toString() ?? e.message ?? ""
      if (e?.killed || e?.code === "ETIMEDOUT" || /timed out|timeout/i.test(msg)) {
        console.error(`  [registry] Failure: registry metadata request timed out (${packageName}@${version})`)
      } else if (msg.includes("404") || msg.includes("E404") || msg.includes("Not Found")) {
        console.error(`  [registry] Failure: package version missing (${packageName}@${version})`)
      } else if (msg.includes("401") || msg.includes("403") || msg.includes("EAUTH")) {
        console.error(`  [registry] Failure: authentication failure`)
      } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
        console.error(`  [registry] Failure: DNS resolution failed (${packageName}@${version})`)
      } else if (/certificate|SSL|TLS|UNABLE_TO_VERIFY/i.test(msg)) {
        console.error(`  [registry] Failure: TLS/certificate error`)
      } else if (/ECONNRESET|EADDRNOTAVAIL|EACCES|socket hang/i.test(msg)) {
        console.error(`  [registry] Failure: network error (${msg.trim().split("\n")[0]})`)
      } else if (/rate.?limit|429/i.test(msg)) {
        console.error(`  [registry] Failure: rate limited by registry`)
      } else {
        console.error(`  [registry] Failure: registry unavailable (${msg.trim().split("\n")[0]})`)
      }
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    let meta: any = {}
    try {
      meta = JSON.parse(metaRaw)
    } catch {
      console.error(`  [registry] Failure: registry returned malformed JSON metadata`)
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    const dist = meta.dist ?? {}
    const expectedIntegrity = typeof dist.integrity === "string" && dist.integrity.length > 0 ? dist.integrity : null
    const expectedShasum = typeof dist.shasum === "string" && dist.shasum.length > 0 ? dist.shasum : null

    if (!expectedIntegrity && !expectedShasum) {
      console.error(`  [registry] Failure: integrity metadata missing from registry response`)
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    // 2. Download exact tarball
    try {
      execFileSync(npmCmd, ["pack", `${packageName}@${version}`], { cwd: tmpDir, shell: npmShell, stdio: "ignore", timeout: REGISTRY_TIMEOUT_MS })
    } catch (e: any) {
      const msg = e?.stderr?.toString() ?? e?.message ?? ""
      if (e?.killed || e?.code === "ETIMEDOUT" || /timed out|timeout/i.test(msg)) {
        console.error(`  [registry] Failure: tarball download timed out (${packageName}@${version})`)
      } else if (/rate.?limit|429/i.test(msg)) {
        console.error(`  [registry] Failure: rate limited by registry while downloading tarball`)
      } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
        console.error(`  [registry] Failure: DNS resolution failed while downloading tarball`)
      } else {
        console.error(`  [registry] Failure: tarball download failed (${msg.trim().split("\n")[0] || "unknown error"})`)
      }
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }
    const files = readdirSync(tmpDir).filter(f => f.endsWith(".tgz"))
    if (files.length !== 1) {
      console.error(`  [registry] Failure: extraction failure (expected 1 .tgz, got ${files.length})`)
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    const tgzPath = join(tmpDir, files[0])
    const tgzBuf = readFileSync(tgzPath)

    // 3. Verify downloaded tarball integrity against registry metadata.
    //    Fail closed: a non-empty but malformed/unsupported/multiline SRI is a
    //    hard failure, never silently skipped (P1-4: SRI fail-open).
    if (expectedIntegrity) {
      const sriResult = parseSRI(expectedIntegrity)
      if (!sriResult.ok) {
        console.error(`  [registry] Failure: invalid integrity metadata (${sriResult.reason})`)
        rmSync(tmpDir, { recursive: true, force: true })
        return null
      }
      const actualB64 = createHash(sriResult.algo).update(tgzBuf).digest("base64")
      if (actualB64 !== sriResult.digest) {
        console.error(`  [registry] Failure: integrity mismatch (expected ${expectedIntegrity}, got ${sriResult.algo}-${actualB64})`)
        rmSync(tmpDir, { recursive: true, force: true })
        return null
      }
    } else if (expectedShasum) {
      // shasum (SHA-1) is a validated legacy fallback used only when the
      // registry exposes no SRI integrity value at all.
      const actualShasum = createHash("sha1").update(tgzBuf).digest("hex")
      if (actualShasum !== expectedShasum) {
        console.error(`  [registry] Failure: integrity mismatch (shasum expected ${expectedShasum}, got ${actualShasum})`)
        rmSync(tmpDir, { recursive: true, force: true })
        return null
      }
    }

    // 4. Extract exact tarball safely without wildcard expansion
    try {
      execFileSync("tar", ["xzf", files[0]], { cwd: tmpDir, stdio: "ignore", timeout: REGISTRY_TIMEOUT_MS })
    } catch (e: any) {
      const msg = e?.stderr?.toString() ?? e?.message ?? ""
      if (e?.killed || e?.code === "ETIMEDOUT" || /timed out|timeout/i.test(msg)) {
        console.error(`  [registry] Failure: tarball extraction timed out`)
      } else {
        console.error(`  [registry] Failure: tarball extraction failed (${msg.trim().split("\n")[0] || "unknown error"})`)
      }
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }
    const pkgDir = join(tmpDir, "package")
    if (!existsSync(pkgDir)) {
      console.error(`  [registry] Failure: extraction failure (package folder missing)`)
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    // 5. Verify package identity
    const pkgManifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"))
    if (pkgManifest.name !== packageName || pkgManifest.version !== version) {
      console.error(`  [registry] Failure: package identity mismatch (expected ${packageName}@${version}, got ${pkgManifest.name}@${pkgManifest.version})`)
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    return { dir: pkgDir, tmpDir }
  } catch (err: any) {
    console.error(`  [registry] Failure: ${err.message}`)
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    return null
  }
}

export async function handleFdxInstall(isRepair = false): Promise<boolean> {
  const target = detectFdxTarget()
  console.log(`\n=== FlowDeck FDX ${isRepair ? "Repair" : "Installer"} ===`)

  if (!target) {
    console.log(`ℹ Platform target ${process.platform}/${process.arch} is not supported for prebuilt native binaries.`)
    console.log(`  FlowDeck will continue using TypeScript fallback mode.`)
    return true
  }

  const currentStatus = getFdxAvailabilityStatus(true)
  if (currentStatus.available && currentStatus.binaryPath && !isRepair) {
    console.log(`✓ Compatible native FDX binary already available at: ${currentStatus.binaryPath}`)
    console.log(`  Source: ${currentStatus.source} (v${currentStatus.binaryVersion})`)
    return true
  }

  console.log(`Target: ${target.platform}/${target.arch}${target.libc ? ` (${target.libc})` : ""}`)
  console.log(`Package: ${target.packageName}`)

  const cacheDir = getFdxCacheDir(target)
  const lockPath = `${cacheDir}.lock`
  const lockTargetId = `${target.platform}-${target.arch}${target.libc ? `-${target.libc}` : ""}@${getFlowdeckPackageVersion()}`
  const stagingDir = `${cacheDir}.staging-${process.pid}-${Date.now()}`
  let lockToken: string | null = null
  let registryFetchTmp: string | null = null
  let backupDir: string | null = null
  let backupCreated = false
  /** True once the staging dir has been renamed into the authoritative cache path. */
  let cacheActivated = false
  let newCacheActivated = false

  // Per-target lock: serialize installs for the same platform package so two
  // concurrent flows cannot race on the cache directory activation. The lock
  // is token-based: only the acquirer may release it, and stale locks are
  // recovered atomically (see acquireInstallLock).
  const lock = acquireInstallLock(lockPath, lockTargetId)
  if (!lock.ok) {
    console.error(`✗ Installation FAILED: Another FDX install/repair is already in progress for this target.`)
    console.error(`  Lock file: ${lockPath}`)
    console.error(`  Reason: ${lock.reason}`)
    if (lock.detail) console.error(`  Detail: ${lock.detail}`)
    if (lock.reason === "lock-held-live") {
      console.error(`  The lock is held by a live process; it will be released when that process finishes.`)
    } else if (
      lock.reason === "lock-read-error" ||
      lock.reason === "lock-unknown-liveness" ||
      lock.reason === "lock-indeterminate-fresh" ||
      lock.reason === "lock-incompatible-schema"
    ) {
      console.error(`  The lock's owner state is unknown or the lock is incompatible — do NOT delete it.`)
      console.error(`  Investigate the owning process before taking any action.`)
    } else {
      // Confirmed-stale cases (dead owner / old malformed content) are normally
      // recovered automatically; this guidance applies only when recovery was
      // blocked or exhausted (e.g. lock-recovery-error, lock-contention-exhausted).
      console.error(`  If no other install is running and the owner is confirmed dead, delete the stale lock file and retry.`)
    }
    return false
  }
  lockToken = lock.token

  try {
    mkdirSync(stagingDir, { recursive: true })

    // ── 1. Locate source platform package (trusted resolution, then registry fallback) ──
    // FlowDeck's own resolved optional dependency is always trusted and is
    // resolved exclusively through FlowDeck's own installed module location.
    // Caller project/cwd directories are consulted only when local dev sources
    // are explicitly allowed (opt-in, default off, never in release profiles),
    // and only via direct path checks with full identity/version verification.
    let sourceBinDir: string | null = null
    const resolvedPkg = resolveTrustedPlatformPackage(target)
    if (resolvedPkg && existsSync(join(resolvedPkg.pkgDir, target.executableName))) {
      sourceBinDir = resolvedPkg.pkgDir
      if (resolvedPkg.source === "local-dev") {
        console.log(`ℹ Using local dev platform package from: ${resolvedPkg.pkgDir}`)
      }
    }

    if (!sourceBinDir) {
      console.log(`ℹ Local platform package ${target.packageName} not found. Attempting trusted registry acquisition...`)
      const regRes = fetchFromRegistry(target.packageName, getFlowdeckPackageVersion())
      if (regRes) {
        sourceBinDir = regRes.dir
        registryFetchTmp = regRes.tmpDir
      }
    }

    if (!sourceBinDir) {
      rmSync(stagingDir, { recursive: true, force: true })
      console.error(`✗ Installation FAILED: Could not locate platform package ${target.packageName}.`)
      console.error(`  Ensure ${target.packageName} is installed or present in node_modules/packages.`)
      console.error(`  Run: npm install ${target.packageName}`)
      return false
    }

    // ── 2. Trusted acquisition — verify checksum before staging ────────────
    const sourceChecksumPath = join(sourceBinDir, "checksum.json")
    if (!existsSync(sourceChecksumPath)) {
      rmSync(stagingDir, { recursive: true, force: true })
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.error(`✗ Installation FAILED: checksum.json missing from ${target.packageName}.`)
      return false
    }

    let expectedSha256: string
    try {
      const checksum = JSON.parse(readFileSync(sourceChecksumPath, "utf-8"))
      expectedSha256 = checksum.sha256
      if (!expectedSha256 || typeof expectedSha256 !== "string" || expectedSha256.length !== 64) {
        throw new Error("sha256 field missing or malformed")
      }
    } catch (e: any) {
      rmSync(stagingDir, { recursive: true, force: true })
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.error(`✗ Installation FAILED: checksum.json is corrupt: ${e.message}`)
      return false
    }

    const sourceBin = join(sourceBinDir, target.executableName)
    if (!existsSync(sourceBin)) {
      rmSync(stagingDir, { recursive: true, force: true })
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.error(`✗ Installation FAILED: Executable binary ${target.executableName} missing from ${target.packageName}.`)
      return false
    }

    const actualSha256 = sha256File(sourceBin)
    if (actualSha256 !== expectedSha256) {
      rmSync(stagingDir, { recursive: true, force: true })
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.error(`✗ Installation FAILED: Binary checksum mismatch for ${target.packageName}.`)
      console.error(`  Expected: ${expectedSha256}`)
      console.error(`  Actual:   ${actualSha256}`)
      return false
    }

    // ── 3. Validate complete provenance schema and field relationships ───────
    const sourceProvenancePath = join(sourceBinDir, "provenance.json")
    if (!existsSync(sourceProvenancePath)) {
      rmSync(stagingDir, { recursive: true, force: true })
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.error(`✗ Installation FAILED: provenance.json missing from ${target.packageName}.`)
      return false
    }

    let provenanceData: any
    try {
      provenanceData = JSON.parse(readFileSync(sourceProvenancePath, "utf-8"))
    } catch (e: any) {
      rmSync(stagingDir, { recursive: true, force: true })
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.error(`✗ Installation FAILED: provenance.json corrupt: ${e.message}`)
      return false
    }

    const provVal = validateFdxProvenance(provenanceData, target)
    if (!provVal.valid) {
      rmSync(stagingDir, { recursive: true, force: true })
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.error(`✗ Installation FAILED: Provenance validation failed: ${provVal.reason}`)
      return false
    }

    // ── 4. Stage all files ─────────────────────────────────────────────────
    const stagedBin = join(stagingDir, target.executableName)
    copyFileSync(sourceBin, stagedBin)
    copyFileSync(sourceChecksumPath, join(stagingDir, "checksum.json"))
    copyFileSync(sourceProvenancePath, join(stagingDir, "provenance.json"))

    if (process.platform !== "win32") {
      chmodSync(stagedBin, 0o755)
    }

    // ── 5. Validate staged binary before activation ────────────────────────
    // The staged copy must satisfy the FULL trust contract: checksum AND
    // provenance (identity, triple, profile, version, source commit) against
    // the expected target — a present-but-invalid provenance is a hard failure.
    const val = validateFdxBinaryPath(stagedBin, stagingDir, { requireChecksum: true, requireProvenance: true, target })
    if (!val.valid) {
      rmSync(stagingDir, { recursive: true, force: true })
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.error(`✗ Installation FAILED: Validation of staged binary failed: ${val.reason}`)
      return false
    }

    // ── 6. Write install manifest into staging dir ─────────────────────────
    const installManifest = {
      packageName: target.packageName,
      target: `${target.platform}-${target.arch}${target.libc ? `-${target.libc}` : ""}`,
      installedAt: new Date().toISOString(),
      installedBy: "flowdeck-cli",
      sha256: actualSha256,
    }
    writeFileSync(join(stagingDir, "install-manifest.json"), JSON.stringify(installManifest, null, 2), "utf-8")

    // ── 7. Rollback-safe atomic directory activation ───────────────────────
    backupDir = `${cacheDir}.backup-${process.pid}-${Date.now()}`
    const hasExistingCache = existsSync(cacheDir)

    if (hasExistingCache) {
      renameSync(cacheDir, backupDir)
      backupCreated = true
    }

    renameSync(stagingDir, cacheDir)
    cacheActivated = true

    const targetBin = join(cacheDir, target.executableName)
    if (process.platform !== "win32") {
      chmodSync(targetBin, 0o755)
    }

    // ── 7b. Direct activation verification ─────────────────────────────────
    // Verify the activated cache ITSELF against the full trust contract —
    // executable, checksum, provenance, and install manifest — before any
    // higher-priority source (FDX_BINARY_PATH, optional dependency) is
    // consulted. This prevents a broken cache from being masked by an
    // unrelated "available" binary elsewhere.
    const activatedManifestPath = join(cacheDir, "install-manifest.json")
    let directCacheOk = false
    try {
      const manifest = JSON.parse(readFileSync(activatedManifestPath, "utf-8"))
      const manifestTarget = `${target.platform}-${target.arch}${target.libc ? `-${target.libc}` : ""}`
      const manifestOk = manifest?.sha256 === actualSha256 && manifest?.target === manifestTarget
      if (manifestOk) {
        const val = validateFdxBinaryPath(targetBin, cacheDir, { requireChecksum: true, requireProvenance: true, target })
        directCacheOk = val.valid && val.checksumStatus === "pass"
      }
    } catch {
      directCacheOk = false
    }
    if (!directCacheOk) {
      throw new Error("Post-installation verification failed: activated cache failed direct trust validation")
    }

    const verifyStatus = getFdxAvailabilityStatus(true)
    if (verifyStatus.available) {
      newCacheActivated = true
      if (backupCreated && backupDir && existsSync(backupDir)) {
        try { rmSync(backupDir, { recursive: true, force: true }) } catch {}
      }
      if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
      console.log(`✓ FDX native installation successful: ${verifyStatus.binaryPath}`)
      return true
    } else {
      console.error(`✗ Installation FAILED: Post-installation verification failed.`)
      throw new Error("Post-installation verification failed")
    }
  } catch (err: any) {
    console.error(`✗ FDX installation failed: ${err.message}`)

    // ── Emergency Rollback ──────────────────────────────────────────────────
    // P1-5: track cache activation independently from backup creation. On
    // failure, remove any cache directory WE newly activated — including a
    // first install where no backup exists — then restore the backup if one
    // was taken. Evidence of the failed activation is preserved at a separate
    // non-authoritative recovery path rather than deleted outright.
    if (cacheActivated && !newCacheActivated) {
      if (existsSync(cacheDir)) {
        const failedDir = `${cacheDir}.failed-${process.pid}-${Date.now()}`
        try {
          renameSync(cacheDir, failedDir)
          console.log(`  [rollback] Quarantined newly-activated cache to ${failedDir} for inspection.`)
        } catch {
          try { rmSync(cacheDir, { recursive: true, force: true }) } catch {}
        }
      }
      if (backupCreated && backupDir && existsSync(backupDir)) {
        try {
          renameSync(backupDir, cacheDir)
          console.log(`  [rollback] Restored previous cache directory from backup.`)
        } catch (rErr: any) {
          console.error(`  [rollback] CRITICAL: Backup restoration failed: ${rErr.message}. Preserving backup at ${backupDir}`)
        }
      }
    } else if (backupCreated && backupDir && existsSync(backupDir)) {
      // Failure occurred before activation: leave the untouched cache path
      // alone and simply restore the moved-aside backup.
      try {
        renameSync(backupDir, cacheDir)
        console.log(`  [rollback] Restored previous cache directory from backup.`)
      } catch (rErr: any) {
        console.error(`  [rollback] CRITICAL: Backup restoration failed: ${rErr.message}. Preserving backup at ${backupDir}`)
      }
    }

    try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
    if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
    return false
  } finally {
    if (lockToken) releaseInstallLock(lockPath, lockToken)
  }
}
