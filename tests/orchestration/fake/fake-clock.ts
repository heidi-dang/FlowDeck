export class FakeClock {
  private currentTime: number;
  constructor(initialTime: number = 0) { this.currentTime = initialTime; }
  now(): number { return this.currentTime; }
  advance(ms: number): void { this.currentTime += ms; }
  setDate(date: Date): void { this.currentTime = date.getTime(); }
}
