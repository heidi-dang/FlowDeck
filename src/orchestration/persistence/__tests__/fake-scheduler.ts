/** Fake scheduler for retry policy tests — zero real waiting. */
export interface Scheduler { delay(ms: number): Promise<void> }
export class FakeScheduler implements Scheduler {
  private _totalDelayed = 0
  get totalDelayed() { return this._totalDelayed }
  async delay(ms: number): Promise<void> { this._totalDelayed += ms }
  reset() { this._totalDelayed = 0 }
}

export class RealScheduler implements Scheduler {
  async delay(ms: number): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { /* spin */ }
  }
}
