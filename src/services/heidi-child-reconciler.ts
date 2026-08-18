/**
 * Heidi Child Reconciler — pure child-lifecycle reconciler.
 *
 * Event-driven updates (low latency) + adaptive periodic reconciliation
 * (recovery for dropped/incomplete events). The reconciler NEVER starts a
 * provider process, NEVER spawns children, and NEVER invokes an LLM. It is a
 * RUNTIME SCHEDULER concern, not a prompt concern: reconciliation can never
 * become a model turn, so pollModelTurns is always 0.
 *
 * State model: tracked = Map<childId, ChildSnapshot>, the authoritative view.
 *  - handleEvent applies a lifecycle event immediately (low latency).
 *  - pollOnce lists via the port and recovers children that were missed by
 *    events; it drops nothing and only reports actual changes.
 */

import type { ChildLifecyclePort, ChildSnapshot, ChildLifecycleState } from "./child-lifecycle-port"

export interface ReconcilerOptions {
  /** Interval when the reconciler/children are fresh. Default 5000ms. */
  initialReconcileMs?: number
  /** Steady-state interval with no recent transitions. Default 20000ms. */
  healthyReconcileMs?: number
  /** Interval once a child has been running > 60s. Default 30000ms. */
  longRunningMs?: number
  /** Extra polling bump right after a child transition. Default 5000ms. */
  transitionBumpMs?: number
}

export interface ReconcilerStats {
  /** Always 0 — reconciliation is a runtime scheduler concern, not a prompt. */
  pollModelTurns: number
  /** Number of pollOnce() calls performed. */
  reconciliationPolls: number
  /** Number of lifecycle events delivered via handleEvent. */
  childStatusEvents: number
  /** Children first learned about through an event (recovered via events). */
  recoveredFromEvents: number
  /** The value returned by the most recent adaptiveIntervalMs() call. */
  lastAdaptiveIntervalMs: number
}

export interface ReconcilerReport {
  snapshotCount: number
  /** childIds whose tracked state actually changed on this poll. */
  changed: string[]
  /** childIds seen for the first time via this poll. */
  newlySeen: string[]
  /** childIds recovered from a dropped event (seen first via poll). */
  recovered: string[]
  /** Always 0. */
  pollModelTurns: number
}

export interface ReconcilerDelta {
  childId: string
  status: ChildLifecycleState
  phase?: string
  currentTool?: string
  summary?: string
  updatedAt: number
}

const LONG_RUNNING_THRESHOLD_MS = 60_000

export class HeidiChildReconciler {
  private readonly initialReconcileMs: number
  private readonly healthyReconcileMs: number
  private readonly longRunningMs: number
  private readonly transitionBumpMs: number

  /** Authoritative snapshot per childId. */
  private readonly tracked = new Map<string, ChildSnapshot>()
  /** Timestamp of the most recent child transition (event or poll change). */
  private lastTransitionAt: number

  private reconciliationPolls = 0
  private childStatusEvents = 0
  private recoveredFromEvents = 0
  private lastAdaptiveIntervalMs: number

  constructor(
    private readonly port: ChildLifecyclePort,
    private readonly parentSessionId: string,
    options: ReconcilerOptions = {},
  ) {
    this.initialReconcileMs = options.initialReconcileMs ?? 5000
    this.healthyReconcileMs = options.healthyReconcileMs ?? 20000
    this.longRunningMs = options.longRunningMs ?? 30000
    this.transitionBumpMs = options.transitionBumpMs ?? 5000
    this.lastTransitionAt = Date.now()
    this.lastAdaptiveIntervalMs = this.initialReconcileMs
  }

  /**
   * Event-driven path: apply a lifecycle update immediately. Only child
   * lifecycle snapshots flow through here — watchdog/Continue prompts are not
   * events and never reach this method. Never a model turn.
   */
  handleEvent(event: { childId: string; kind: string; snapshot: ChildSnapshot }): void {
    this.childStatusEvents++
    if (!this.tracked.has(event.childId)) {
      this.recoveredFromEvents++
    }
    this.tracked.set(event.childId, event.snapshot)
    this.lastTransitionAt = Date.now()
  }

