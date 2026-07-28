/**
 * In-memory + file-backed repair state store.
 * Persists to .fd-plan/<slug>/pr-monitor-state.json for survival across restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { planningDir } from "../../tools/planning-state-lib"
import type { RepairRun, RepairTerminal } from "./types"
import { buildRepairKey } from "./types"

const STATE_FILE = "pr-monitor-state.json"

export class RepairStateStore {
  private runs: Map<string, RepairRun> = new Map()
  private dirty = false
  private persistPath: string | null = null
  private persistInterval: ReturnType<typeof setInterval> | null = null

  constructor(directory?: string) {
    if (directory) {
      const dir = planningDir(directory)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      this.persistPath = join(dir, STATE_FILE)
      this.load()
      this.persistInterval = setInterval(() => this.flush(), 5_000)
    }
  }

  get(key: string): RepairRun | undefined {
    return this.runs.get(key)
  }

  set(run: RepairRun): void {
    this.runs.set(run.repair_key, run)
    this.dirty = true
  }

  updateState(key: string, state: RepairTerminal): RepairRun | undefined {
    const run = this.runs.get(key)
    if (run) {
      run.state = state
      run.updated_at = new Date().toISOString()
      this.dirty = true
    }
    return run
  }

  getByPr(repo: string, prNumber: number): RepairRun[] {
    const results: RepairRun[] = []
    for (const run of this.runs.values()) {
      if (run.repo === repo && run.pr_number === prNumber) {
        results.push(run)
      }
    }
    return results.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  hasActiveRepair(repo: string, prNumber: number, headSha: string): boolean {
    const key = buildRepairKey(repo, prNumber, headSha)
    const run = this.runs.get(key)
    return run !== undefined && !isTerminal(run.state)
  }

  attemptCount(repo: string, prNumber: number, headSha: string): number {
    const key = buildRepairKey(repo, prNumber, headSha)
    return this.runs.get(key)?.attempt_count ?? 0
  }

  activeRepairCount(): number {
    let count = 0
    for (const run of this.runs.values()) {
      if (!isTerminal(run.state)) count++
    }
    return count
  }

  recentRuns(limit = 10): RepairRun[] {
    return [...this.runs.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
  }

  allRuns(): RepairRun[] {
    return [...this.runs.values()]
  }

  dispose(): void {
    if (this.persistInterval) clearInterval(this.persistInterval)
    this.flush()
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return
    try {
      const raw = readFileSync(this.persistPath, "utf-8")
      const parsed = JSON.parse(raw) as RepairRun[]
      for (const run of parsed) {
        this.runs.set(run.repair_key, run)
      }
    } catch { /* corrupt file — start fresh */ }
  }

  private flush(): void {
    if (!this.dirty || !this.persistPath) return
    try {
      const data = JSON.stringify([...this.runs.values()], null, 2)
      writeFileSync(this.persistPath, data, "utf-8")
      this.dirty = false
    } catch { /* best-effort */ }
  }
}

function isTerminal(state: RepairTerminal): boolean {
  const terminals: RepairTerminal[] = [
    "GREEN", "BLOCKED", "STALE_HEAD", "MAX_ATTEMPTS_REACHED",
    "INFRASTRUCTURE_FAILURE", "MODEL_FAILED", "LOCAL_VALIDATION_FAILED",
  ]
  return terminals.includes(state)
}

export function createDefaultStateStore(): RepairStateStore {
  return new RepairStateStore(process.cwd())
}
