/**
 * Child Lifecycle Port — generic lifecycle adapter (Roadmap item 6).
 *
 * The coordinator must not care whether children execute via current OpenCode
 * task sessions or the DSH executor later. This port abstracts child listing +
 * inspection, and the current adapter is built over HeidiDelegationRuntime +
 * the existing task lifecycle. When DSH executes a child, DSH remains the
 * lifecycle owner and FlowDeck only consumes DSH lifecycle events.
 */

import { HeidiDelegationRuntime } from "./heidi-delegation-runtime"

export type ChildLifecycleState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "unknown"

export interface ChildSnapshot {
  childId: string
  parentSessionId: string
  specialist: string
  goal?: string
  state: ChildLifecycleState
  phase?: string
  currentTool?: string
  toolCalls?: number
  summary?: string
  error?: string
  cancelRequested?: boolean
  createdAt: number
  startedAt?: number
  finishedAt?: number
  lastActivityAt: number
}

export type ChildLifecycleEventKind =
  | "child.started"
  | "child.progress"
  | "child.contract_ready"
  | "child.completed"
  | "child.failed"
  | "child.cancelled"

export interface ChildLifecycleEvent {
  childId: string
  kind: ChildLifecycleEventKind
  snapshot: ChildSnapshot
  at: number
}

export interface ChildLifecyclePort {
  list(parentSessionId: string): Promise<ChildSnapshot[]>
  inspect(childId: string): Promise<ChildSnapshot | null>
}

export const TERMINAL_CHILD_STATES: ReadonlySet<ChildLifecycleState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
])

export function isTerminalChildState(state: string): boolean {
  return TERMINAL_CHILD_STATES.has(state as ChildLifecycleState)
}

/** Map a heidi_delegation_activity row (snake_case) to a ChildSnapshot. */
export function snapshotFromActivityRow(row: any): ChildSnapshot {
  return {
    childId: String(row?.child_id ?? ""),
    parentSessionId: String(row?.parent_session_id ?? ""),
    specialist: String(row?.specialist ?? ""),
    goal: row?.goal ? String(row.goal) : undefined,
    state: (row?.state ?? "unknown") as ChildLifecycleState,
    phase: row?.phase ? String(row.phase) : undefined,
    currentTool: row?.current_tool ? String(row.current_tool) : undefined,
    toolCalls: typeof row?.tool_calls === "number" ? row.tool_calls : undefined,
    summary: row?.summary ? String(row.summary) : undefined,
    error: row?.error ? String(row.error) : undefined,
    cancelRequested: Boolean(row?.cancel_requested),
    createdAt: typeof row?.created_at === "number" ? row.created_at : Date.parse(String(row?.created_at ?? 0)) || 0,
    startedAt: row?.started_at ? (typeof row.started_at === "number" ? row.started_at : Date.parse(String(row.started_at)) || undefined) : undefined,
    finishedAt: row?.finished_at ? (typeof row.finished_at === "number" ? row.finished_at : Date.parse(String(row.finished_at)) || undefined) : undefined,
    lastActivityAt: row?.last_activity_at ? (typeof row.last_activity_at === "number" ? row.last_activity_at : Date.parse(String(row.last_activity_at)) || 0) : 0,
  }
}

/**
 * Current adapter over HeidiDelegationRuntime (SQLite child activity). This is a
 * pure lifecycle READER — it never starts a provider process or spawns children.
 */
export class HeidiDelegationRuntimePort implements ChildLifecyclePort {
  constructor(private readonly runtime: HeidiDelegationRuntime) {}

  async list(parentSessionId: string): Promise<ChildSnapshot[]> {
    const rows = this.runtime.list(parentSessionId) as any[]
    return rows.map(snapshotFromActivityRow)
  }

  async inspect(childId: string): Promise<ChildSnapshot | null> {
    const row = this.runtime.inspect(childId) as any
    return row ? snapshotFromActivityRow(row) : null
  }
}

/** A no-op / pass-through port used when no runtime is wired (tests, DSH later). */
export class StaticChildLifecyclePort implements ChildLifecyclePort {
  private snapshots = new Map<string, ChildSnapshot>()

  constructor(private readonly parentSessionId: string) {}

  upsert(snapshot: ChildSnapshot): void {
    this.snapshots.set(snapshot.childId, snapshot)
  }

  async list(parentSessionId: string): Promise<ChildSnapshot[]> {
    if (parentSessionId !== this.parentSessionId) return []
    return Array.from(this.snapshots.values()).sort((a, b) => a.childId.localeCompare(b.childId))
  }

  async inspect(childId: string): Promise<ChildSnapshot | null> {
    return this.snapshots.get(childId) ?? null
  }
}

