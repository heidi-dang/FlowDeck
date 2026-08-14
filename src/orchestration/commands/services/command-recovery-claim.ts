import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../../persistence/transaction-manager"

/**
 * Durable single-flight claim for command recovery, built on the canonical
 * `command_idempotency` table (already part of the frozen schema). A fresh
 * runtime must not allow two processes to independently dispatch the same
 * logical Assignment after a restart, so recovery acquires an exclusive
 * claim before continuing execution. The claim is keyed by invocation id and
 * carries a bounded TTL so a crashed recoverer does not block forever.
 */
export class CommandRecoveryClaim {
  private static readonly TTL_SECONDS = 600

  constructor(private readonly db: Database, private readonly tx: TransactionManager) {}

  /** Returns true if this runtime now owns the recovery claim. */
  acquire(invocationId: string): boolean {
    const key = `command-recovery:${invocationId}`
    try {
      // BEGIN IMMEDIATE: the SELECT-then-INSERT must be serialized so two
      // processes cannot both observe a live claim and both proceed.
      return this.tx.writeImmediate(() => {
        const live = this.db
          .query("SELECT 1 FROM command_idempotency WHERE idempotency_key = ? AND status = 'executing' AND started_at >= datetime('now', ?)")
          .get(key, `-${CommandRecoveryClaim.TTL_SECONDS} seconds`)
        if (live) return false
        this.db
          .query(
            `INSERT INTO command_idempotency (idempotency_key, command_type, aggregate_type, aggregate_id, status, started_at, created_ts)
             VALUES (?, 'command_recovery', 'command_invocation', ?, 'executing', datetime('now'), strftime('%s','now'))
             ON CONFLICT(idempotency_key) DO UPDATE SET status='executing', started_at=datetime('now'), completed_at=NULL`,
          )
          .run(key, invocationId)
        return true
      })
    } catch {
      return false
    }
  }

  release(invocationId: string): void {
    const key = `command-recovery:${invocationId}`
    this.tx.write(() => {
      this.db.query("UPDATE command_idempotency SET status='completed', completed_at=datetime('now') WHERE idempotency_key = ?").run(key)
    })
  }
}
