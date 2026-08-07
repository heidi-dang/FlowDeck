/**
 * Token Usage Store — durable, append-only accounting per run.
 *
 * Token accounting is tied to a stable run identity so it survives:
 *  - plugin/daemon process restarts,
 *  - UI reconnects,
 *  - child-session reconnects,
 *  - recovery recreating runtime objects.
 *
 * Storage format: one JSON line per record at
 *   `<persistDir>/<runId>.jsonl`
 *
 * Records are append-only. Reads rebuild authoritative counters and are
 * idempotent with respect to duplicated events (dedup keys).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"

/** Structured per-request telemetry record. Provider fields are normalised. */
export interface TokenUsageRecord {
  runId: string
  sessionId: string
  parentSessionId?: string
  assignmentId?: string
  agent: string
  model?: string
  provider?: string
  requestId: string
  reservationId?: string
  messageId?: string
  attempt: number
  /** Uncached input tokens. */
  input: number
  /** Output tokens (excluding reasoning). */
  output: number
  /** Reasoning tokens where exposed. */
  reasoning: number
  /** Cached input read tokens — kept distinct from uncached input. */
  cacheRead: number
  /** Cache write tokens. */
  cacheWrite: number
  /** Conservative billable total = input + output + reasoning + cacheRead + cacheWrite. */
  billable: number
  /** Estimated monetary cost where safely derivable. */
  estimatedCost?: number
  /** Active context size (tokens) at dispatch, when known. */
  contextSize?: number
  /** Message count at dispatch, when known. */
  messageCount?: number
  /** Tool-result size (chars) that entered context, when known. */
  toolResultSize?: number
  terminationReason?: string
  status: "reserved" | "committed" | "released" | "rejected" | "cancelled" | "disabled"
  recordedAt: string
}

export type UsageStoreEntry =
  | ({ kind: "reservation" } & Record<string, unknown>)
  | ({ kind: "usage" } & TokenUsageRecord)
  | ({ kind: "terminal" } & { reason: string; at: number })
  | ({ kind: "warning" } & { runId: string; at: number })

export interface RebuiltUsage {
  runId: string
  consumed: number
  reserved: number
  releasedUnused: number
  terminal: { reason: string; at: number } | null
  warningFired: boolean
  /** Most recent committed usage per dedup key (messageId ?? requestId ?? reservationId). */
  records: TokenUsageRecord[]
}

export interface TokenUsageStore {
  /** Append one record for the run. Resolves the full path for diagnostics. */
  append(runId: string, entry: UsageStoreEntry): string
  /** Read raw entries for the run. Missing file → empty array. */
  read(runId: string): UsageStoreEntry[]
  /** Rebuild authoritative usage state from durable entries. */
  rebuild(runId: string): RebuiltUsage
  /** Path of the log for a run. */
  pathFor(runId: string): string
}

export class FileTokenUsageStore implements TokenUsageStore {
  private readonly dir: string

  constructor(persistDir: string) {
    this.dir = persistDir
  }

  pathFor(runId: string): string {
    const safeRunId = runId.replace(/[^A-Za-z0-9._-]/g, "_")
    return join(this.dir, `${safeRunId}.jsonl`)
  }

