/**
 * FDX CLI Administration & Installer Subcommands
 *
 * Implements CLI commands:
 *   flowdeck fdx status
 *   flowdeck fdx install
 *   flowdeck fdx repair
 *   flowdeck fdx verify
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from "node:fs"
import { join, dirname } from "node:path"
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
  const targetBin = join(cacheDir, target.executableName)
  const tmpDir = `${cacheDir}.tmp-${Date.now()}`

  try {
    mkdirSync(tmpDir, { recursive: true })

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
      // Clean temp
      try {
        const fs = await import("node:fs")
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
      console.error(`✗ Installation FAILED: Could not locate platform package ${target.packageName}.`)
      console.error(`  Ensure ${target.packageName} is installed or present in node_modules/packages directory.`)
      return false
    }

    const tmpBin = join(tmpDir, target.executableName)
    copyFileSync(join(sourceBinDir, target.executableName), tmpBin)
    if (existsSync(join(sourceBinDir, "checksum.json"))) {
      copyFileSync(join(sourceBinDir, "checksum.json"), join(tmpDir, "checksum.json"))
    }
    if (existsSync(join(sourceBinDir, "provenance.json"))) {
      copyFileSync(join(sourceBinDir, "provenance.json"), join(tmpDir, "provenance.json"))
    }

    if (process.platform !== "win32") {
      chmodSync(tmpBin, 0o755)
    }

    // Validate binary inside temporary directory before activation
    const val = validateFdxBinaryPath(tmpBin, tmpDir, true)
    if (!val.valid) {
      try {
        const fs = await import("node:fs")
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {}
      console.error(`✗ Installation FAILED: Validation of acquired binary failed: ${val.reason}`)
      return false
    }

    // Write installation manifest
    const installManifest = {
      packageName: target.packageName,
      target: `${target.platform}-${target.arch}${target.libc ? `-${target.libc}` : ""}`,
      installedAt: new Date().toISOString(),
      installedBy: "flowdeck-cli",
    }
    writeFileSync(join(tmpDir, "install-manifest.json"), JSON.stringify(installManifest, null, 2), "utf-8")

    // Atomic activation
    mkdirSync(cacheDir, { recursive: true })
    copyFileSync(tmpBin, targetBin)
    if (existsSync(join(tmpDir, "checksum.json"))) {
      copyFileSync(join(tmpDir, "checksum.json"), join(cacheDir, "checksum.json"))
    }
    if (existsSync(join(tmpDir, "provenance.json"))) {
      copyFileSync(join(tmpDir, "provenance.json"), join(cacheDir, "provenance.json"))
    }
    writeFileSync(join(cacheDir, "install-manifest.json"), JSON.stringify(installManifest, null, 2), "utf-8")

    if (process.platform !== "win32") {
      chmodSync(targetBin, 0o755)
    }

    // Clean temp
    try {
      const fs = await import("node:fs")
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}

    const verifyStatus = getFdxAvailabilityStatus(true)
    if (verifyStatus.available) {
      console.log(`✓ FDX native installation successful: ${verifyStatus.binaryPath}`)
      return true
    } else {
      console.error(`✗ Installation FAILED: Post-installation verification failed.`)
      return false
    }
  } catch (err: any) {
    try {
      const fs = await import("node:fs")
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
    console.error(`✗ FDX installation failed: ${err.message}`)
    return false
  }
}
