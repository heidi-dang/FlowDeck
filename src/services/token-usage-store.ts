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
 *   <persistDir>/<runId>.jsonl
 *
 * Records are append-only. Reads rebuild authoritative counters and are
 * idempotent with respect to duplicated events (dedup keys).
 *
 * Hot-path index (Fast Harness v1):
 *  - startup/recovery -> read durable JSONL ONCE and rebuild in-memory state
 *  - normal runtime -> update in-memory index incrementally, append durable event
 *  - hot queries (read/rebuild) never reread or reparse the full JSONL file
 *  - JSONL remains the restart/durability source; state is never memory-only
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
  /** Unused reservation returned to the run pool by this reconciliation. */
  releasedUnused?: number
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
  | ({ kind: "adaptive_reclaim" } & { eventId: string; reservationId: string; workstreamId: string; reserved: number; actual: number; reclaimed: number; reason: string; policyVersion?: string; at: number })
  | ({ kind: "adaptive_redistribution" } & { eventId: string; reservationId: string; sourceReservationId?: string; targetWorkstreamId: string; amount: number; reason: string; policyVersion?: string; at: number })
  | ({ kind: "workstream_termination" } & { eventId: string; workstreamId: string; reason: string; at: number })

export interface RebuiltUsage {
  runId: string
  consumed: number
  reserved: number
  releasedUnused: number
  terminal: { reason: string; at: number } | null
  warningFired: boolean
  /** Most recent committed usage per dedup key (messageId ?? requestId ?? reservationId). */
  records: TokenUsageRecord[]
  /** Reservations that were durable and still active at the last append. */
  reservations: Array<{
    reservationId: string
    runId: string
    sessionId: string
    agentId: string
    parentSessionId?: string
    assignmentId?: string
    requestId: string
    attempt: number
    estimatedInput: number
    maxOutput: number
    claimed: number
  }>
  /** Cumulative reclaimed tokens from adaptive_reclaim events. */
  reclaimed?: number
  /** Cumulative redistributed tokens from adaptive_redistribution events. */
  redistributed?: number
  /** Reservation IDs whose usage was committed (released from active reservations). */
  committedIds?: string[]
}

export interface TokenUsageStore {
  /** Append one record for the run. Resolves the full path for diagnostics. */
  append(runId: string, entry: UsageStoreEntry): string
  /** Read raw entries for the run. Missing file -> empty array. Hot-path safe (indexed). */
  read(runId: string): UsageStoreEntry[]
  /** Rebuild authoritative usage state from durable entries. Hot-path safe (indexed). */
  rebuild(runId: string): RebuiltUsage
  /** Path of the log for a run. */
  pathFor(runId: string): string
}

/** Per-run in-memory hot index maintained incrementally. */
interface RunHotIndex {
  entries: UsageStoreEntry[]
  rebuilt: RebuiltUsage | null
  reclaimed: number
  redistributed: number
  committedIds: Set<string>
  dedupeKeys: Set<string>
  loaded: boolean
}

function makeRunIndex(): RunHotIndex {
  return {
    entries: [],
    rebuilt: null,
    reclaimed: 0,
    redistributed: 0,
    committedIds: new Set<string>(),
    dedupeKeys: new Set<string>(),
    loaded: false,
  }
}

export class FileTokenUsageStore implements TokenUsageStore {
  private readonly dir: string
  private readonly index = new Map<string, RunHotIndex>()

  constructor(persistDir: string) {
    this.dir = persistDir
  }

  pathFor(runId: string): string {
    const safeRunId = runId.replace(/[^A-Za-z0-9._-]/g, "_")
    return join(this.dir, `${safeRunId}.jsonl`)
  }

  /** Read the durable JSONL once (startup/recovery) and populate the in-memory index. */
  private ensureLoaded(runId: string): RunHotIndex {
    let idx = this.index.get(runId)
    if (!idx) {
      idx = makeRunIndex()
      this.index.set(runId, idx)
    }
    if (idx.loaded) return idx
    const p = this.pathFor(runId)
    try {
      if (existsSync(p)) {
        const parsed = readFileSync(p, "utf-8")
          .split("\n")
          .filter(l => l.trim().length > 0)
          .map(l => {
            try { return JSON.parse(l) as UsageStoreEntry } catch { return null }
          })
          .filter((e): e is UsageStoreEntry => e !== null)
        idx.entries = parsed
        for (const e of parsed) this.applyIncremental(idx, e)
      }
    } catch {
      // Durable-recovery failure: continue empty; accounting cannot crash the runtime.
    }
    idx.loaded = true
    return idx
  }

  /** Incrementally fold one entry into the hot index (no disk read). */
  private applyIncremental(idx: RunHotIndex, entry: UsageStoreEntry): void {
    if (entry.kind === "usage") {
      const key = String(entry.messageId ?? entry.requestId ?? entry.reservationId ?? "")
      if (key) idx.dedupeKeys.add(key)
      const rid = String(entry.reservationId ?? "")
      if (rid) idx.committedIds.add(rid)
    } else if (entry.kind === "adaptive_reclaim") {
      const amount = Number((entry as { reclaimed?: unknown }).reclaimed ?? 0)
      if (Number.isFinite(amount)) idx.reclaimed += amount
    } else if (entry.kind === "adaptive_redistribution") {
      const amount = Number((entry as { amount?: unknown }).amount ?? 0)
      if (Number.isFinite(amount)) idx.redistributed += amount
    }
    // Any new durable event invalidates the cached rebuild summary.
    idx.rebuilt = null
  }

