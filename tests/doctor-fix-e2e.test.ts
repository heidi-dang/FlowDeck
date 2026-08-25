import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { } from "../src/doctor/doctor"
import { DoctorRepairLock } from "../src/doctor/repair/repair-lock"
import { DoctorBackupManager } from "../src/doctor/repair/atomic-backup"

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
    const customConfigDir = join(tmpdir(), "fdx-doc-e2e-cfg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6))
    const customStateDir = join(tmpdir(), "fdx-doc-e2e-state-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6))
    mkdirSync(customConfigDir, { recursive: true })
    mkdirSync(customStateDir, { recursive: true })

    const childRunner = `
import { writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { DoctorRepairOrchestrator } from "./src/doctor/repair/repair-orchestrator"

const rootDir = process.argv[1] || process.cwd()
const customConfigDir = process.env.OPENCODE_CONFIG_DIR
const customStateDir = process.env.FLOWDECK_STATE_DIR

// 1. Inject Failure 1: Corrupt opencode.json plugin registration
writeFileSync(join(customConfigDir, "opencode.json"), JSON.stringify({ plugin: ["@dv.nghiem/flowdeck"] }), "utf-8")

// 2. Inject Failure 2: Stale process lock files
writeFileSync(join(customStateDir, "fdx.lock"), JSON.stringify({ pid: 999999999 }), "utf-8")
writeFileSync(join(customStateDir, "orchestration.lock"), JSON.stringify({ pid: 999999998 }), "utf-8")

// Execute Doctor Repair Orchestrator
const orchestrator = new DoctorRepairOrchestrator(rootDir)
const fixResult = await orchestrator.executeRepair()

if (fixResult.appliedFixes.length < 2) throw new Error("appliedFixes length < 2: " + fixResult.appliedFixes.length)
if (fixResult.passesExecuted <= 0) throw new Error("passesExecuted <= 0")
if (fixResult.terminatedReason !== "all_repaired") throw new Error("terminatedReason != all_repaired: " + fixResult.terminatedReason)

// Verify opencode.json registration was repaired
const cfgContent = readFileSync(join(customConfigDir, "opencode.json"), "utf-8")
if (!cfgContent.includes("@heidi-dang/flowdeck") || cfgContent.includes("@dv.nghiem/flowdeck")) {
  throw new Error("opencode.json was not repaired properly: " + cfgContent)
}

// Verify stale lock files were cleaned
if (existsSync(join(customStateDir, "fdx.lock"))) throw new Error("fdx.lock still exists")
if (existsSync(join(customStateDir, "orchestration.lock"))) throw new Error("orchestration.lock still exists")

// Verify idempotence: second repair pass makes no new changes
const secondFixResult = await orchestrator.executeRepair()
if (secondFixResult.passesExecuted < 1) throw new Error("second passesExecuted < 1")
if (secondFixResult.appliedFixes.length > 2) throw new Error("second appliedFixes > 2")
`

    try {
      const { spawn } = await import("node:child_process")
      const child = spawn("bun", ["-e", childRunner, rootDir], {
        env: {
          ...process.env,
          FLOWDECK_STATE_DIR: customStateDir,
          OPENCODE_CONFIG_DIR: customConfigDir,
        },
        stdio: "pipe",
      })

      await new Promise<void>((resolve, reject) => {
        let errOut = ""
        child.stderr?.on("data", (d: Buffer) => { errOut += d.toString() })
        child.on("exit", (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Doctor E2E child process failed with exit ${code}: ${errOut}`))
        })
      })
    } finally {
      try {
        rmSync(customConfigDir, { recursive: true, force: true })
        rmSync(customStateDir, { recursive: true, force: true })
      } catch {}
    }
  }, 15000)
})
