/**
 * Process Liveness and Lock Staleness Utilities
 *
 * Deterministic process checking and lock staleness evaluation.
 * Safe across Linux, macOS, and Windows.
 */

import { existsSync, readFileSync, statSync } from "node:fs"

export interface LockPayload {
  pid?: number
  timestamp?: number
  owner?: string
  [key: string]: unknown
}

/**
 * Check if a process ID is currently alive on the host.
 * Uses signal 0 to test process existence without terminating it.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  // PID 0 or current PID is always alive
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM means the process exists but belongs to another user/permission boundary -> ALIVE
    return err?.code === "EPERM"
  }
}

/**
 * Evaluate whether a lock file on disk is genuinely stale.
 * A lock is STALE if:
 * 1. It contains a PID and that PID is no longer alive.
 * 2. It contains a PID of an active process, but its timestamp/mtime exceeds the TTL.
 * 3. It has no PID, but its file mtime exceeds the TTL.
 *
 * A lock is LIVE (not stale) if:
 * - Its owning PID is alive AND its age is within the TTL.
 */
export function isLockStale(lockPath: string, ttlMs = 60_000): boolean {
  if (!existsSync(lockPath)) return false
  try {
    const raw = readFileSync(lockPath, "utf-8").trim()
    const st = statSync(lockPath)
    const mtimeAge = Date.now() - st.mtimeMs

    if (!raw) {
      return mtimeAge > ttlMs
    }

    let parsed: LockPayload | null = null
    try {
      parsed = JSON.parse(raw) as LockPayload
    } catch {
      const num = parseInt(raw, 10)
      if (!isNaN(num) && num > 0) {
        parsed = { pid: num }
      }
    }

    if (parsed && typeof parsed.pid === "number" && parsed.pid > 0) {
      if (!isPidAlive(parsed.pid)) {
        return true // Dead process -> definitely stale
      }
      const lockTime = typeof parsed.timestamp === "number" && parsed.timestamp > 0 ? parsed.timestamp : st.mtimeMs
      const age = Date.now() - lockTime
      return age > ttlMs // Alive process holding lock beyond TTL
    }

    return mtimeAge > ttlMs
  } catch {
    return false
  }
}
