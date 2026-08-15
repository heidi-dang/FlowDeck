import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"

export class DoctorRepairLock {
  private lockPath: string
  private acquired = false
  private lockTtlMs = 60000 // 60 seconds TTL for stale lock recovery

  constructor(directory: string) {
    const flowdeckDir = process.env.FLOWDECK_STATE_DIR || join(directory, ".flowdeck")
    this.lockPath = join(flowdeckDir, "doctor-repair.lock")
  }

  public acquire(): boolean {
    if (this.acquired) return true

    if (existsSync(this.lockPath)) {
      try {
        const raw = readFileSync(this.lockPath, "utf-8")
        const lockInfo = JSON.parse(raw) as { pid: number; timestamp: number }
        const age = Date.now() - (lockInfo.timestamp || 0)

        // Stale lock recovery
        if (age > this.lockTtlMs) {
          this.release()
        } else {
          return false // Lock held by active process
        }
      } catch {
        this.release() // Corrupt lock file recovery
      }
    }

    try {
      mkdirSync(dirname(this.lockPath), { recursive: true })
      const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() })
      writeFileSync(this.lockPath, payload, { flag: "wx", encoding: "utf-8" })
      this.acquired = true
      return true
    } catch {
      return false
    }
  }

  public release(): void {
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath)
      }
    } catch {
      // ignore
    } finally {
      this.acquired = false
    }
  }
}
