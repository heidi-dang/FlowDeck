/**
 * Real-Time Instrumentation (Requirement: synthetic latency must not be passed
 * off as measurements).
 *
 * All timing in this module derives from `performance.now()` deltas — a real
 * high-resolution monotonic clock. There are NO hardcoded millisecond
 * constants here. The runtime feeds real measured phases into
 * `buildLatencyBreakdown`. `CallTimer` measures the phases of a single tool
 * call; `RuntimeStopwatch` accumulates named checkpoints over a longer flow;
 * `callTimers` is the per-(session, call, tool) registry the after-tool block
 * reads latencies from.
 */

export interface MeasuredPhase {
  name: string
  ms: number
}

export const TIMING_BASED_ON = "performance.now"

/**
 * Round a raw duration to two decimals for a clean, lossless-display value.
 * This is formatting only — the timing still originates from
 * `performance.now()`.
 */
function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100
}

/**
 * Measure the phases of a single tool call. `start(name)` begins timing a
 * phase (ending any previously-open phase); `end()` closes the last phase.
 */
export class CallTimer {
  private _phases: MeasuredPhase[] = []
  private _currentName = "default"
  private _started: number | null = null

  start(name?: string): number {
    const now = performance.now()
    if (this._started !== null) {
      this._phases.push({ name: this._currentName, ms: now - this._started })
    }
    this._currentName = name ?? "default"
    this._started = now
    return now
  }

  end(): void {
    if (this._started !== null) {
      const now = performance.now()
      this._phases.push({ name: this._currentName, ms: now - this._started })
      this._started = null
    }
  }

  phases(): MeasuredPhase[] {
    return this._phases.map((p) => ({ name: p.name, ms: roundMs(p.ms) }))
  }

  totalMs(): number {
    return roundMs(this._phases.reduce((a, p) => a + p.ms, 0))
  }
}

/**
 * A monotonic stopwatch over a longer flow. `mark(name)` records a checkpoint;
 * `snapshot()` reports each checkpoint's elapsed time from flow start;
 * `totalMs()` is the elapsed time from the first to the last checkpoint.
 */
export class RuntimeStopwatch {
  private points: Array<{ name: string; at: number }> = []

  mark(name: string): void {
    this.points.push({ name, at: performance.now() })
  }

  snapshot(): MeasuredPhase[] {
    if (this.points.length === 0) return []
    const base = this.points[0].at
    return this.points.map((p) => ({ name: p.name, ms: roundMs(p.at - base) }))
  }

  totalMs(): number {
    if (this.points.length < 2) return 0
    const first = this.points[0].at
    const last = this.points[this.points.length - 1].at
    return roundMs(last - first)
  }
}

/** Registry of per-call timers keyed by `sessionID|callID|toolName`. */
export const callTimers: Map<string, CallTimer> = new Map()

export function getCallTimer(sessionID: string, callID: string, toolName: string): CallTimer {
  const key = sessionID + "|" + callID + "|" + toolName
  let timer = callTimers.get(key)
  if (!timer) {
    timer = new CallTimer()
    callTimers.set(key, timer)
  }
  return timer
}

export function releaseCallTimer(sessionID: string, callID: string, toolName: string): void {
  callTimers.delete(sessionID + "|" + callID + "|" + toolName)
}

/**
 * Compatible latency-breakdown helper. Integration feeds real measured phases
 * (e.g. from `CallTimer.phases()`); kept API-compatible with the
 * `runtime-self-audit` builder so the runtime can route either source into the
 * audit ledger.
 */
export function buildLatencyBreakdown(phases: Array<[string, number]>): MeasuredPhase[] {
  return phases.map(([name, ms]) => ({ name, ms: roundMs(ms) }))
}