  /**
   * Periodic path: list via the port and reconcile. Drops nothing; only reports
   * genuine changes. A child with the same state as previously tracked is not a
   * change (no repeated delta). Recovery happens exactly once per dropped event
   * because a second poll sees the same state.
   */
  async pollOnce(): Promise<ReconcilerReport> {
    this.reconciliationPolls++
    const listed = await this.port.list(this.parentSessionId)

    const changed: string[] = []
    const newlySeen: string[] = []
    const recovered: string[] = []

    for (const snap of listed) {
      const prev = this.tracked.get(snap.childId)
      if (!prev) {
        // First time seen — a dropped event is recovered here.
        this.tracked.set(snap.childId, snap)
        recovered.push(snap.childId)
        newlySeen.push(snap.childId)
        changed.push(snap.childId)
        this.lastTransitionAt = Date.now()
      } else if (!sameLifecycleState(prev, snap)) {
        // Same child, real lifecycle change.
        this.tracked.set(snap.childId, snap)
        changed.push(snap.childId)
        this.lastTransitionAt = Date.now()
      }
      // Same state as tracked -> no change, no repeated delta.
    }

    return {
      snapshotCount: listed.length,
      changed,
      newlySeen,
      recovered,
      pollModelTurns: 0,
    }
  }

  getSnapshot(childId: string): ChildSnapshot | undefined {
    return this.tracked.get(childId)
  }

  getDeltas(): Map<string, ReconcilerDelta> {
    const deltas = new Map<string, ReconcilerDelta>()
    for (const snap of this.tracked.values()) {
      deltas.set(snap.childId, {
        childId: snap.childId,
        status: snap.state,
        phase: snap.phase,
        currentTool: snap.currentTool,
        summary: snap.summary,
        updatedAt: snap.lastActivityAt,
      })
    }
    return deltas
  }

  /**
   * Adaptive reconciliation interval, in ms.
   *  - fresh child (created recently) or a recent transition -> bump (5000)
   *  - a child running > 60s                -> long-running (30000)
   *  - otherwise (steady state)            -> healthy (20000)
   */
  adaptiveIntervalMs(): number {
    const now = Date.now()

    let hasFreshChild = false
    let hasRecentTransition = now - this.lastTransitionAt < this.transitionBumpMs
    let hasLongRunningChild = false

    for (const snap of this.tracked.values()) {
      if (now - snap.createdAt < this.transitionBumpMs) hasFreshChild = true
      if (snap.state === "running" && snap.startedAt !== undefined && now - snap.startedAt > LONG_RUNNING_THRESHOLD_MS) {
        hasLongRunningChild = true
      }
    }

    let interval: number
    if (hasLongRunningChild) {
      interval = this.longRunningMs
    } else if (hasFreshChild || hasRecentTransition || this.tracked.size === 0) {
      interval = this.initialReconcileMs
    } else {
      interval = this.healthyReconcileMs
    }

    this.lastAdaptiveIntervalMs = interval
    return interval
  }

  /** Reconciliation never becomes a model turn. Always 0. */
  pollModelTurns(): number {
    return 0
  }

  stats(): ReconcilerStats {
    return {
      pollModelTurns: 0,
      reconciliationPolls: this.reconciliationPolls,
      childStatusEvents: this.childStatusEvents,
      recoveredFromEvents: this.recoveredFromEvents,
      lastAdaptiveIntervalMs: this.lastAdaptiveIntervalMs,
    }
  }
}

/** Compare the observable lifecycle fields; used to detect genuine changes. */
function sameLifecycleState(a: ChildSnapshot, b: ChildSnapshot): boolean {
  return a.state === b.state && a.phase === b.phase && a.currentTool === b.currentTool && a.summary === b.summary
}
