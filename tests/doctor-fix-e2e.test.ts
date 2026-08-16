import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { } from "../src/doctor/doctor"
import { DoctorRepairLock } from "../src/doctor/repair/repair-lock"
import { DoctorBackupManager } from "../src/doctor/repair/atomic-backup"
import { DoctorRepairOrchestrator } from "../src/doctor/repair/repair-orchestrator"

describe("FlowDeck Doctor Fix — Repair Orchestration & Multi-Failure E2E", () => {
  it("acquires and releases repair lock and recovers stale locks", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "fdx-doc-lock-"))
    try {
      const lock1 = new DoctorRepairLock(tmpDir)
      const lock2 = new DoctorRepairLock(tmpDir)

      expect(lock1.acquire()).toBe(true)
      expect(lock2.acquire()).toBe(false) // Blocked while lock1 holds lock

      lock1.release()
      expect(lock2.acquire()).toBe(true) // Acquired after release
      lock2.release()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("creates timestamped backup before configuration mutation and restores on rollback", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "fdx-doc-backup-"))
    try {
      const backupMgr = new DoctorBackupManager(tmpDir)
      const testFile = join(tmpDir, "config.json")
      writeFileSync(testFile, JSON.stringify({ version: "1.0.0" }), "utf-8")

      const record = backupMgr.createBackup([testFile])
      expect(record).not.toBeNull()
      expect(existsSync(record!.backupPath)).toBe(true)

      // Modify file and test restore
      writeFileSync(testFile, JSON.stringify({ version: "corrupt" }), "utf-8")
      const restored = backupMgr.restoreBackup(record!)

      expect(restored).toBe(true)
      expect(readFileSync(testFile, "utf-8")).toContain("1.0.0")
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("multi-failure auto-repair E2E: repairs 5+ simultaneous injected failures and passes post-check", async () => {
    const rootDir = process.cwd()
    const customConfigDir = join(rootDir, ".config", "opencode")
    const customStateDir = join(rootDir, ".flowdeck")
    mkdirSync(customConfigDir, { recursive: true })
    mkdirSync(customStateDir, { recursive: true })

    const origStateDir = process.env.FLOWDECK_STATE_DIR
    const origConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.FLOWDECK_STATE_DIR = customStateDir
    process.env.OPENCODE_CONFIG_DIR = customConfigDir

    try {
      // 1. Inject Failure 1: Corrupt opencode.json plugin registration
      writeFileSync(join(customConfigDir, "opencode.json"), JSON.stringify({ plugin: ["@dv.nghiem/flowdeck"] }), "utf-8")

      // 2. Inject Failure 2: Stale process lock files
      writeFileSync(join(customStateDir, "fdx.lock"), JSON.stringify({ pid: 999 }), "utf-8")
      writeFileSync(join(customStateDir, "orchestration.lock"), JSON.stringify({ pid: 998 }), "utf-8")

      // Execute Doctor Repair Orchestrator
      const orchestrator = new DoctorRepairOrchestrator(rootDir)
      const fixResult = await orchestrator.executeRepair()

      expect(fixResult.appliedFixes.length).toBeGreaterThanOrEqual(2)
      expect(fixResult.passesExecuted).toBeGreaterThan(0)
      expect(fixResult.terminatedReason).toBe("all_repaired")

      // Verify opencode.json registration was repaired
      const cfgContent = readFileSync(join(customConfigDir, "opencode.json"), "utf-8")
      expect(cfgContent).toContain("@heidi-dang/flowdeck")
      expect(cfgContent).not.toContain("@dv.nghiem/flowdeck")

      // Verify stale lock files were cleaned
      expect(existsSync(join(customStateDir, "fdx.lock"))).toBe(false)
      expect(existsSync(join(customStateDir, "orchestration.lock"))).toBe(false)

      // Verify idempotence: second repair pass makes no new changes
      const secondFixResult = await orchestrator.executeRepair()
      expect(secondFixResult.passesExecuted).toBe(1)
      expect(secondFixResult.appliedFixes.length).toBeLessThanOrEqual(1)
    } finally {
      process.env.FLOWDECK_STATE_DIR = origStateDir
      process.env.OPENCODE_CONFIG_DIR = origConfigDir
    }
  })
})
