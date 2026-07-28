/**
 * Per-SHA repair lock to prevent concurrent repairs on the same PR head.
 */

import { buildRepairKey } from "./types"

export class RepairLock {
  private locks = new Set<string>()

  acquire(repo: string, prNumber: number, headSha: string): boolean {
    const key = buildRepairKey(repo, prNumber, headSha)
    if (this.locks.has(key)) return false
    this.locks.add(key)
    return true
  }

  release(repo: string, prNumber: number, headSha: string): void {
    const key = buildRepairKey(repo, prNumber, headSha)
    this.locks.delete(key)
  }

  isLocked(repo: string, prNumber: number, headSha: string): boolean {
    const key = buildRepairKey(repo, prNumber, headSha)
    return this.locks.has(key)
  }

  count(): number {
    return this.locks.size
  }

  clear(): void {
    this.locks.clear()
  }
}
