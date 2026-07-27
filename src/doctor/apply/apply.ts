import type { CheckResult, AutoFixResult, DoctorOptions } from "../types"
import { execFileSync } from "child_process"

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
