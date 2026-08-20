import { runDoctor } from "../doctor"
import { DoctorRepairLock } from "./repair-lock"
import { DoctorBackupManager } from "./atomic-backup"
import { repairPermissions } from "./repairers/permissions-repairer"
import { repairStaleLocks } from "./repairers/stale-locks-repairer"
import { repairPluginRegistration } from "./repairers/plugin-registration-repairer"
import { repairSkillsAndLockfile } from "./repairers/skills-repairer"
import { repairFdxBinary } from "./repairers/fdx-repairer"
import { repairMcpConfiguration } from "./repairers/mcp-repairer"
import type {
  AutoFixResult,
  CheckResult,
  DoctorFixResult,
  DoctorOptions,
  RepairPlan,
  RepairPlanItem,
} from "../types"
import { join } from "node:path"
import { homedir } from "node:os"

export class DoctorRepairOrchestrator {
  private directory: string
  private options: DoctorOptions
  private lock: DoctorRepairLock
  private backupManager: DoctorBackupManager

  constructor(directory: string, options: DoctorOptions = {}) {
    this.directory = directory
    this.options = options
    this.lock = new DoctorRepairLock(directory)
    this.backupManager = new DoctorBackupManager(directory)
  }

  public async executeRepair(): Promise<DoctorFixResult> {
    const maxPasses = 3
    const appliedFixes: AutoFixResult[] = []

    // 1. Acquire Doctor repair lock
    if (!this.lock.acquire()) {
      const initialReport = await runDoctor(this.directory, this.options)
      return {
        timestamp: new Date().toISOString(),
        initialReport,
        repairPlan: this.buildRepairPlan(initialReport.checks),
        appliedFixes: [],
        passesExecuted: 0,
        maxPasses,
        terminatedReason: "lock_failed",
        finalReport: initialReport,
        healthy: false,
      }
    }

    try {
      // 2. Initial Doctor Audit
      const initialReport = await runDoctor(this.directory, this.options)
      const repairPlan = this.buildRepairPlan(initialReport.checks)

      if (this.options.dryRun) {
        return {
          timestamp: new Date().toISOString(),
          initialReport,
          repairPlan,
          appliedFixes: [],
          passesExecuted: 0,
          maxPasses,
          terminatedReason: "all_repaired",
          finalReport: initialReport,
          healthy: initialReport.summary.errors === 0,
        }
      }

      // 3. Backup mutable config files before mutation
      const configDir = process.env.OPENCODE_CONFIG_DIR ||
        (process.env.XDG_CONFIG_HOME
          ? join(process.env.XDG_CONFIG_HOME, "opencode")
          : join(homedir(), ".config", "opencode"))

      const backupFiles = [
        join(configDir, "opencode.json"),
        join(this.directory, "package.json"),
        join(this.directory, "src", "skills", "skills-lock.json"),
      ]
      const backupRecord = this.backupManager.createBackup(backupFiles)

      // 4. Bounded Repair Pass Loop
      let passesExecuted = 0
      let lastUnresolvedCount = Infinity
      let currentReport = initialReport

      while (passesExecuted < maxPasses) {
        passesExecuted++
        const checkToRepair = currentReport.checks.filter(
          (c) => c.status === "error" || c.status === "warning",
        )

        const unresolvedActionable = checkToRepair.filter(
          (c) => c.autoFixAvailable || c.repairability === "automatic",
        )

        if (unresolvedActionable.length === 0) {
          break // All repairable issues fixed
        }

        // Circuit breaker: no progress made in consecutive pass
        if (unresolvedActionable.length >= lastUnresolvedCount && passesExecuted > 1) {
          break
        }
        lastUnresolvedCount = unresolvedActionable.length

        // Execute repairs for actionable check IDs
        for (const check of unresolvedActionable) {
          const fixRes = await this.dispatchRepairer(check)
          if (fixRes) {
            appliedFixes.push(fixRes)
          }
        }

        // 5. Post-pass verification audit
        currentReport = await runDoctor(this.directory, this.options)
      }

      // 6. Post-repair Functional Smoke Verification
      const healthy = currentReport.summary.errors === 0

      // Rollback if repair introduced new critical errors
      if (!healthy && backupRecord && currentReport.summary.errors > initialReport.summary.errors) {
        this.backupManager.restoreBackup(backupRecord)
        const rolledBackReport = await runDoctor(this.directory, this.options)
        return {
          timestamp: new Date().toISOString(),
          initialReport,
          repairPlan,
          appliedFixes,
          passesExecuted,
          maxPasses,
          terminatedReason: "error",
          finalReport: rolledBackReport,
          healthy: false,
        }
      }

      return {
        timestamp: new Date().toISOString(),
        initialReport,
        repairPlan,
        appliedFixes,
        passesExecuted,
        maxPasses,
        terminatedReason: healthy ? "all_repaired" : (passesExecuted >= maxPasses ? "max_passes_reached" : "all_repaired"),
        finalReport: currentReport,
        healthy,
      }
    } finally {
      this.lock.release()
    }
  }

  public buildRepairPlan(checks: CheckResult[]): RepairPlan {
    const items: RepairPlanItem[] = []

    for (const check of checks) {
      if (check.status === "error" || check.status === "warning") {
        const item: RepairPlanItem = {
          checkId: check.id,
          title: check.title,
          category: check.category,
          repairability: check.repairability ?? (check.autoFixAvailable ? "automatic" : "manual"),
          repairAction: check.repairAction ?? check.recommendation ?? "Inspect and repair manually",
          requiresPrivilege: check.repairability === "requires-privilege",
          requiresAuth: check.repairability === "requires-auth",
        }
        items.push(item)
      }
    }

    return {
      timestamp: new Date().toISOString(),
      items,
      automaticItems: items.filter((i) => i.repairability === "automatic"),
      requiresAuthItems: items.filter((i) => i.repairability === "requires-auth"),
      requiresPrivilegeItems: items.filter((i) => i.repairability === "requires-privilege"),
      manualItems: items.filter((i) => i.repairability === "manual"),
    }
  }

  private async dispatchRepairer(check: CheckResult): Promise<AutoFixResult | null> {
    const id = check.id

    if (id.startsWith("filesystem.permissions")) {
      return repairPermissions(this.directory)
    }
    if (id.startsWith("filesystem.stale_locks") || id.startsWith("filesystem.state_dir") || id.startsWith("process.stale_locks")) {
      return repairStaleLocks(this.directory)
    }
    if (id.startsWith("plugin.") || id.startsWith("repo.package") || id.startsWith("config.opencode_user")) {
      return repairPluginRegistration(this.directory)
    }
    if (id.startsWith("skills.")) {
      return repairSkillsAndLockfile(this.directory)
    }
    if (id.startsWith("fdx.")) {
      return repairFdxBinary(this.directory)
    }
    if (id.startsWith("mcp.")) {
      return repairMcpConfiguration(this.directory)
    }

    return null
  }
}
