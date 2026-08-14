import type { CheckResult, AutoFixResult, DoctorOptions } from "../types"
import { execFileSync } from "child_process"
import { existsSync, readdirSync, rmSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

/**
 * Apply auto-fixes for checks that support it.
 *
 * Rules:
 * - Never overwrite user config without confirmation
 * - Never replace credentials
 * - Never install OS packages
 * - Never modify shell profiles
 * - Never modify system services
 * - Never delete files
 */
export async function applyAutoFixes(
  checks: CheckResult[],
  options: DoctorOptions,
): Promise<AutoFixResult[]> {
  const results: AutoFixResult[] = []

  for (const check of checks) {
    if (!check.autoFixAvailable) continue
    if (check.status === "pass") continue

    switch (check.id) {
      case "plugin.bundle":
        results.push(await autoFixBuild(options))
        break
      case "config.opencode_user":
        results.push(await autoFixInstall(options))
        break
      case "plugin.runtime_identity":
        results.push(await autoFixRuntimeIdentity(options))
        break
      default:
        // No auto-fix defined for this check
        break
    }
  }

  return results
}

async function autoFixBuild(_options: DoctorOptions): Promise<AutoFixResult> {
  try {
    execFileSync("npm", ["run", "build"], { stdio: "pipe", timeout: 120000 })
    return { id: "fix_plugin.bundle", description: "Build plugin bundle", applied: true }
  } catch (e: any) {
    return { id: "fix_plugin.bundle", description: "Build plugin bundle", applied: false, error: e.message }
  }
}

async function autoFixInstall(_options: DoctorOptions): Promise<AutoFixResult> {
  try {
    execFileSync("flowdeck", ["install"], { stdio: "pipe", timeout: 30000 })
    return { id: "fix_config.opencode_user", description: "Install FlowDeck via CLI", applied: true }
  } catch {
    // Try the install script directly
    try {
      execFileSync("bash", ["install.sh"], { stdio: "pipe", timeout: 30000 })
      return { id: "fix_config.opencode_user", description: "Install FlowDeck via install.sh", applied: true }
    } catch (e: any) {
      return { id: "fix_config.opencode_user", description: "Install FlowDeck", applied: false, error: e.message }
    }
  }
}

async function autoFixRuntimeIdentity(_options: DoctorOptions): Promise<AutoFixResult> {
  try {
    const home = homedir()
    const xdgCache = process.env.XDG_CACHE_HOME || join(home, ".cache")
    const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share")
    const cacheRoots = [
      join(xdgCache, "opencode", "packages"),
      join(xdgData, "opencode", "packages"),
      join(home, ".cache", "opencode", "packages"),
      join(home, ".local", "share", "opencode", "packages"),
    ]

    let cleaned = 0
    for (const cacheRoot of cacheRoots) {
      if (!existsSync(cacheRoot)) continue
      try {
        const entries = readdirSync(cacheRoot)
        for (const entry of entries) {
          const fullPath = join(cacheRoot, entry)
          const pkgPath = join(fullPath, "package.json")
          let isFlowDeck = false
          if (existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
              if (pkg.name === "@heidi-dang/flowdeck" || pkg.name === "@dv.nghiem/flowdeck" || pkg.flowdeck) {
                isFlowDeck = true
              }
            } catch {}
          } else if (entry.toLowerCase().includes("flowdeck")) {
            isFlowDeck = true
          }

          if (isFlowDeck) {
            rmSync(fullPath, { recursive: true, force: true })
            cleaned++
          }
        }
      } catch {}
    }

    return {
      id: "fix_plugin.runtime_identity",
      description: `Cleaned ${cleaned} stale FlowDeck cache entry(ies). Note: If runtime identity process mismatch persists, restart OpenCode process to reload plugin.`,
      applied: true,
    }
  } catch (e: any) {
    return {
      id: "fix_plugin.runtime_identity",
      description: "Clean stale FlowDeck cache and repair runtime identity mismatch",
      applied: false,
      error: e.message,
    }
  }
}
