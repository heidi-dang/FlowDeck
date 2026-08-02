/**
 * FDX CLI Administration & Installer Subcommands
 *
 * Implements CLI commands:
 *   flowdeck fdx status
 *   flowdeck fdx install
 *   flowdeck fdx repair
 *   flowdeck fdx verify
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync, renameSync, readFileSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import {
  detectFdxTarget,
  getFdxAvailabilityStatus,
  getFdxCacheDir,
  validateFdxBinaryPath,
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
  // Stage into a sibling directory; atomic rename at the end.
  const stagingDir = `${cacheDir}.staging-${process.pid}-${Date.now()}`

  try {
    mkdirSync(stagingDir, { recursive: true })

    // ── 1. Locate source platform package ──────────────────────────────────
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
      rmSync(stagingDir, { recursive: true, force: true })
      console.error(`✗ Installation FAILED: Could not locate platform package ${target.packageName}.`)
      console.error(`  Ensure ${target.packageName} is installed or present in node_modules.`)
      console.error(`  Run: npm install ${target.packageName}`)
      return false
    }

    // ── 2. Trusted acquisition — verify checksum before staging ────────────
    const sourceChecksumPath = join(sourceBinDir, "checksum.json")
    if (!existsSync(sourceChecksumPath)) {
      rmSync(stagingDir, { recursive: true, force: true })
      console.error(`✗ Installation FAILED: checksum.json missing from ${target.packageName}.`)
      console.error(`  The platform package appears to be corrupt or tampered.`)
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
      console.error(`✗ Installation FAILED: checksum.json is corrupt: ${e.message}`)
      return false
    }

    const sourceBin = join(sourceBinDir, target.executableName)
    const actualSha256 = sha256File(sourceBin)
    if (actualSha256 !== expectedSha256) {
      rmSync(stagingDir, { recursive: true, force: true })
      console.error(`✗ Installation FAILED: Binary checksum mismatch for ${target.packageName}.`)
      console.error(`  Expected: ${expectedSha256}`)
      console.error(`  Actual:   ${actualSha256}`)
      console.error(`  The binary may be corrupt or tampered. Re-install the platform package.`)
      return false
    }

    // ── 3. Require provenance ───────────────────────────────────────────────
    const sourceProvenancePath = join(sourceBinDir, "provenance.json")
    if (!existsSync(sourceProvenancePath)) {
      rmSync(stagingDir, { recursive: true, force: true })
      console.error(`✗ Installation FAILED: provenance.json missing from ${target.packageName}.`)
      console.error(`  The platform package is missing build provenance. Re-install the package.`)
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

    // ── 7. Atomic activation via rename ───────────────────────────────────
    // Remove existing cache dir so rename can succeed on all platforms.
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true })
    }
    renameSync(stagingDir, cacheDir)

    const targetBin = join(cacheDir, target.executableName)
    if (process.platform !== "win32") {
      chmodSync(targetBin, 0o755)
    }

    const verifyStatus = getFdxAvailabilityStatus(true)
    if (verifyStatus.available) {
      console.log(`✓ FDX native installation successful: ${verifyStatus.binaryPath}`)
      return true
    } else {
      console.error(`✗ Installation FAILED: Post-installation verification failed.`)
      return false
    }
  } catch (err: any) {
    try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
    console.error(`✗ FDX installation failed: ${err.message}`)
    return false
  }
}
