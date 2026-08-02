/**
 * FDX CLI Administration & Installer Subcommands
 *
 * Implements CLI commands:
 *   flowdeck fdx status
 *   flowdeck fdx install
 *   flowdeck fdx repair
 *   flowdeck fdx verify
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, renameSync, readFileSync, rmSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  detectFdxTarget,
  getFdxAvailabilityStatus,
  getFdxCacheDir,
  validateFdxBinaryPath,
  validateFdxProvenance,
  FLOWDECK_PACKAGE_VERSION,
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

/** Attempt to download platform package from npm registry with integrity verification. */
function fetchFromRegistry(packageName: string, version: string): { dir: string; tmpDir: string; reason?: string } | null {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
  const npmShell = process.platform === "win32"
  const tmpDir = join(getFdxCacheDir({ platform: process.platform, arch: process.arch, packageName, executableName: "fdx" }), `..`, `.registry-fetch-${Date.now()}`)
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
  const stagingDir = `${cacheDir}.staging-${process.pid}-${Date.now()}`
  let registryFetchTmp: string | null = null
  let backupDir: string | null = null
  let backupCreated = false
  let newCacheActivated = false

  try {
    mkdirSync(stagingDir, { recursive: true })

    // ── 1. Locate source platform package (local search, then registry fallback) ──
    let sourceBinDir: string | null = null
    const searchDirs = [
      process.cwd(),
      join(dirname(new URL(import.meta.url).pathname), "..", ".."),
    ]

    for (const searchDir of searchDirs) {
      const candidateLocal = join(searchDir, "packages", target.packageName.replace("@heidi-dang/", ""))
      if (existsSync(join(candidateLocal, target.executableName))) {
        sourceBinDir = candidateLocal
        break
      }
      const candidateNodeModules = join(searchDir, "node_modules", target.packageName)
      if (existsSync(join(candidateNodeModules, target.executableName))) {
        sourceBinDir = candidateNodeModules
        break
      }
    }

    if (!sourceBinDir) {
      console.log(`ℹ Local platform package ${target.packageName} not found. Attempting trusted registry acquisition...`)
      const regRes = fetchFromRegistry(target.packageName, FLOWDECK_PACKAGE_VERSION)
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
    backupDir = `${cacheDir}.backup-${Date.now()}`
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
  }
}
