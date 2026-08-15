import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { CheckResult } from "../types"

export async function runFilesystemChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  // 1. FlowDeck Config & State Directories
  const flowdeckStateDir = process.env.FLOWDECK_STATE_DIR || join(directory, ".flowdeck")
  if (!existsSync(flowdeckStateDir)) {
    checks.push({
      id: "filesystem.state_dir",
      title: "FlowDeck State Directory",
      category: "filesystem",
      severity: "medium",
      status: "warning",
      detected: "State directory .flowdeck does not exist",
      expected: ".flowdeck directory created",
      recommendation: "Run `flowdeck doctor fix` to pre-create state directories",
      autoFixAvailable: true,
      affectsRuntime: true,
      repairability: "automatic",
      repairAction: "create_state_directories",
    })
  } else {
    // Check write permissions in state dir
    const testFile = join(flowdeckStateDir, `.perm_test_${Date.now()}.tmp`)
    try {
      mkdirSync(flowdeckStateDir, { recursive: true })
      writeFileSync(testFile, "test", "utf-8")
      rmSync(testFile, { force: true })

      checks.push({
        id: "filesystem.permissions",
        title: "FlowDeck Permissions",
        category: "filesystem",
        severity: "info",
        status: "pass",
        detected: "State directory writable",
        expected: "State directory writable",
        recommendation: "Permissions healthy",
        autoFixAvailable: false,
        affectsRuntime: false,
        repairability: "not-applicable",
      })
    } catch {
      checks.push({
        id: "filesystem.permissions",
        title: "FlowDeck Permissions",
        category: "filesystem",
        severity: "critical",
        status: "error",
        detected: `State directory ${flowdeckStateDir} is not writable`,
        expected: "State directory writable",
        recommendation: "Run `flowdeck doctor fix` to fix permissions or check directory ownership",
        autoFixAvailable: true,
        affectsRuntime: true,
        repairability: "automatic",
        repairAction: "fix_file_permissions",
      })
    }
  }

  // 2. Stale Lock Files / PID Files
  const staleLockFiles = [
    join(flowdeckStateDir, "fdx.lock"),
    join(flowdeckStateDir, "orchestration.lock"),
    join(flowdeckStateDir, "browser.lock"),
  ]

  const foundStaleLocks = staleLockFiles.filter((f) => existsSync(f))
  if (foundStaleLocks.length > 0) {
    checks.push({
      id: "filesystem.stale_locks",
      title: "Stale Process Lock Files",
      category: "process",
      severity: "medium",
      status: "warning",
      detected: `Found ${foundStaleLocks.length} potentially stale lock file(s)`,
      expected: "No orphan lock files",
      recommendation: "Run `flowdeck doctor fix` to clean up stale process locks",
      autoFixAvailable: true,
      affectsRuntime: true,
      repairability: "automatic",
      repairAction: "clean_stale_locks",
    })
  }

  return checks
}
