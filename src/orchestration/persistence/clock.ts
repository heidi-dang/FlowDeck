/** Injectable monotonic clock and scheduler for retry policy. No CPU spin. */
export interface Clock {
  now(): number
  monotonic(): number
}

export interface Scheduler {
  /** Asynchronously wait for the given duration. Only called between transactions, never inside one. */
  delay(ms: number): Promise<void>
}

export class SystemClock implements Clock {
  now(): number { return Date.now() }
  monotonic(): number { return performance.now() }
}

export class SystemScheduler implements Scheduler {
  async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

export class FakeClock implements Clock {
  private _now = 0; private _mono = 0
  advance(ms: number) { this._now += ms; this._mono += ms }
  now(): number { return this._now }
  monotonic(): number { return this._mono }
  reset() { this._now = 0; this._mono = 0 }
}

export class FakeScheduler implements Scheduler {
  private _totalDelayed = 0; private _delays: number[] = []
  get totalDelayed() { return this._totalDelayed }
  get delays() { return [...this._delays] }
  async delay(ms: number): Promise<void> { this._totalDelayed += ms; this._delays.push(ms) }
  reset() { this._totalDelayed = 0; this._delays = [] }
}
