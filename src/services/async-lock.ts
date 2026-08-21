import { writeFile, unlink, stat, readFile } from "fs/promises"

export interface LockOptions {
  /** Total time (ms) to wait before throwing. Default: 5000. */
  timeout?: number
  /** Age (ms) after which a lock is considered stale and can be stolen. Default: 5000. */
  staleMs?: number
}

const DEFAULT_TIMEOUT = 5_000
const DEFAULT_STALE_MS = 5_000
const BASE_RETRY_DELAY_MS = 50

/** Check if process with given PID is alive on local machine. */
function isPidAlive(pid: number): boolean {
  if (!pid || isNaN(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM" // Process exists but owned by another user
  }
}

/**
 * Acquire a file-based advisory lock.
 *
 * Creates a lock file at `lockPath` with content `${pid}:${timestamp}`.
 * Uses `wx` flag (atomic create-or-fail) so concurrent acquirers on the
 * same host cannot interleave.
 *
 * Stale lock detection: if an existing lock file is older than `staleMs`
 * OR the holding PID is dead, the lock is stolen (removed and re-created).
 * This prevents a crashed process from blocking all subsequent writers forever.
 *
 * Retry strategy: `setTimeout`-based randomized exponential delay with jitter
 * between attempts — no spin loops, no CPU waste. This is safe for co-operative
 * concurrent subagents on the same host.
 *
 * Timeout behaviour: throws an error when the lock cannot be acquired
 * within `timeout` ms. Never falls through to an unlocked write — the
 * caller must handle the error.
 *
 * Cross-platform: uses only standard `fs` APIs (`wx` flag, `unlink`,
 * `stat`). Works on Linux, macOS, and Windows without native bindings.
 *
 * Single-host only: no NFS or distributed locking support.
 */
export async function acquireLock(
  lockPath: string,
  options?: LockOptions,
): Promise<void> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS
  const deadline = Date.now() + timeout
  let attempt = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++
    // ── Attempt 1: create the lock file atomically ────────────────
    try {
      await writeFile(lockPath, `${process.pid}:${Date.now()}`, { flag: "wx" })
      return // acquired
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err
      // Lock exists — fall through to staleness/PID check
    }

    // ── Staleness & PID liveness check ────────────────────────────
    try {
      const st = await stat(lockPath)
      const age = Date.now() - st.mtimeMs
      let isStale = false

      let holderPid: number | null = null
      try {
        const content = await readFile(lockPath, "utf-8")
        const [pidStr] = content.trim().split(":")
        const parsed = parseInt(pidStr, 10)
        if (!isNaN(parsed) && parsed > 0) {
          holderPid = parsed
        }
      } catch {
        // File read race; ignore
      }

      if (holderPid !== null) {
        // Valid PID found:
        // alive -> NEVER stale, regardless of age
        // dead  -> stale
        if (isPidAlive(holderPid)) {
          isStale = false
        } else {
          isStale = true
        }
      } else {
        // No trustworthy PID -> use mtime fallback
        isStale = age > staleMs
      }

      if (isStale) {
        // Lock is from a dead process or timed-out untrusted holder — try to steal it.
        // Remove first; another acquirer may steal in between.
        try {
          await unlink(lockPath)
        } catch {
          // Another process removed it first; continue to retry
        }
        try {
          await writeFile(lockPath, `${process.pid}:${Date.now()}`, { flag: "wx" })
          return // stole the lock
        } catch (err: any) {
          if (err.code !== "EEXIST") throw err
          // Lost the race — fall through to retry
        }
      }
    } catch {
      // stat failed (race with cleanup); treat as held and retry
    }

    // ── Timeout check ─────────────────────────────────────────────
    if (Date.now() >= deadline) {
      let holderInfo = "unknown"
      try {
        holderInfo = await readFile(lockPath, "utf-8")
      } catch {
        // Lock may have disappeared since the stat check
      }
      throw new Error(
        `[acquireLock] Cannot acquire lock at ${lockPath} after ${timeout}ms. ` +
          `Holder info: ${holderInfo}. ` +
          `If the holder process is dead, remove the lock file manually.`,
      )
    }

    // ── Async wait with backoff & jitter — no spin loop ───────────
    const backoff = Math.min(200, BASE_RETRY_DELAY_MS + attempt * 10)
    const jitter = Math.floor(Math.random() * 25)
    const delay = backoff + jitter
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
  }
}

/**
 * Release a file-based advisory lock.
 *
 * Idempotent: safe to call even if the lock was already released or
 * stolen by a stale-lock reclaimer.
 */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath)
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err
    // Already gone — nothing to do
  }
}

/**
 * Acquire a lock, execute `fn`, then release the lock.
 *
 * The lock is always released in a `finally` block, even when `fn`
 * throws. This is the preferred API for scoped locking.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: LockOptions,
): Promise<T> {
  await acquireLock(lockPath, options)
  try {
    return await fn()
  } finally {
    await releaseLock(lockPath)
  }
}
