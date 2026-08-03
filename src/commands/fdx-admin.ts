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
  } catch {
    // Lock vanished between EEXIST and read — retry the exclusive create.
    return { recoverable: true, raw: null }
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
    // A different lock was quarantined — restore it for its true owner.
    try { renameSync(quarantinePath, lockPath) } catch {}
    return "contended"
  }
  rmSync(quarantinePath, { force: true })
  return "recovered"
}

/**
 * Acquire a per-target install lock.
 *
 * Ownership-safe protocol:
 *   1. Write the complete lock metadata (schema, pid, timestamp, random
 *      ownership token, target identity) to a unique sibling temporary file and
 *      fsync it — observers never see a partially written lock.
 *   2. Atomically activate the lock without replacing an existing lock
 *      (hard-link creation; direct O_EXCL fallback for platforms without hard
 *      links, where the bounded grace interval protects observers).
 *   3. On contention, classify the existing lock:
 *        - live owner, unknown liveness, fresh malformed/empty, or
 *          incompatible schema → fail closed;
 *        - confirmed dead owner or old malformed lock → atomic recovery via
 *          quarantine + identity re-verification, then retry the exclusive
 *          create. Ownership is granted only by the exclusive create, never by
 *          deleting a lock.
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

  try {
    const fd = openSync(tmpPath, "wx")
    try {
      writeFileSync(fd, payload, "utf-8")
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (e: any) {
    return { ok: false, reason: "lock-tmp-write-error", detail: e?.message }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      linkSync(tmpPath, lockPath)
      rmSync(tmpPath, { force: true })
      return { ok: true, token }
    } catch (e: any) {
      if (e?.code !== "EEXIST") {
        // Hard links unavailable (e.g. non-NTFS volumes on Windows): fall back
        // to direct exclusive creation. The bounded grace interval protects
        // observers from the brief window before the metadata is written.
        try {
          const fd = openSync(lockPath, "wx")
          try {
            writeFileSync(fd, payload, "utf-8")
            fsyncSync(fd)
          } finally {
            closeSync(fd)
          }
          rmSync(tmpPath, { force: true })
          return { ok: true, token }
        } catch (e2: any) {
          rmSync(tmpPath, { force: true })
          if (e2?.code === "EEXIST") continue
          return { ok: false, reason: "lock-activation-error", detail: e2?.message }
        }
      }

      const cls = classifyExistingLock(lockPath)
      if (!cls.recoverable) {
        rmSync(tmpPath, { force: true })
        return { ok: false, reason: cls.reason, detail: cls.detail }
      }
      if (cls.raw === null) continue // Lock vanished — retry the exclusive create.

      const rec = recoverStaleLock(lockPath, cls.raw)
      if (rec === "error") {
        rmSync(tmpPath, { force: true })
        return { ok: false, reason: "lock-recovery-error", detail: "Stale lock recovery failed; preserved evidence and failed closed." }
      }
      // "recovered" or "contended" → retry the exclusive create; the create is
      // the single arbiter of ownership.
      continue
    }
  }
  rmSync(tmpPath, { force: true })
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
      metaRaw = execFileSync(npmCmd, ["view", `${packageName}@${version}`, "--json"], { cwd: tmpDir, encoding: "utf-8", shell: npmShell, stdio: ["pipe", "pipe", "pipe"] })
    } catch (e: any) {
      const msg = e.stderr?.toString() ?? e.message ?? ""
      if (msg.includes("404") || msg.includes("E404") || msg.includes("Not Found")) {
        console.error(`  [registry] Failure: package version missing (${packageName}@${version})`)
      } else if (msg.includes("401") || msg.includes("403") || msg.includes("EAUTH")) {
        console.error(`  [registry] Failure: authentication failure`)
      } else {
        console.error(`  [registry] Failure: registry unavailable (${msg.trim().split("\n")[0]})`)
      }
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    let meta: any = {}
    try {
      meta = JSON.parse(metaRaw)
    } catch {}

    const dist = meta.dist ?? {}
    const expectedIntegrity = dist.integrity // sha512-...
    const expectedShasum = dist.shasum

    if (!expectedIntegrity && !expectedShasum) {
      console.error(`  [registry] Failure: integrity metadata missing from registry response`)
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    // 2. Download exact tarball
    execFileSync(npmCmd, ["pack", `${packageName}@${version}`], { cwd: tmpDir, shell: npmShell, stdio: "ignore" })
    const files = readdirSync(tmpDir).filter(f => f.endsWith(".tgz"))
    if (files.length !== 1) {
      console.error(`  [registry] Failure: extraction failure (expected 1 .tgz, got ${files.length})`)
      rmSync(tmpDir, { recursive: true, force: true })
      return null
    }

    const tgzPath = join(tmpDir, files[0])
    const tgzBuf = readFileSync(tgzPath)

    // 3. Verify downloaded tarball integrity against registry metadata
    if (expectedIntegrity) {
      const algoMatch = expectedIntegrity.match(/^(sha512|sha256)-(.+)$/)
      if (algoMatch) {
        const algo = algoMatch[1]
        const expectedB64 = algoMatch[2]
        const actualB64 = createHash(algo).update(tgzBuf).digest("base64")
        if (actualB64 !== expectedB64) {
          console.error(`  [registry] Failure: integrity mismatch (expected ${expectedIntegrity}, got ${algo}-${actualB64})`)
          rmSync(tmpDir, { recursive: true, force: true })
          return null
        }
      }
    } else if (expectedShasum) {
      const actualShasum = createHash("sha1").update(tgzBuf).digest("hex")
      if (actualShasum !== expectedShasum) {
        console.error(`  [registry] Failure: integrity mismatch (shasum expected ${expectedShasum}, got ${actualShasum})`)
        rmSync(tmpDir, { recursive: true, force: true })
        return null
      }
    }

    // 4. Extract exact tarball safely without wildcard expansion
    execFileSync("tar", ["xzf", files[0]], { cwd: tmpDir, stdio: "ignore" })
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
    console.error(`  If no other install is running, delete the stale lock file and retry.`)
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

    const provVal = validateFdxProvenance(provenanceData, target, actualSha256, readFileSync(sourceBin).length)
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
    const val = validateFdxBinaryPath(stagedBin, stagingDir, true)
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

    const targetBin = join(cacheDir, target.executableName)
    if (process.platform !== "win32") {
      chmodSync(targetBin, 0o755)
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
    if (backupCreated && !newCacheActivated) {
      if (existsSync(cacheDir)) {
        try { rmSync(cacheDir, { recursive: true, force: true }) } catch {}
      }
      if (backupDir && existsSync(backupDir)) {
        try {
          renameSync(backupDir, cacheDir)
          console.log(`  [rollback] Restored previous cache directory from backup.`)
        } catch (rErr: any) {
          console.error(`  [rollback] CRITICAL: Backup restoration failed: ${rErr.message}. Preserving backup at ${backupDir}`)
        }
      }
    }

    try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
    if (registryFetchTmp) try { rmSync(registryFetchTmp, { recursive: true, force: true }) } catch {}
    return false
  } finally {
    if (lockToken) releaseInstallLock(lockPath, lockToken)
  }
}
