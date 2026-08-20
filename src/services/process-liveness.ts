/**
 * Process Liveness and Lock Staleness Utilities
 *
 * Deterministic process checking and lock staleness evaluation.
 * Safe across Linux, macOS, and Windows.
 *
 * Contract A (Live-Owner Precedence):
 * - If a lock file records an owning PID and that process is currently ALIVE on the host,
 *   the lock is authoritative and active (NOT stale), regardless of wall-clock age.
 *   Doctor repair must NEVER delete a lock held by a live, executing FlowDeck process.
 * - If the owning PID is dead (process no longer exists), the lock is STALE and safely reclaimable.
 * - If no valid PID is recorded (legacy/empty lock), file age exceeding TTL determines staleness.
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
 *
 * @param lockPath Path to the lock file
 * @param ttlMs Fallback TTL for PID-less / unparseable lock files (default: 60,000ms)
 * @returns true if the lock is proven stale and safe to unlink; false if actively owned or ambiguous
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
      // Contract A (Live-Owner Precedence):
      // If the process is alive on the system, the lock is LIVE and MUST NOT be deleted.
      if (isPidAlive(parsed.pid)) {
        return false
      }
      // Process is dead -> lock is definitely stale
      return true
    }

    // No PID recorded: fallback to mtime exceeding TTL
    return mtimeAge > ttlMs
  } catch {
    // Ambiguous read/permission error: fail safe (do not delete)
    return false
  }
}