  append(runId: string, entry: UsageStoreEntry): string {
    const p = this.pathFor(runId)
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true })
    }
    const line = JSON.stringify(entry) + "\n"
    try {
      appendFileSync(p, line, "utf-8")
    } catch {
      // Accounting must never crash the runtime. If persistence fails,
      // the in-memory counters remain authoritative for this process.
      return p
    }
    return p
  }

  read(runId: string): UsageStoreEntry[] {
    const p = this.pathFor(runId)
    if (!existsSync(p)) return []
    try {
      return readFileSync(p, "utf-8")
        .split("\n")
        .filter(l => l.trim().length > 0)
        .map(l => {
          try {
            return JSON.parse(l) as UsageStoreEntry
          } catch {
            return null
          }
        })
        .filter((e): e is UsageStoreEntry => e !== null)
    } catch {
      return []
    }
  }

  rebuild(runId: string): RebuiltUsage {
    const entries = this.read(runId)
    let consumed = 0
    let reserved = 0
    let releasedUnused = 0
    let warningFired = false
    let terminal: { reason: string; at: number } | null = null

    // Last committed usage per dedup key — later records win.
    const byKey = new Map<string, TokenUsageRecord>()
    // reservationId → claimed, so committed reservations can be released.
    const reservationClaims = new Map<string, number>()
    const committedReservations = new Set<string>()

    for (const e of entries) {
      if (e.kind === "reservation") {
        const claimed = Number(e.claimed ?? 0)
        if (Number.isFinite(claimed) && claimed > 0) {
          const status = String(e.status ?? "reserved")
          if (status === "reserved") reserved += claimed
          const rid = String(e.reservationId ?? "")
          if (rid) reservationClaims.set(rid, claimed)
        }
        continue
      }
      if (e.kind === "usage") {
        const key = String(e.messageId ?? e.requestId ?? e.reservationId ?? "")
        if (key) byKey.set(key, e)
        const rid = String(e.reservationId ?? "")
        if (rid) committedReservations.add(rid)
        continue
      }
      if (e.kind === "terminal") {
        terminal = { reason: String(e.reason ?? "unknown"), at: Number(e.at ?? 0) }
        continue
      }
      if (e.kind === "warning") {
        warningFired = true
      }
    }

    // Release reservations that were committed (their usage is already counted).
    for (const rid of committedReservations) {
      const claimed = reservationClaims.get(rid)
      if (claimed) reserved = Math.max(0, reserved - claimed)
    }

    // Consumed = sum of the winning (latest) record per dedup key only.
    consumed = [...byKey.values()].reduce((sum, rec) => sum + (Number.isFinite(Number(rec.billable)) ? Number(rec.billable) : 0), 0)

    return {
      runId,
      consumed,
      reserved,
      releasedUnused,
      terminal,
      warningFired,
      records: [...byKey.values()],
    }
  }
}

/** In-memory store for tests and configurations without a persist directory. */
export class InMemoryTokenUsageStore implements TokenUsageStore {
  private readonly data = new Map<string, UsageStoreEntry[]>()

  pathFor(runId: string): string {
    return `memory://${runId}`
  }

  append(runId: string, entry: UsageStoreEntry): string {
    const list = this.data.get(runId) ?? []
    list.push(entry)
    this.data.set(runId, list)
    return this.pathFor(runId)
  }

  read(runId: string): UsageStoreEntry[] {
    return this.data.get(runId) ?? []
  }

  rebuild(runId: string): RebuiltUsage {
    const entries = this.read(runId)
    let consumed = 0
    let reserved = 0
    let releasedUnused = 0
    let warningFired = false
    let terminal: { reason: string; at: number } | null = null
    const byKey = new Map<string, TokenUsageRecord>()
    const reservationClaims = new Map<string, number>()
    const committedReservations = new Set<string>()

    for (const e of entries) {
      if (e.kind === "reservation") {
        const claimed = Number(e.claimed ?? 0)
        if (Number.isFinite(claimed) && claimed > 0 && String(e.status ?? "reserved") === "reserved") {
          reserved += claimed
        }
        const rid = String(e.reservationId ?? "")
        if (rid) reservationClaims.set(rid, claimed)
        continue
      }
      if (e.kind === "usage") {
        const key = String(e.messageId ?? e.requestId ?? e.reservationId ?? "")
        if (key) byKey.set(key, e)
        const rid = String(e.reservationId ?? "")
        if (rid) committedReservations.add(rid)
        continue
      }
      if (e.kind === "terminal") {
        terminal = { reason: String(e.reason ?? "unknown"), at: Number(e.at ?? 0) }
        continue
      }
      if (e.kind === "warning") {
        warningFired = true
      }
    }

    for (const rid of committedReservations) {
      const claimed = reservationClaims.get(rid)
      if (claimed) reserved = Math.max(0, reserved - claimed)
    }

    consumed = [...byKey.values()].reduce((sum, rec) => sum + (Number.isFinite(Number(rec.billable)) ? Number(rec.billable) : 0), 0)

    return {
      runId,
      consumed,
      reserved,
      releasedUnused,
      terminal,
      warningFired,
      records: [...byKey.values()],
    }
  }
}

export function rebuildUsageEntries(entries: UsageStoreEntry[], runId: string): RebuiltUsage {
  // Shared implementation so both stores keep identical semantics.
  return new InMemoryTokenUsageStore().rebuild(runId)
}