  append(runId: string, entry: UsageStoreEntry): string {
    const p = this.pathFor(runId)
    const idx = this.ensureLoaded(runId)
    // In-memory index is authoritative for this process; update first.
    idx.entries.push(entry)
    this.applyIncremental(idx, entry)
    if (!existsSync(this.dir)) {
      try { mkdirSync(this.dir, { recursive: true }) } catch { /* durability best-effort */ }
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
    const idx = this.ensureLoaded(runId)
    // Return a shallow copy so callers cannot mutate the hot index.
    return idx.entries.slice()
  }

  rebuild(runId: string): RebuiltUsage {
    const idx = this.ensureLoaded(runId)
    if (!idx.rebuilt) {
      // rebuildFromEntries already folds reclaim/redistribution/committed
      // from the durable entries; idx counters are observational only.
      idx.rebuilt = rebuildFromEntries(idx.entries, runId)
    }
    return idx.rebuilt
  }

  /** Number of runs currently held in the hot index (test/observability aid). */
  get indexedRunCount(): number {
    return this.index.size
  }

  /** Drop the hot index (test aid; next query reloads from JSONL). */
  clearIndex(): void {
    this.index.clear()
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
    return rebuildFromEntries(this.read(runId), runId)
  }
}

/**
 * Rebuild authoritative usage state from a set of durable entries.
 *
 * Shared implementation so both stores (and the standalone helper) keep
 * identical semantics:
 *  - Last committed usage per dedup key wins (later records override).
 *  - Reservations that were later committed are released (their usage is
 *    already counted in `consumed`).
 *  - `consumed` sums only the winning record per dedup key — never double
 *    counts duplicated events.
 */
export function rebuildFromEntries(entries: UsageStoreEntry[], runId: string): RebuiltUsage {
  let consumed = 0
  let reserved = 0
  let releasedUnused = 0
  let reclaimed = 0
  let redistributed = 0
  let warningFired = false
  let terminal: { reason: string; at: number } | null = null

  // Last committed usage per dedup key — later records win.
  const byKey = new Map<string, TokenUsageRecord>()
  // reservationId -> claimed and its LATEST durable status.
  const reservationClaims = new Map<string, number>()
  const reservationStatus = new Map<string, string>()
  const reservationEntries = new Map<string, RebuiltUsage["reservations"][number]>()
  const committedReservations = new Set<string>()

  for (const e of entries) {
    if (e.kind === "reservation") {
      const claimed = Number(e.claimed ?? 0)
      if (Number.isFinite(claimed) && claimed > 0) {
        const status = String(e.status ?? "reserved")
        const rid = String(e.reservationId ?? "")
        if (rid) {
          reservationClaims.set(rid, claimed)
          reservationStatus.set(rid, status)
          reservationEntries.set(rid, {
            reservationId: rid,
            runId,
            sessionId: String(e.sessionId ?? ""),
            agentId: String(e.agentId ?? e.agent ?? ""),
            ...(e.parentSessionId ? { parentSessionId: String(e.parentSessionId) } : {}),
            ...(e.assignmentId ? { assignmentId: String(e.assignmentId) } : {}),
            requestId: String(e.requestId ?? ""),
            attempt: Number(e.attempt ?? 1),
            estimatedInput: Number(e.estimatedInput ?? 0),
            maxOutput: Number(e.maxOutput ?? 0),
            claimed,
          })
        }
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
      continue
    }
    if (e.kind === "adaptive_reclaim") {
      const amount = Number((e as { reclaimed?: unknown }).reclaimed ?? 0)
      if (Number.isFinite(amount)) reclaimed += amount
      continue
    }
    if (e.kind === "adaptive_redistribution") {
      const amount = Number((e as { amount?: unknown }).amount ?? 0)
      if (Number.isFinite(amount)) redistributed += amount
      continue
    }
  }

  // Reserved = claimed of reservations whose latest durable status is still
  // reserved, minus those later committed (their usage is already counted in
  // consumed and their reservation was released at commit time).
  for (const [rid, status] of reservationStatus) {
    if (status === "reserved") reserved += reservationClaims.get(rid) ?? 0
  }
  for (const rid of committedReservations) {
    if (reservationStatus.get(rid) === "reserved") {
      const claimed = reservationClaims.get(rid)
      if (claimed) reserved = Math.max(0, reserved - claimed)
    }
  }

  // Consumed = sum of the winning (latest) record per dedup key only.
  consumed = [...byKey.values()].reduce((sum, rec) => sum + (Number.isFinite(Number(rec.billable)) ? Number(rec.billable) : 0), 0)
  releasedUnused = [...byKey.values()].reduce((sum, rec) => sum + (Number.isFinite(Number(rec.releasedUnused)) ? Number(rec.releasedUnused) : 0), 0)

  return {
    runId,
    consumed,
    reserved,
    releasedUnused,
    terminal,
    warningFired,
    records: [...byKey.values()],
    reservations: [...reservationEntries.entries()].filter(([rid]) => reservationStatus.get(rid) === "reserved").map(([, value]) => value),
    reclaimed,
    redistributed,
    committedIds: [...committedReservations],
  }
}

export function rebuildUsageEntries(entries: UsageStoreEntry[], runId: string): RebuiltUsage {
  return rebuildFromEntries(entries, runId)
}
